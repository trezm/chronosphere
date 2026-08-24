"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Lock,
  LogOut,
  MessageSquare,
  Moon,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  UserRoundCheck,
  XCircle,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { api, isApiErrorWithStatus } from "@/lib/api";
import { parseUnifiedDiff } from "@/lib/diff";
import { highlightLines, languageForPath, type SyntaxToken } from "@/lib/syntax";
import {
  clearInProgressReview,
  loadInProgressReview,
  reviewCacheKey,
  saveInProgressReview,
  type ReviewEvent,
} from "@/lib/review-cache";
import type {
  DiffFile,
  DiffLine,
  PendingComment,
  PullRequestDetail,
  PullRequestSummary,
  ReplayResult,
  Repository,
} from "@/lib/types";

type AuthState = {
  github: { connected: boolean; user: { login: string; name: string | null; avatarUrl: string } | null };
  openrouter: { connected: boolean; userId: string | null };
  configured: { github: boolean };
  defaults: { model: string };
};

function timeAgo(value: string): string {
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(value).toLocaleDateString();
}

function Avatar({ src, alt, size = 24 }: { src: string; alt: string; size?: number }) {
  return <Image className="avatar" src={src} alt={alt} width={size} height={size} unoptimized />;
}

function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true">
        <span />
        <Play size={11} fill="currentColor" />
      </div>
      <span>chronosphere</span>
    </div>
  );
}

