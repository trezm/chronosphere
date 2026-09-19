#!/usr/bin/env python3
"""Build a Chronosphere v1 reconstruction using only the Python standard library."""

import argparse
import datetime
import hashlib
import json
import re
import subprocess
import sys
import uuid

FILE_LIMIT = 256 * 1024
REPLAY_LIMIT = 20 * 1024 * 1024
INPUT_LIMIT = 64 * 1024 * 1024
NOTICE = "Reconstructed from PR endpoint snapshots; step order is inferred, not observed. Timestamps mark generation, not development. No commands or tests were run by this reconstruction."


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text(value, label, maximum=8000):
    require(isinstance(value, str) and value.strip(), f"{label} must be nonempty text")
    require(len(value.encode("utf-16-le")) // 2 <= maximum, f"{label} is too long")
    return value


def path(value):
    text(value, "Path", 4096)
    require(not value.startswith("/") and "\\" not in value
            and not any(p in ("", ".", "..") for p in value.split("/"))
            and not any(ord(c) < 32 for c in value), f"Unsupported path: {value!r}")
    return value


def excluded(name):
    return any(p in (".git", ".chronosphere") for p in name.split("/")) or bool(re.search(
        r"(^|/)(\.env(?:\..*)?|\.npmrc|\.netrc|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519))$|\.(pem|key|p12|pfx)$",
        name, re.I))


def sha(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", value), "Expected a full commit SHA")
    return value.lower()


def snapshot(content):
    if content is None:
        return None
    require(isinstance(content, str), "File contents must be text or null")
    data = content.encode("utf-8")
    require(len(data) <= FILE_LIMIT and b"\0" not in data, "File must be UTF-8 text of at most 256 KiB without NUL bytes")
    return {"content": content, "sha256": hashlib.sha256(data).hexdigest()}


def load(filename):
    with open(filename, "rb") as handle:
        data = handle.read(INPUT_LIMIT + 1)
    require(len(data) <= INPUT_LIMIT, "Input exceeds 64 MiB")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, f"Duplicate JSON key: {key}")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def write_new(filename, data):
    # Never overwrite source data, another replay, or a symlink target.
    with open(filename, "xb") as handle:
        handle.write(data)


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def prepare(args):
    target, head = sha(args.base), sha(args.head)
    bases = git(args.repo, "merge-base", "--all", target, head).decode().splitlines()
    require(len(bases) == 1, "Need one unambiguous merge base; obtain the host's comparison base for this PR")
    base = sha(bases[0])
    entries = git(args.repo, "diff", "--raw", "-z", "--no-abbrev", "--no-renames",
                  "--no-ext-diff", base, head, "--").split(b"\0")
    files, omitted = {}, []
    total = 0
    for index in range(0, len(entries) - 1, 2):
        old_mode, new_mode, old_oid, new_oid, _status = entries[index].decode("ascii").split()
        old_mode = old_mode.lstrip(":")
        name = path(entries[index + 1].decode("utf-8"))
        reason = "Excluded artifact or credential filename" if excluded(name) else None
        values = []
        for mode, oid in ((old_mode, old_oid), (new_mode, new_oid)):
            if reason:
                break
            if mode == "000000":
                values.append(None)
                continue
            if mode not in ("100644", "100755"):
                reason = "Symlink, submodule, or unsupported file mode"
                break
            if int(git(args.repo, "cat-file", "-s", oid)) > FILE_LIMIT:
                reason = "File exceeds 256 KiB"
                break
            raw = git(args.repo, "cat-file", "blob", oid)
            try:
                content = raw.decode("utf-8")
            except UnicodeDecodeError:
                reason = "Not UTF-8 text"
                break
            if b"\0" in raw:
                reason = "Binary file"
                break
            values.append(content)
        if reason:
            omitted.append({"path": name, "reason": reason})
            continue
        if old_mode != new_mode and "000000" not in (old_mode, new_mode):
            omitted.append({"path": name, "reason": f"File mode change {old_mode} -> {new_mode} is not represented; text changes are included when present"})
        if values[0] != values[1]:
            files[name] = {"before": values[0], "after": values[1]}
            total += sum(len(v.encode("utf-8")) for v in values if v is not None)
            require(total <= 8 * 1024 * 1024, "Endpoint snapshots exceed 8 MiB; narrow the scope explicitly and disclose the gap")
    source = {"title": text(args.title, "Title"), "repository": {"name": text(args.name, "Repository name"), "head": head, "branch": None},
              "base": base, "targetBase": target, "pullRequest": args.pr_url, "files": files, "omitted": omitted}
    write_new(args.out, (dump(source) + "\n").encode("utf-8"))
    print(f"Prepared {len(files)} changed text files; {len(omitted)} omissions. Comparison base: {base}; head: {head}")


def build(args):
    source, plan = load(args.source), load(args.plan)
    require(isinstance(source, dict) and isinstance(plan, dict), "Source and plan must be objects")
    repo = source["repository"]
    text(repo["name"], "Repository name")
    if repo["branch"] is not None:
        text(repo["branch"], "Branch")
    base, head = sha(source["base"]), sha(repo["head"])
    if source.get("targetBase") is not None:
        sha(source["targetBase"])
    if source.get("pullRequest") is not None:
        text(source["pullRequest"], "PR URL")
    files, omitted = source["files"], source["omitted"]
    require(isinstance(files, dict) and files, "No changed text files to replay")
    require(isinstance(omitted, list) and len(omitted) <= 10000, "Invalid omissions list")
    for item in omitted:
        path(item["path"])
        text(item["reason"], "Omission reason")
    initial, target = {}, {}
    total = 0
    for name, pair in files.items():
        path(name)
        require(not excluded(name), f"Excluded artifact or credential filename: {name}")
        before, after = snapshot(pair["before"]), snapshot(pair["after"])
        require(before != after, f"Source file has no text changes: {name}")
        for value in (before, after):
            if value is not None:
                total += len(value["content"].encode("utf-8"))
        if before is not None:
            initial[name] = before
        if after is not None:
            target[name] = after
    require(total <= 8 * 1024 * 1024, "Endpoint snapshots exceed 8 MiB")
    steps = plan["steps"]
    require(isinstance(steps, list) and 1 <= len(steps) <= 1999, "Need 1–1999 steps plus finish")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    header = {"type": "session", "format": "chronosphere.recording", "version": 1,
              "id": str(uuid.uuid4()), "createdAt": now, "title": text("Reconstructed: " + source["title"], "Title"),
              "capture": "checkpoints", "repository": {**repo, "head": base}, "scope": sorted(files),
              "baseline": initial, "omitted": omitted,
              "reconstruction": {"base": base, "head": head, "targetBase": source.get("targetBase"),
                                 "pullRequest": source.get("pullRequest"), "notice": NOTICE}}
    records, state = [header], dict(initial)
    for sequence, step in enumerate(steps, 1):
        require(isinstance(step, dict) and set(step) <= {"title", "reason", "files", "snapshots"}, "Unknown step fields")
        names, intermediates = step.get("files", []), step.get("snapshots", {})
        require(isinstance(names, list) and all(isinstance(n, str) for n in names) and isinstance(intermediates, dict), "Invalid files or snapshots")
        require(len(set(names)) == len(names) and not set(names).intersection(intermediates), "Duplicate file in step")
        require(all(n in files for n in [*names, *intermediates]), "Step references a file absent from source")
        updates = {name: target.get(name) for name in names}
        updates.update({name: snapshot(content) for name, content in intermediates.items()})
        require(updates, "Empty reconstruction step")
        changes = []
        for name, after in updates.items():
            before = state.get(name)
            require(before != after, f"No-op change in step {sequence}: {name}")
            changes.append({"path": name, "before": before, "after": after})
            if after is None:
                state.pop(name, None)
            else:
                state[name] = after
        reason = text(step["reason"], "Reason")
        if sequence == 1:
            reason = text(NOTICE + " " + reason, "Reason")
        records.append({"type": "change", "id": str(uuid.uuid4()), "sequence": sequence,
                        "recordedAt": now, "title": text(step["title"], "Step title"), "reason": reason,
                        "changes": changes, "omitted": []})
    mismatches = sorted(n for n in set(state) | set(target) if state.get(n) != target.get(n))
    require(not mismatches, "Plan does not reach pinned head for: " + ", ".join(mismatches))
    records.append({"type": "finish", "id": str(uuid.uuid4()), "sequence": len(steps) + 1,
                    "recordedAt": now, "title": "Reconstruction complete",
                    "reason": f"All {len(files)} included file endpoints match pinned head {head}. {len(omitted)} omissions are listed in the session. This is an inferred sequence, not observed development or test evidence.",
                    "changes": [], "omitted": []})
    data = ("\n".join(dump(record) for record in records) + "\n").encode("utf-8")
    require(len(data) <= REPLAY_LIMIT, "Replay exceeds 20 MiB; reduce intermediate snapshots without dropping changes")
    write_new(args.out, data)
    print(f"Built {args.out}: {len(steps)} reconstructed steps, {len(data)} bytes, {len(omitted)} omissions; included endpoints verified against {head}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare", help="Read pinned Git snapshots without changing the checkout")
    for option in ("repo", "base", "head", "name", "title", "out"):
        prepare_parser.add_argument("--" + option, required=True)
    prepare_parser.add_argument("--pr-url")
    prepare_parser.set_defaults(run=prepare)
    build_parser = commands.add_parser("build", help="Assemble and check an inferred replay")
    for option in ("source", "plan", "out"):
        build_parser.add_argument("--" + option, required=True)
    build_parser.set_defaults(run=build)
    args = parser.parse_args()
    try:
        args.run(args)
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Error: {error}\n")


if __name__ == "__main__":
    main()
