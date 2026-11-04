# Reconstruct changes for review

A plan groups every changed line into steps so the reviewer can watch the work land one coherent piece at a time. A plan does not record history. It explains the final changes in the order that is easiest to understand. Where you wrote the code yourself, you may use what you know about why each part exists, but do not present the order as the order you actually worked in.

## Number the lines

```sh
node --experimental-strip-types <review>/scripts/review.mjs --list-lines --repo <working-copy> [--base <ref>] > <temporary-directory>/lines.txt
```

Use the same `--repo` and `--base` you will pass when starting the review. The first two lines give the number of changed lines and the `base` and `snapshot` values your plan must carry. After that, each file starts with `== path (status)`. Every added or removed line is prefixed with its number, `[12] + text` or `[13] - text`. Indented lines are unchanged context and carry no number. Read the whole listing; for large changes, read it in parts.

The numbers belong to that exact snapshot. If you edit the working copy afterwards, run `--list-lines` again and renumber. The review command refuses a plan written for another snapshot.

## Write the plan

Write a JSON file. For a sequence of steps:

```json
{
  "base": "<base from the listing>",
  "snapshot": "<snapshot from the listing>",
  "layout": "steps",
  "steps": [
    { "title": "Short title", "description": "One or two sentences.", "impactful": false, "ranges": [{ "start": 1, "end": 30 }, { "start": 88, "end": 95 }] }
  ]
}
```

For a dependency tree, use `"layout": "tree"` and a `nodes` list. Each node also has a unique `id` and a `parent`: the id of the node that relies on it, or `null` for the root.

```json
{
  "base": "…", "snapshot": "…", "layout": "tree",
  "nodes": [
    { "id": "session-store", "parent": "login-handler", "title": "…", "description": "…", "impactful": false, "ranges": [{ "start": 1, "end": 40 }] },
    { "id": "login-handler", "parent": null, "title": "…", "description": "…", "impactful": true, "ranges": [{ "start": 41, "end": 120 }] }
  ]
}
```

Then start the review with `--plan <file>`. Every problem is reported at once: lines no step covers, lines two steps both claim, bad ranges, and broken parents. Fix them and run the command again.

## Rules for both shapes

- Cover every numbered line exactly once across all ranges: no gaps and no overlaps. Removed lines are numbered too and belong with the step that removes or replaces them.
- A range is one contiguous run of numbers within a single file. One step may hold several ranges from different files when they are one unit of work: an interface together with its implementation, a type together with the code that first uses it, a function together with its test. Do not combine unrelated changes just because they are small.
- Never split a statement or block to fit a size.
- Fold small mechanical changes (imports, renames, wiring, configuration) into the step they support rather than giving each its own step.
- Titles name what the step does. Descriptions explain what the code does and why it is needed, in plain language. Do not review or judge the code; that is the reviewer's job.
- Mark as `impactful` only the few steps that establish a central behavior or contract, affect many callers, or carry notable correctness or security consequences.

## Steps

Order steps as a plausible way to build the change: foundations and types first, then core logic, then callers and interface, then tests and documentation. Prefer fewer, larger steps. A step is typically 50–250 changed lines and rarely much more; a small change may need only one or two.

## Tree

Leaves are building blocks that rely on nothing else in the change: a new type or model, a schema or migration, a pure helper, a constant. A parent relies on its children: a service using the model, a handler calling the service. The root ties the work together, usually the entry point, the wiring, or the feature's top-level caller.

- Each node has exactly one parent. When several nodes rely on the same change, choose the one that relies on it most directly.
- A child must not rely on its parent or anything above it. Changes that rely on each other belong in one node.
- Aim for a single root; use several only for genuinely unrelated work.
- A node is typically 20–200 changed lines. A tree two to four levels deep is usually right; do not chain single-child nodes just to add depth.
- Tests and documentation go with the node they cover, or in a node of their own whose parent is that node.
- The description says what the node does and what it provides to the node above it.