function AppHeader({
  auth,
  onToggleTheme,
  onLogout,
}: {
  auth: AuthState | null;
  onToggleTheme: () => void;
  onLogout: () => void;
}) {
  return (
    <header className="app-header">
      <Brand />
      <div className="header-right">
        <span className="header-context">PRs, reconstructed</span>
        <button className="icon-button quiet theme-toggle" onClick={onToggleTheme} aria-label="Toggle color mode" title="Toggle color mode">
          <Moon className="moon-icon" size={15} /><Sun className="sun-icon" size={15} />
        </button>
        {auth?.github.user && (
          <div className="viewer-pill">
            <Avatar src={auth.github.user.avatarUrl} alt="" size={22} />
            <span>@{auth.github.user.login}</span>
            <button className="icon-button quiet" onClick={onLogout} aria-label="Sign out" title="Disconnect accounts">
              <LogOut size={14} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

function ConnectionGate({ auth, connectionError }: { auth: AuthState; connectionError?: string | null }) {
  const queryError = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("error") : null;
  const error = connectionError ?? queryError;
  const steps = [
    {
      key: "github",
      title: "Connect GitHub",
      copy: "Choose repositories, read pull requests, leave reviews, and merge as you.",
      connected: auth.github.connected,
      icon: <GitPullRequest size={20} />,
      href: "/api/auth/github",
      disabled: !auth.configured.github,
    },
    {
      key: "openrouter",
      title: "Connect OpenRouter",
      copy: "Use your account to reconstruct each pull request into a replayable story.",
      connected: auth.openrouter.connected,
      icon: <Sparkles size={20} />,
      href: "/api/auth/openrouter",
      disabled: false,
    },
  ];
  return (
    <main className="auth-shell">
      <div className="auth-orbit" aria-hidden="true"><span /><span /><span /></div>
      <section className="auth-card">
        <div className="eyebrow"><CircleDot size={13} /> A code review time machine</div>
        <h1>See the pull request<br />before it was finished.</h1>
        <p className="auth-lede">
          Chronosphere asks a model to reconstruct a plausible build order, then lets you review the code as it lands—one coherent step at a time.
        </p>
        {error && <div className="error-banner"><XCircle size={15} />{error}</div>}
        <div className="connection-list">
          {steps.map((step, index) => (
            <div className={`connection-row ${step.connected ? "is-connected" : ""}`} key={step.key}>
              <div className="connection-index">0{index + 1}</div>
              <div className="connection-icon">{step.icon}</div>
              <div className="connection-copy">
                <strong>{step.title}</strong>
                <span>{step.copy}</span>
              </div>
              {step.connected ? (
                <div className="connected-label"><Check size={14} /> Connected</div>
              ) : (
                <a className={`primary-button compact ${step.disabled ? "disabled" : ""}`} href={step.disabled ? undefined : step.href} aria-disabled={step.disabled}>
                  {step.disabled ? "Needs setup" : "Connect"}<ArrowRight size={14} />
                </a>
              )}
            </div>
          ))}
        </div>
        {!auth.configured.github && (
          <p className="setup-note">Add the GitHub OAuth credentials from <code>.env.example</code>, then restart the app.</p>
        )}
        <div className="security-note"><ShieldCheck size={15} /><span>Tokens are encrypted, HTTP-only, and never exposed to the browser.</span></div>
      </section>
    </main>
  );
}

function People({ people, empty = "Unassigned" }: { people: Array<{ login: string; avatarUrl: string }>; empty?: string }) {
  if (!people.length) return <span className="muted">{empty}</span>;
  return (
    <span className="people">
      <span className="avatar-stack">
        {people.slice(0, 3).map((person) => <Avatar key={person.login} src={person.avatarUrl} alt="" size={20} />)}
      </span>
      <span>{people.slice(0, 2).map((person) => `@${person.login}`).join(", ")}{people.length > 2 ? ` +${people.length - 2}` : ""}</span>
    </span>
  );
}

function RepositoryPicker({
  viewer,
  onOpen,
  onReconnectRequired,
}: {
  viewer: NonNullable<AuthState["github"]["user"]>;
  onOpen: (repo: Repository, pull: PullRequestSummary) => void;
  onReconnectRequired: () => void;
}) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selected, setSelected] = useState<Repository | null>(null);
  const [pulls, setPulls] = useState<PullRequestSummary[]>([]);
  const [repoSearch, setRepoSearch] = useState("");
  const [prSearch, setPrSearch] = useState("");
  const [involvement, setInvolvement] = useState<"all" | "mine" | "assigned" | "review">("all");
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [loadingPulls, setLoadingPulls] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ repositories: Repository[] }>("/api/github/repos")
      .then(({ repositories }) => {
        setRepositories(repositories);
        if (repositories[0]) {
          setLoadingPulls(true);
          setSelected(repositories[0]);
        }
      })
      .catch((error: unknown) => {
        if (isApiErrorWithStatus(error, 400, 401)) {
          onReconnectRequired();
          return;
        }
        setError(error instanceof Error ? error.message : "Could not load repositories.");
      })
      .finally(() => setLoadingRepos(false));
  }, [onReconnectRequired]);

  useEffect(() => {
    if (!selected) return;
    api<{ pulls: PullRequestSummary[] }>(`/api/github/pulls?repo=${encodeURIComponent(selected.fullName)}`)
      .then(({ pulls }) => setPulls(pulls))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoadingPulls(false));
  }, [selected]);

  const selectRepository = (repo: Repository) => {
    setLoadingPulls(true);
    setError(null);
    setSelected(repo);
  };

  const filteredRepos = repositories.filter((repo) => {
    const query = repoSearch.toLowerCase();
    return repo.fullName.toLowerCase().includes(query) || repo.description?.toLowerCase().includes(query);
  });
  const filteredPulls = pulls.filter((pull) => {
    const matchesSearch = `${pull.number} ${pull.title} ${pull.author.login}`.toLowerCase().includes(prSearch.toLowerCase());
    if (!matchesSearch) return false;
    if (involvement === "mine") return pull.author.login.toLowerCase() === viewer.login.toLowerCase();
    if (involvement === "assigned") return pull.assignees.some((person) => person.login.toLowerCase() === viewer.login.toLowerCase());
    if (involvement === "review") return pull.requestedReviewers.some((person) => person.login.toLowerCase() === viewer.login.toLowerCase());
    return true;
  });

  return (
    <main className="picker-shell">
      <div className="picker-intro">
        <div>
          <div className="eyebrow"><GitBranch size={13} /> Repository browser</div>
          <h1>Choose a pull request</h1>
          <p>Pick the work you want to rewind. Chronosphere only lists open pull requests.</p>
        </div>
        <div className="auth-badges">
          <span><GitPullRequest size={14} /> GitHub</span><span><Sparkles size={14} /> OpenRouter</span>
        </div>
      </div>
      {error && <div className="error-banner wide"><XCircle size={15} />{error}</div>}
      <section className="picker-grid">
        <div className="repo-panel">
          <div className="panel-heading">
            <div><span className="kicker">Repositories</span><strong>{repositories.length}</strong></div>
            <label className="search-field"><Search size={15} /><input value={repoSearch} onChange={(event) => setRepoSearch(event.target.value)} placeholder="Filter repositories" aria-label="Filter repositories" /></label>
          </div>
          <div className="repo-list">
            {loadingRepos && <div className="empty-state"><span className="spinner" />Loading repositories…</div>}
            {!loadingRepos && filteredRepos.map((repo) => (
              <button key={repo.id} className={`repo-row ${selected?.id === repo.id ? "selected" : ""}`} onClick={() => selectRepository(repo)}>
                <Avatar src={repo.ownerAvatarUrl} alt="" size={28} />
                <span className="repo-copy"><strong>{repo.name}</strong><span>{repo.owner} · {repo.private ? "Private" : "Public"}</span></span>
                {repo.private && <Lock size={12} />}
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
        </div>
        <div className="pr-panel">
          <div className="panel-heading pr-heading">
            <div><span className="kicker">Open pull requests</span><strong>{selected?.fullName ?? "Select a repository"}</strong></div>
            <label className="search-field"><Search size={15} /><input value={prSearch} onChange={(event) => setPrSearch(event.target.value)} placeholder="Filter pull requests" aria-label="Filter pull requests" /></label>
          </div>
          <div className="filter-bar" role="group" aria-label="Pull request involvement">
            {([['all', 'All open'], ['mine', 'Authored by me'], ['assigned', 'Assigned to me'], ['review', 'Review requested']] as const).map(([value, label]) => (
              <button key={value} className={involvement === value ? "active" : ""} onClick={() => setInvolvement(value)}>{label}</button>
            ))}
          </div>
          <div className="pr-list">
            {loadingPulls && <div className="empty-state"><span className="spinner" />Loading pull requests…</div>}
            {!loadingPulls && selected && filteredPulls.map((pull) => (
              <button className="pr-row" key={pull.number} onClick={() => onOpen(selected, pull)}>
                <div className="pr-number">#{pull.number}</div>
                <div className="pr-main">
                  <div className="pr-title-row"><strong>{pull.title}</strong>{pull.draft && <span className="draft-badge">Draft</span>}</div>
                  <div className="pr-meta">
                    <span>opened by</span><People people={[pull.author]} />
                    <span className="dot">·</span><span>{timeAgo(pull.updatedAt)}</span>
                    <span className="branch"><GitBranch size={12} />{pull.head} → {pull.base}</span>
                  </div>
                  <div className="assignment-row">
                    <span><UserRoundCheck size={13} /> Assigned</span><People people={pull.assignees} />
                    <span><MessageSquare size={13} /> Reviewers</span><People people={pull.requestedReviewers} empty="None requested" />
                  </div>
                </div>
                <ChevronRight size={18} />
              </button>
            ))}
            {!loadingPulls && selected && filteredPulls.length === 0 && <div className="empty-state">No open pull requests match these filters.</div>}
          </div>
        </div>
      </section>
    </main>
  );
}

function ReplayFileView({
  file,
  step,
  currentRange,
  showFullDiff,
  contentRepo,
  contentRef,
  comments,
  onAdd,
  onUpdate,
  onDelete,
}: {
  file: DiffFile;
  step: number;
  currentRange: { start: number; end: number } | null;
  showFullDiff: boolean;
  contentRepo: string;
  contentRef: string;
  comments: PendingComment[];
  onAdd: (comment: Omit<PendingComment, "id">) => void;
  onUpdate: (id: string, body: string) => void;
  onDelete: (id: string) => void;
}) {
  const [target, setTarget] = useState<{ line: number; side: "LEFT" | "RIGHT"; index: number | null } | null>(null);
  const [body, setBody] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editedBody, setEditedBody] = useState("");
  const [contentLines, setContentLines] = useState<string[] | null>(null);
  const [highlightedHunks, setHighlightedHunks] = useState<SyntaxToken[][][]>([]);
  const [highlightedContent, setHighlightedContent] = useState<SyntaxToken[][] | null>(null);
  const [expanded, setExpanded] = useState<Record<number, { before: number; after: number }>>({});
  const [expanding, setExpanding] = useState<string | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const contentLinesRef = useRef<string[] | null>(null);
  const syntaxLanguage = useMemo(
    () => languageForPath(file.path, file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)).join("\n")),
    [file.hunks, file.path]
  );
  const fileComments = comments.filter((comment) => comment.path === file.path);
  const visibleHunks = file.hunks
    .map((hunk, originalIndex) => ({
      ...hunk,
      originalIndex,
      sourceLines: hunk.lines,
      lines: showFullDiff
        ? hunk.lines
        : hunk.lines.filter((line) => line.type === "context" || (line.changedIndex !== null && currentRange && line.changedIndex >= currentRange.start && line.changedIndex <= currentRange.end)),
    }))
    .filter((hunk) => showFullDiff || hunk.sourceLines.some((line) => line.changedIndex !== null && currentRange && line.changedIndex >= currentRange.start && line.changedIndex <= currentRange.end));
  useEffect(() => {
    let stale = false;
    Promise.all(file.hunks.map((hunk) => highlightLines(hunk.lines.map((line) => line.text), syntaxLanguage)))
      .then((result) => { if (!stale) setHighlightedHunks(result); });
    return () => { stale = true; };
  }, [file.hunks, syntaxLanguage]);

  useEffect(() => {
    if (!contentLines) return;
    let stale = false;
    highlightLines(contentLines, syntaxLanguage).then((result) => { if (!stale) setHighlightedContent(result); });
    return () => { stale = true; };
  }, [contentLines, syntaxLanguage]);

  const renderCode = (tokens: SyntaxToken[] | undefined, fallback: string) => {
    if (!tokens) return fallback || " ";
    if (!tokens.length) return " ";
    return tokens.map((token, index) => token.type
      ? <span className={`shj-syn-${token.type}`} key={index}>{token.text}</span>
      : <Fragment key={index}>{token.text}</Fragment>
    );
  };
  if (!visibleHunks.length) return null;

  const usesOldContent = file.status === "deleted";
  const coordinate = (line: DiffLine) => usesOldContent ? line.oldLine : line.newLine;
  const bounds = (lines: DiffLine[], header?: string) => {
    const numbers = lines.map(coordinate).filter((line): line is number => line !== null);
    if (numbers.length) return { first: Math.min(...numbers), last: Math.max(...numbers) };
    const match = header?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    const start = Number(match?.[usesOldContent ? 1 : 3] ?? 1);
    const count = Number(match?.[usesOldContent ? 2 : 4] ?? 1);
    return { first: start, last: start + Math.max(0, count - 1) };
  };
  const hunkBoundsAt = (index: number) => bounds(file.hunks[index].lines, file.hunks[index].header);
  const loadContent = async () => {
    if (contentLinesRef.current) return contentLinesRef.current;
    const query = new URLSearchParams({ repo: contentRepo, ref: contentRef, path: usesOldContent ? (file.oldPath ?? file.path) : file.path });
    const { content } = await api<{ content: string }>(`/api/github/file?${query}`);
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    contentLinesRef.current = lines;
    setContentLines(lines);
    return lines;
  };
  const expandContext = async (hunkIndex: number, direction: "before" | "after") => {
    const key = `${hunkIndex}-${direction}`;
    setExpanding(key); setContextError(null);
    try {
      const lines = await loadContent();
      const { first, last } = hunkBoundsAt(hunkIndex);
      setExpanded((current) => {
        const value = current[hunkIndex] ?? { before: 0, after: 0 };
        const previousLast = hunkIndex > 0 ? hunkBoundsAt(hunkIndex - 1).last : 0;
        const nextFirst = hunkIndex < file.hunks.length - 1 ? hunkBoundsAt(hunkIndex + 1).first : lines.length + 1;
        const neighboringExpansion = direction === "before" ? (current[hunkIndex - 1]?.after ?? 0) : (current[hunkIndex + 1]?.before ?? 0);
        const gap = direction === "before" ? first - previousLast - 1 : nextFirst - last - 1;
        const available = Math.max(0, gap - neighboringExpansion);
        return { ...current, [hunkIndex]: { ...value, [direction]: Math.min(available, value[direction] + 20) } };
      });
    } catch (error) {
      setContextError(error instanceof Error ? error.message : "Could not load more context.");
    } finally {
      setExpanding(null);
    }
  };
  const contextRows = (start: number, end: number) => {
    if (!contentLines || end < start) return null;
    return Array.from({ length: end - start + 1 }, (_, offset) => {
      const line = start + offset;
      return (
        <div className="diff-row context expanded-context" key={`context-${line}`}>
          <span className="context-gutter" />
          <span className="line-number">{usesOldContent ? line : ""}</span>
          <span className="line-number">{usesOldContent ? "" : line}</span>
          <code><i> </i>{renderCode(highlightedContent?.[line - 1], contentLines[line - 1])}</code>
        </div>
      );
    });
  };

  const commentTarget = (line: DiffLine) => ({
    line: line.type === "delete" ? line.oldLine : line.newLine,
    side: line.type === "delete" ? "LEFT" as const : "RIGHT" as const,
    index: line.changedIndex,
  });
  const submitComment = () => {
    if (!target?.line || !body.trim()) return;
    onAdd({ path: file.path, line: target.line, side: target.side, body: body.trim(), step });
    setBody("");
    setTarget(null);
  };
  const startEditing = (comment: PendingComment) => {
    setEditingCommentId(comment.id);
    setEditedBody(comment.body);
  };
  const cancelEditing = () => {
    setEditingCommentId(null);
    setEditedBody("");
  };
  const saveEditedComment = () => {
    if (!editingCommentId || !editedBody.trim()) return;
    onUpdate(editingCommentId, editedBody.trim());
    cancelEditing();
  };
  return (
    <article className="diff-file">
      <header><span className="file-dot" /> <code>{file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ` : ""}{file.path}</code><span>{fileComments.length ? `${fileComments.length} pending` : file.status}</span></header>
      <div className="diff-table">
        {visibleHunks.map((hunk) => {
          const hunkBounds = bounds(hunk.sourceLines, hunk.header);
          const expansion = expanded[hunk.originalIndex] ?? { before: 0, after: 0 };
          const previousLast = hunk.originalIndex > 0 ? hunkBoundsAt(hunk.originalIndex - 1).last : 0;
          const nextFirst = hunk.originalIndex < file.hunks.length - 1 ? hunkBoundsAt(hunk.originalIndex + 1).first : (contentLines?.length ?? Infinity) + 1;
          const canExpandBefore = expansion.before + (expanded[hunk.originalIndex - 1]?.after ?? 0) < hunkBounds.first - previousLast - 1;
          const canExpandAfter = expansion.after + (expanded[hunk.originalIndex + 1]?.before ?? 0) < nextFirst - hunkBounds.last - 1;
          return (
          <Fragment key={`${file.path}-${hunk.originalIndex}`}>
            {canExpandBefore && <div className="context-expander above"><button onClick={() => void expandContext(hunk.originalIndex, "before")} disabled={expanding !== null} aria-label="Show 20 lines above" title="Show more lines above"><ChevronUp size={13} />Show 20 lines above</button></div>}
            {contextRows(hunkBounds.first - expansion.before, hunkBounds.first - 1)}
            <div className="hunk-row"><span /><span /><code>{hunk.header}</code></div>
            {hunk.lines.map((line, lineIndex) => {
              const current = line.changedIndex !== null && currentRange && line.changedIndex >= currentRange.start && line.changedIndex <= currentRange.end;
              const anchor = commentTarget(line);
              const anchored = fileComments.filter((comment) => comment.line === anchor.line && comment.side === anchor.side);
              const composing = target?.line === anchor.line && target.side === anchor.side;
              return (
                <Fragment key={`${hunk.originalIndex}-${lineIndex}`}>
                  <div className={`diff-row ${line.type} ${current ? "current" : ""}`}>
                    <button className="add-comment" onClick={() => anchor.line && setTarget({ ...anchor, line: anchor.line })} aria-label={`Comment on line ${anchor.line}`}><span>+</span></button>
                    <span className="line-number">{line.oldLine ?? ""}</span>
                    <span className="line-number">{line.newLine ?? ""}</span>
                    <code><i>{line.type === "add" ? "+" : line.type === "delete" ? "−" : " "}</i>{renderCode(highlightedHunks[hunk.originalIndex]?.[hunk.sourceLines.indexOf(line)], line.text)}</code>
                  </div>
                  {anchored.map((comment) => editingCommentId === comment.id ? (
                    <div className="inline-composer inline-comment-editor" key={comment.id}>
                      <textarea autoFocus value={editedBody} onChange={(event) => setEditedBody(event.target.value)} onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); saveEditedComment(); }
                        if (event.key === "Escape") { event.preventDefault(); cancelEditing(); }
                      }} aria-label={`Edit comment on ${file.path}:${comment.line}`} />
                      <div><button className="text-button" onClick={cancelEditing}>Cancel</button><button className="primary-button compact" onClick={saveEditedComment} disabled={!editedBody.trim()}>Save comment</button></div>
                    </div>
                  ) : (
                    <div className="inline-draft" key={comment.id}>
                      <MessageSquare size={13} /><span>{comment.body}</span><em>Pending</em>
                      <div className="comment-actions">
                        <button onClick={() => startEditing(comment)} aria-label="Edit pending comment" title="Edit comment"><Pencil size={12} /></button>
                        <button className="delete" onClick={() => onDelete(comment.id)} aria-label="Delete pending comment" title="Delete comment"><Trash2 size={12} /></button>
                      </div>
                    </div>
                  ))}
                  {composing && (
                    <div className="inline-composer">
                      <textarea autoFocus value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); submitComment(); } }} placeholder={`Leave a comment on ${file.path}:${anchor.line}`} />
                      <div><button className="text-button" onClick={() => { setTarget(null); setBody(""); }}>Cancel</button><button className="primary-button compact" onClick={submitComment} disabled={!body.trim()}>Add pending comment</button></div>
                    </div>
                  )}
                </Fragment>
              );
            })}
            {contextRows(hunkBounds.last + 1, hunkBounds.last + expansion.after)}
            {canExpandAfter && <div className="context-expander below"><button onClick={() => void expandContext(hunk.originalIndex, "after")} disabled={expanding !== null} aria-label="Show 20 lines below" title="Show more lines below"><ChevronDown size={13} />Show 20 lines below</button></div>}
          </Fragment>
        );})}
      </div>
      {contextError && <div className="context-error">{contextError}</div>}
    </article>
  );
}

function ReviewSidebar({
  repo,
  pull,
  comments,
  event,
  summary,
  onEventChange,
  onSummaryChange,
  onUpdateComment,
  onDeleteComment,
  onSubmitted,
  onMerged,
}: {
  repo: Repository;
  pull: PullRequestDetail;
  comments: PendingComment[];
  event: ReviewEvent;
  summary: string;
  onEventChange: (event: ReviewEvent) => void;
  onSummaryChange: (summary: string) => void;
  onUpdateComment: (id: string, body: string) => void;
  onDeleteComment: (id: string) => void;
  onSubmitted: () => void;
  onMerged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [mergeMethod, setMergeMethod] = useState<"merge" | "squash" | "rebase">(
    pull.allowedMergeMethods.includes("squash") ? "squash" : (pull.allowedMergeMethods[0] ?? "squash")
  );
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editedBody, setEditedBody] = useState("");

  const startEditing = (comment: PendingComment) => {
    setEditingCommentId(comment.id);
    setEditedBody(comment.body);
  };
  const cancelEditing = () => {
    setEditingCommentId(null);
    setEditedBody("");
  };
  const saveEditedComment = () => {
    if (!editingCommentId || !editedBody.trim()) return;
    onUpdateComment(editingCommentId, editedBody.trim());
    cancelEditing();
  };
  const deleteComment = (id: string) => {
    if (editingCommentId === id) cancelEditing();
    onDeleteComment(id);
  };

  const submitReview = async () => {
    if (busy || (!comments.length && !summary.trim())) return;
    setBusy(true); setMessage(null);
    try {
      await api("/api/github/review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repo.fullName, number: pull.number, event, body: summary, commitId: pull.headSha, comments }),
      });
      setMessage("Review posted to GitHub."); onSubmitted();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Review failed."); }
    finally { setBusy(false); }
  };

  const merge = async () => {
    if (!confirmMerge) { setConfirmMerge(true); return; }
    setMergeBusy(true); setMessage(null);
    try {
      await api("/api/github/merge", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repo.fullName, number: pull.number, method: mergeMethod, sha: pull.headSha }),
      });
      setMessage("Pull request merged on GitHub."); setConfirmMerge(false); onMerged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Merge failed."); }
    finally { setMergeBusy(false); }
  };

  const mergeLabel = pull.merged ? "Merged" : pull.state === "closed" ? "Closed" : pull.draft ? "Draft" : pull.mergeable === false ? "Conflicts" : pull.mergeable === null ? "Checking" : "Ready to merge";
  const mergeTone = pull.merged ? "purple" : pull.mergeable === false ? "red" : pull.mergeable === true ? "green" : "amber";
  const canAttemptMerge = pull.state === "open" && !pull.draft && pull.mergeable !== false && pull.allowedMergeMethods.length > 0;

  return (
    <aside className="review-sidebar">
      <section className="review-section pending-section">
        <div className="section-title"><span>Pending comments</span><em>{comments.length}</em></div>
        <div className="comment-list">
          {!comments.length && <p className="sidebar-empty">Hover a diff line and press <kbd>+</kbd> to start a review comment.</p>}
          {comments.map((comment) => (
            <div className="draft-card" key={comment.id}>
              <div className="draft-card-header"><code>{comment.path}:{comment.line}</code><div className="comment-actions">
                <button onClick={() => startEditing(comment)} aria-label="Edit pending comment" title="Edit comment"><Pencil size={12} /></button>
                <button className="delete" onClick={() => deleteComment(comment.id)} aria-label="Delete pending comment" title="Delete comment"><Trash2 size={12} /></button>
              </div></div>
              {editingCommentId === comment.id ? (
                <div className="draft-card-editor">
                  <textarea autoFocus value={editedBody} onChange={(event) => setEditedBody(event.target.value)} onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); saveEditedComment(); }
                    if (event.key === "Escape") { event.preventDefault(); cancelEditing(); }
                  }} aria-label={`Edit comment on ${comment.path}:${comment.line}`} />
                  <div><button className="text-button" onClick={cancelEditing}>Cancel</button><button className="primary-button compact" onClick={saveEditedComment} disabled={!editedBody.trim()}>Save</button></div>
                </div>
              ) : <p>{comment.body}</p>}
              <span>Step {comment.step + 1} · {comment.side === "LEFT" ? "old" : "new"} side</span>
            </div>
          ))}
        </div>
        <textarea className="review-summary" value={summary} onChange={(e) => onSummaryChange(e.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submitReview(); } }} placeholder="Add an overall review summary…" />
        <div className="review-events">
          {([['COMMENT', 'Comment', MessageSquare], ['APPROVE', 'Approve', CheckCircle2], ['REQUEST_CHANGES', 'Changes', XCircle]] as const).map(([value, label, Icon]) => (
            <button key={value} className={event === value ? "active" : ""} onClick={() => onEventChange(value)}><Icon size={14} />{label}</button>
          ))}
        </div>
        <button className="primary-button full" onClick={submitReview} disabled={busy || (!comments.length && !summary.trim())}>{busy ? "Submitting…" : `Submit review · ${comments.length} comment${comments.length === 1 ? "" : "s"}`}</button>
      </section>
      <section className="review-section merge-section">
        <div className="section-title"><span>Merge status</span><em className={mergeTone}>{mergeLabel}</em></div>
        <div className="merge-facts">
          <div><span>Conflicts</span><strong>{pull.mergeable === false ? <><XCircle size={14} /> Present</> : pull.mergeable === null ? "Calculating…" : <><Check size={14} /> None</>}</strong></div>
          <div><span>GitHub state</span><strong>{pull.mergeableState.replace(/_/g, " ")}</strong></div>
          <div><span>Head</span><code>{pull.headSha.slice(0, 8)}</code></div>
        </div>
        {pull.mergeable === false && <p className="merge-warning">The branches conflict. Resolve them on the head branch before merging.</p>}
        {canAttemptMerge && (
          <>
            <label className="select-wrap"><select value={mergeMethod} onChange={(event) => { setMergeMethod(event.target.value as typeof mergeMethod); setConfirmMerge(false); }}>
              {pull.allowedMergeMethods.map((method) => <option key={method} value={method}>{method === "squash" ? "Squash and merge" : method === "rebase" ? "Rebase and merge" : "Create a merge commit"}</option>)}
            </select><ChevronDown size={14} /></label>
            <button className={`merge-button ${confirmMerge ? "confirm" : ""}`} onClick={merge} disabled={mergeBusy}>
              <GitMerge size={15} />{mergeBusy ? "Merging…" : confirmMerge ? `Confirm ${mergeMethod} merge` : "Merge pull request"}
            </button>
            {confirmMerge && <button className="text-button cancel-confirm" onClick={() => setConfirmMerge(false)}>Cancel</button>}
          </>
        )}
      </section>
      {message && <div className={`sidebar-message ${/failed|required|error|conflict|refused/i.test(message) ? "error" : ""}`}>{message}</div>}
    </aside>
  );
}

function ReplayWorkspace({ repo, summary, defaultModel, viewer, onBack }: { repo: Repository; summary: PullRequestSummary; defaultModel: string; viewer: string; onBack: () => void }) {
  const [pull, setPull] = useState<PullRequestDetail | null>(null);
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [comments, setComments] = useState<PendingComment[]>([]);
  const [reviewEvent, setReviewEvent] = useState<ReviewEvent>("COMMENT");
  const [reviewSummary, setReviewSummary] = useState("");
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState(defaultModel);
  const [showFullDiff, setShowFullDiff] = useState(false);
  const [cacheReady, setCacheReady] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cacheKey = useMemo(() => reviewCacheKey(viewer, repo.fullName, summary.number), [viewer, repo.fullName, summary.number]);

  const refreshPull = async () => {
    const { pull } = await api<{ pull: PullRequestDetail }>(`/api/github/pull?repo=${encodeURIComponent(repo.fullName)}&number=${summary.number}`);
    setPull(pull);
  };
  useEffect(() => {
    let active = true;
    api<{ pull: PullRequestDetail }>(`/api/github/pull?repo=${encodeURIComponent(repo.fullName)}&number=${summary.number}`)
      .then(({ pull }) => {
        if (!active) return;
        setPull(pull);
        try {
          const cached = loadInProgressReview(window.localStorage, cacheKey, pull.headSha);
          if (cached) {
            setReplay(cached.replay);
            setStep(Math.min(cached.step, Math.max(0, cached.replay.chunks.length - 1)));
            setComments(cached.comments);
            setReviewSummary(cached.summary);
            setReviewEvent(cached.event);
            setModel(cached.model);
            setShowFullDiff(cached.showFullDiff);
          }
        } catch {
          // Browser privacy settings and storage quotas must not block review work.
        }
        setCacheReady(true);
      })
      .catch((error: Error) => { if (active) setError(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [repo.fullName, summary.number, cacheKey]);
  useEffect(() => {
    if (!cacheReady || !pull) return;
    try {
      if (!comments.length && !reviewSummary.trim()) {
        clearInProgressReview(window.localStorage, cacheKey);
        return;
      }
      // A rebuild briefly removes the replay from memory; retain the last complete
      // cached draft until its replacement is ready.
      if (!replay) return;
      saveInProgressReview(window.localStorage, cacheKey, {
        headSha: pull.headSha,
        replay,
        step,
        comments,
        summary: reviewSummary,
        event: reviewEvent,
        model,
        showFullDiff,
      });
    } catch {
      // Keep the in-memory review usable if browser storage is unavailable.
    }
  }, [cacheReady, cacheKey, comments, model, pull, replay, reviewEvent, reviewSummary, showFullDiff, step]);
  useEffect(() => {
    if (!playing || !replay) return;
    if (step >= replay.chunks.length - 1) {
      const stop = window.setTimeout(() => setPlaying(false), 0);
      return () => window.clearTimeout(stop);
    }
    const timer = window.setTimeout(() => setStep((value) => Math.min(replay.chunks.length - 1, value + 1)), 2400);
    return () => window.clearTimeout(timer);
  }, [playing, step, replay]);

  const build = async () => {
    setBuilding(true); setError(null);
    try {
      const result = await api<{ replay: ReplayResult }>("/api/replay", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repo.fullName, number: summary.number, model }),
      });
      setReplay(result.replay); setStep(0);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not build replay."); }
    finally { setBuilding(false); }
  };

  const files = useMemo(() => parseUnifiedDiff(pull?.diff ?? ""), [pull?.diff]);
  const chunk = replay?.chunks[step] ?? null;
  const go = (value: number) => {
    if (!replay) return;
    setPlaying(false); setStep(Math.max(0, Math.min(replay.chunks.length - 1, value)));
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const completeReview = () => {
    try { clearInProgressReview(window.localStorage, cacheKey); } catch { /* Storage may be unavailable. */ }
    setComments([]);
    setReviewSummary("");
    setReviewEvent("COMMENT");
  };
  const updateComment = (id: string, body: string) => {
    setComments((items) => items.map((item) => item.id === id ? { ...item, body } : item));
  };
  const deleteComment = (id: string) => {
    setComments((items) => items.filter((item) => item.id !== id));
  };

  useEffect(() => {
    if (!replay) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditable = target instanceof HTMLElement && (
        target.isContentEditable || target.matches("input, textarea, select")
      );
      if (isEditable || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

      event.preventDefault();
      setPlaying(false);
      setStep((current) => Math.max(0, Math.min(
        replay.chunks.length - 1,
        current + (event.key === "ArrowLeft" ? -1 : 1),
      )));
      scrollRef.current?.scrollTo({ top: 0 });
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [replay]);

  if (loading || !pull) {
    return <main className="loading-screen"><span className="spinner large" /><strong>Loading #{summary.number}</strong><span>{repo.fullName}</span>{error && <div className="error-banner">{error}</div>}</main>;
  }

  return (
    <main className="replay-shell">
      <header className="pr-header">
        <button className="back-button" onClick={onBack}><ArrowLeft size={16} /> Pull requests</button>
        <div className="pr-identity"><span className="open-dot" /><strong>{pull.title}</strong><span>#{pull.number}</span></div>
        <div className="pr-stats"><span className="additions">+{pull.additions}</span><span className="deletions">−{pull.deletions}</span><span>{pull.changedFiles} files</span><a href={pull.url} target="_blank" rel="noreferrer">GitHub <ExternalLink size={12} /></a></div>
      </header>
      {!replay ? (
        <section className="build-replay">
          <div className="replay-illustration" aria-hidden="true">
            <div className="orbit-line" /><span className="node n1">1</span><span className="node n2">2</span><span className="node n3">3</span><span className="node n4"><Play size={17} fill="currentColor" /></span>
          </div>
          <div className="eyebrow"><RotateCcw size={13} /> Ready to reconstruct</div>
          <h2>Rewind #{pull.number}</h2>
          <p>A model will divide {pull.additions + pull.deletions} changed lines into a plausible implementation order. This is a reconstruction for comprehension—not the author&apos;s actual history.</p>
          <label className="model-field"><span>OpenRouter model</span><input value={model} onChange={(event) => setModel(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void build(); } }} spellCheck={false} /></label>
          {error && <div className="error-banner"><XCircle size={15} />{error}</div>}
          <button className="primary-button build-button" onClick={build} disabled={building || !model.trim()}>{building ? <><span className="spinner" />Constructing the replay…</> : <><Play size={15} fill="currentColor" />Build replay</>}</button>
          <div className="pr-context"><Avatar src={pull.author.avatarUrl} alt="" size={22} /><span>Authored by <strong>@{pull.author.login}</strong></span><GitBranch size={13} /><code>{pull.head}</code><ArrowRight size={12} /><code>{pull.base}</code></div>
        </section>
      ) : (
        <div className="replay-grid">
          <aside className="timeline-panel">
            <div className="timeline-title"><span>Reconstruction</span><em>{replay.chunks.length} steps</em></div>
            <ol>
              {replay.chunks.map((item, index) => (
                <li className={index === step ? "active" : index < step ? "past" : ""} key={`${item.file}-${item.start}`}>
                  <button onClick={() => go(index)}>
                    <span className="step-marker">{index < step ? <Check size={12} /> : index + 1}</span>
                    <span><strong>{item.title}</strong><code>{item.file}</code></span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="timeline-model"><Sparkles size={13} /><span>Replayed by<br /><strong>{replay.model}</strong></span></div>
          </aside>
          <section className="code-stage">
            <header className="player-bar">
              <button className="icon-button" onClick={() => go(step - 1)} disabled={step === 0} aria-label="Previous replay step" aria-keyshortcuts="Meta+ArrowLeft" title="Previous step (⌘←)"><ChevronLeft size={16} /></button>
              <button className="play-button" onClick={() => { if (step === replay.chunks.length - 1) setStep(0); setPlaying((value) => !value); }}>{playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}{playing ? "Pause" : "Play"}</button>
              <button className="icon-button" onClick={() => go(step + 1)} disabled={step === replay.chunks.length - 1} aria-label="Next replay step" aria-keyshortcuts="Meta+ArrowRight" title="Next step (⌘→)"><ChevronRight size={16} /></button>
              <input type="range" min={0} max={Math.max(0, replay.chunks.length - 1)} value={step} onChange={(e) => go(Number(e.target.value))} aria-label="Replay position" />
              <strong>{step + 1} <span>/ {replay.chunks.length}</span></strong>
              <button className="rebuild-button" onClick={() => { setReplay(null); setPlaying(false); }}>Rebuild</button>
            </header>
            {chunk && <div className="step-narration">
              <div className="step-narration-top">
                <div className="step-meta"><span>Step {step + 1}</span><code>{chunk.file}</code></div>
                <div className="diff-scope-toggle" role="group" aria-label="Diff scope">
                  <button className={!showFullDiff ? "active" : ""} onClick={() => setShowFullDiff(false)} aria-pressed={!showFullDiff}>This step</button>
                  <button className={showFullDiff ? "active" : ""} onClick={() => setShowFullDiff(true)} aria-pressed={showFullDiff}>Full PR</button>
                </div>
              </div>
              <h2>{chunk.title}</h2><p>{chunk.description}</p>
            </div>}
            <div className="diff-scroll" ref={scrollRef}>
              {files.map((file) => <ReplayFileView key={file.path} file={file} step={step} currentRange={chunk ? { start: chunk.start, end: chunk.end } : null} showFullDiff={showFullDiff} contentRepo={file.status === "deleted" ? pull.baseRepo : pull.headRepo} contentRef={file.status === "deleted" ? pull.baseSha : pull.headSha} comments={comments} onAdd={(comment) => setComments((items) => [...items, { ...comment, id: crypto.randomUUID() }])} onUpdate={updateComment} onDelete={deleteComment} />)}
            </div>
          </section>
          <ReviewSidebar repo={repo} pull={pull} comments={comments} event={reviewEvent} summary={reviewSummary} onEventChange={setReviewEvent} onSummaryChange={setReviewSummary} onUpdateComment={updateComment} onDeleteComment={deleteComment} onSubmitted={completeReview} onMerged={() => void refreshPull()} />
        </div>
      )}
    </main>
  );
}

export default function Home() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [selection, setSelection] = useState<{ repo: Repository; pull: PullRequestSummary } | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    api<AuthState>("/api/auth/session").then(setAuth).catch(() => setAuth({ github: { connected: false, user: null }, openrouter: { connected: false, userId: null }, configured: { github: false }, defaults: { model: "openai/gpt-5-mini" } }));
  }, []);
  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("chronosphere-theme", next);
  };
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  };
  const requireGithubReconnect = useCallback(() => {
    setSelection(null);
    setConnectionError("Your GitHub credentials are no longer valid. Reconnect GitHub to continue.");
    setAuth((current) => current ? {
      ...current,
      github: { connected: false, user: null },
    } : current);
  }, []);
  if (!auth) return <main className="loading-screen"><span className="spinner large" /><strong>Opening Chronosphere</strong></main>;
  const ready = auth.github.connected && auth.openrouter.connected && auth.github.user;
  return (
    <div className="app-frame">
      <AppHeader auth={auth} onToggleTheme={toggleTheme} onLogout={logout} />
      {!ready ? <ConnectionGate auth={auth} connectionError={connectionError} /> : selection ? <ReplayWorkspace repo={selection.repo} summary={selection.pull} defaultModel={auth.defaults.model} viewer={auth.github.user!.login} onBack={() => setSelection(null)} /> : <RepositoryPicker viewer={auth.github.user!} onOpen={(repo, pull) => setSelection({ repo, pull })} onReconnectRequired={requireGithubReconnect} />}
    </div>
  );
}
