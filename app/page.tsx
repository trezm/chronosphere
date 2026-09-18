"use client";

import { decompressRecording } from "@/lib/recording-transport";
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
  FileUp,
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
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Trash2,
  UserRoundCheck,
  XCircle,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { contentHash, parseRecording, RECORDING_MAX_BYTES, type RecordedChange, type Recording } from "@/lib/recording";
import { historicalReviewNote, recordedChangeDiff, recordedLineAnchor, recordingReplay, type ReviewAnchor } from "@/lib/recording-review";
import { PR_RECORDING_PATH } from "@/lib/pr-recording";
import { api, authorizedFetch, onGithubSessionExpired } from "@/lib/api";
import { chunkFiles, inRanges, parseUnifiedDiff, replayStepMap } from "@/lib/diff";
import { loadRepoRecency, orderByRecency, recordRepoOpened } from "@/lib/repo-recency";
import { readReplayEvents } from "@/lib/replay-stream";
import { findingAnchor, findingToCommentBody, findingsAtNewLine, isFindingStaged, sortFindings } from "@/lib/review-findings";
import { highlightLines, languageForPath, type SyntaxToken } from "@/lib/syntax";
import {
  clearInProgressReview,
  loadInProgressReview,
  reviewCacheKey,
  saveInProgressReview,
  upgradeReplay,
  type ReviewEvent,
} from "@/lib/review-cache";
import { migrateInProgressReview, type PullRequestState } from "@/lib/review-state";
import type {
  DiffFile,
  DiffLine,
  AiReviewResult,
  PendingComment,
  PullRequestDetail,
  PullRequestSummary,
  ReplayChunk,
  ReplayRange,
  ReplayResult,
  Repository,
  ReviewFinding,
} from "@/lib/types";

type AuthState = {
  github: { connected: boolean; user: { login: string; name: string | null; avatarUrl: string } | null; expired?: boolean };
  openrouter: { connected: boolean; userId: string | null };
  configured: { github: boolean };
  defaults: { model: string; scoutModel: string; reviewerModel: string };
};

type Route = { repo: string | null; pull: number | null; step: number | null };

const EMPTY_ROUTE: Route = { repo: null, pull: null, step: null };

/** A tab hidden at least this long re-checks the GitHub session when it comes back, before any request can fail. */
const SESSION_RECHECK_AFTER_MS = 5 * 60 * 1000;
const SESSION_EXPIRED_MESSAGE = "Your GitHub session expired and could not be refreshed. Reconnect GitHub to continue.";

function positiveInteger(value: string | null): number | null {
  const parsed = Number(value);
  return value !== null && value !== "" && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readRoute(): Route {
  if (typeof window === "undefined") return EMPTY_ROUTE;
  const params = new URLSearchParams(window.location.search);
  const candidate = params.get("repo");
  const repo = candidate && /^[^/\s]+\/[^/\s]+$/.test(candidate) ? candidate : null;
  const pull = repo ? positiveInteger(params.get("pr")) : null;
  return { repo, pull, step: pull ? positiveInteger(params.get("step")) : null };
}

function routeUrl(route: Route): string {
  const params = new URLSearchParams();
  if (route.repo) params.set("repo", route.repo);
  if (route.repo && route.pull) params.set("pr", String(route.pull));
  if (route.repo && route.pull && route.step) params.set("step", String(route.step));
  const query = params.toString();
  return query ? `${window.location.pathname}?${query}` : window.location.pathname;
}

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

/** Reading localStorage throws outright when the browser blocks site data. */
function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** True when two timestamps are close enough that showing both adds nothing. */
function sameMoment(a: string, b: string): boolean {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 60000;
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
        <Link className="recording-home" href="/recordings">Open recording</Link>
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
  selectedRepo,
  onSelectRepo,
  onOpen,
}: {
  viewer: NonNullable<AuthState["github"]["user"]>;
  selectedRepo: string | null;
  onSelectRepo: (repo: string, mode: "push" | "replace") => void;
  onOpen: (repo: string, pull: number) => void;
}) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [recentRepos, setRecentRepos] = useState<Set<string>>(() => new Set());
  const [pulls, setPulls] = useState<{ repo: string; items: PullRequestSummary[] }>({ repo: "", items: [] });
  const [repoSearch, setRepoSearch] = useState("");
  const [prSearch, setPrSearch] = useState("");
  const [involvement, setInvolvement] = useState<"all" | "mine" | "assigned" | "review">("all");
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [pullsRefreshKey, setPullsRefreshKey] = useState(0);
  const [refreshingPulls, setRefreshingPulls] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingPulls = !!selectedRepo && pulls.repo !== selectedRepo;

  useEffect(() => {
    api<{ repositories: Repository[] }>("/api/github/repos")
      .then(({ repositories }) => {
        // Snapshot recency once so clicking a repository never reshuffles the list mid-session.
        const recency = loadRepoRecency(browserStorage());
        setRepositories(orderByRecency(repositories, recency));
        setRecentRepos(new Set(Object.keys(recency)));
      })
      // A rejected session is handled by the app frame, which swaps in the
      // connect page; the message here only matters while the picker is shown.
      .catch((error: unknown) => setError(error instanceof Error ? error.message : "Could not load repositories."))
      .finally(() => setLoadingRepos(false));
  }, []);

  // The first repository is a default rather than a navigation, so it replaces
  // the current history entry instead of adding one.
  useEffect(() => {
    if (selectedRepo || !repositories[0]) return;
    onSelectRepo(repositories[0].fullName, "replace");
  }, [onSelectRepo, repositories, selectedRepo]);

  // pullsRefreshKey re-runs the fetch for the same repository when the user
  // clicks refresh; the existing list stays on screen until the new one lands.
  useEffect(() => {
    if (!selectedRepo) return;
    let stale = false;
    api<{ pulls: PullRequestSummary[] }>(`/api/github/pulls?repo=${encodeURIComponent(selectedRepo)}`)
      .then(({ pulls }) => { if (!stale) { setError(null); setPulls({ repo: selectedRepo, items: pulls }); } })
      .catch((e: Error) => { if (!stale) { setError(e.message); setPulls({ repo: selectedRepo, items: [] }); } })
      .finally(() => { if (!stale) setRefreshingPulls(false); });
    return () => { stale = true; };
  }, [selectedRepo, pullsRefreshKey]);

  const refreshPulls = () => {
    if (!selectedRepo || loadingPulls || refreshingPulls) return;
    setRefreshingPulls(true);
    setPullsRefreshKey((key) => key + 1);
  };

  const filteredRepos = repositories.filter((repo) => {
    const query = repoSearch.toLowerCase();
    return repo.fullName.toLowerCase().includes(query) || repo.description?.toLowerCase().includes(query);
  });
  const recentEdge = filteredRepos.findLastIndex((repo) => recentRepos.has(repo.fullName));
  const filteredPulls = pulls.items.filter((pull) => {
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
            {!loadingRepos && filteredRepos.map((repo, index) => (
              <button key={repo.id} className={`repo-row ${selectedRepo === repo.fullName ? "selected" : ""} ${index === recentEdge && index < filteredRepos.length - 1 ? "recent-edge" : ""}`} onClick={() => { recordRepoOpened(browserStorage(), repo.fullName); onSelectRepo(repo.fullName, "push"); }}>
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
            <div><span className="kicker">Open pull requests</span><strong>{selectedRepo ?? "Select a repository"}</strong></div>
            <div className="pr-heading-tools">
              <label className="search-field"><Search size={15} /><input value={prSearch} onChange={(event) => setPrSearch(event.target.value)} placeholder="Filter pull requests" aria-label="Filter pull requests" /></label>
              <button type="button" className="icon-button refresh-button" onClick={refreshPulls} disabled={!selectedRepo || loadingPulls || refreshingPulls} aria-label="Refresh pull requests" title="Refresh pull requests">
                <RefreshCw size={15} className={refreshingPulls ? "spinning" : ""} />
              </button>
            </div>
          </div>
          <div className="filter-bar" role="group" aria-label="Pull request involvement">
            {([['all', 'All open'], ['mine', 'Authored by me'], ['assigned', 'Assigned to me'], ['review', 'Review requested']] as const).map(([value, label]) => (
              <button key={value} className={involvement === value ? "active" : ""} onClick={() => setInvolvement(value)}>{label}</button>
            ))}
          </div>
          <div className="pr-list">
            {loadingPulls && <div className="empty-state"><span className="spinner" />Loading pull requests…</div>}
            {!loadingPulls && selectedRepo && filteredPulls.map((pull) => (
              <button className="pr-row" key={pull.number} onClick={() => onOpen(selectedRepo, pull.number)}>
                <div className="pr-number">#{pull.number}</div>
                <div className="pr-main">
                  <div className="pr-title-row"><strong>{pull.title}</strong>{pull.draft && <span className="draft-badge">Draft</span>}</div>
                  <div className="pr-meta">
                    <span>opened by</span><People people={[pull.author]} />
                    <span className="dot">·</span><span>opened {timeAgo(pull.createdAt)}</span>
                    {!sameMoment(pull.createdAt, pull.updatedAt) && <><span className="dot">·</span><span>updated {timeAgo(pull.updatedAt)}</span></>}
                    <span className="branch"><GitBranch size={12} />{pull.head} → {pull.base}</span>
                    {(pull.additions > 0 || pull.deletions > 0 || pull.changedFiles > 0) && (
                      <span className="pr-size"><span className="additions">+{pull.additions}</span><span className="deletions">−{pull.deletions}</span><span>{pull.changedFiles} files</span></span>
                    )}
                  </div>
                  <div className="assignment-row">
                    <span><UserRoundCheck size={13} /> Assigned</span><People people={pull.assignees} />
                    <span><MessageSquare size={13} /> Reviewers</span><People people={pull.requestedReviewers} empty="None requested" />
                  </div>
                </div>
                <ChevronRight size={18} />
              </button>
            ))}
            {!loadingPulls && selectedRepo && filteredPulls.length === 0 && <div className="empty-state">No open pull requests match these filters.</div>}
          </div>
        </div>
      </section>
    </main>
  );
}

/** How a step's files read in the timeline and narration: one path, or the basenames of several. */
function stepFilesLabel(chunk: ReplayChunk): string {
  const paths = chunk.files ?? chunkFiles(chunk);
  if (!paths.length) return "Checkpoint";
  if (paths.length === 1) return paths[0];
  return paths.map((path) => path.slice(path.lastIndexOf("/") + 1)).join(", ");
}

function ReplayFileView({
  file,
  step,
  currentRanges,
  replayChunks,
  changeSteps,
  showFullDiff,
  contentRepo,
  contentRef,
  comments,
  findings,
  onAdd,
  onAddFinding,
  onUpdate,
  onDelete,
  onGoToStep,
  hidden = false,
  localContent,
  resolveComment,
  onHistoricalComment,
  commentingDisabled = false,
}: {
  file: DiffFile;
  step: number;
  /** The current step's ranges, across every file; only this file's apply here. */
  currentRanges: readonly ReplayRange[];
  replayChunks: ReplayChunk[];
  changeSteps: ReadonlyMap<number, number>;
  showFullDiff: boolean;
  contentRepo: string;
  contentRef: string;
  comments: PendingComment[];
  findings: ReviewFinding[];
  onAdd: (comment: Omit<PendingComment, "id">) => void;
  onAddFinding: (finding: ReviewFinding) => void;
  onUpdate: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onGoToStep: (step: number, file: string) => void;
  /** Keeps the view mounted, with its composer and expanded context, while another file's tab is active. */
  hidden?: boolean;
  localContent?: string;
  resolveComment?: (line: DiffLine) => ReviewAnchor | null;
  onHistoricalComment?: (line: number, side: "LEFT" | "RIGHT", body: string) => void;
  commentingDisabled?: boolean;
}) {
  const [target, setTarget] = useState<{ path: string; line: number; side: "LEFT" | "RIGHT"; index: number | null; historical: boolean } | null>(null);
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
  const fileRanges = useMemo(() => currentRanges.filter((range) => range.file === file.path), [currentRanges, file.path]);
  const visibleHunks = file.hunks
    .map((hunk, originalIndex) => ({
      ...hunk,
      originalIndex,
      sourceLines: hunk.lines,
      // Keep every row in the active hunk mounted so adjacent replay steps do
      // not make the line-number geometry jump. Future code is masked below.
      lines: hunk.lines,
    }))
    .filter((hunk) => showFullDiff || hunk.sourceLines.some((line) => inRanges(fileRanges, line.changedIndex)));
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
    const { content } = localContent !== undefined ? { content: localContent } : await api<{ content: string }>(`/api/github/file?${query}`);
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

  const commentTarget = (line: DiffLine) => {
    const resolved = resolveComment?.(line);
    return {
    path: resolved?.path ?? file.path,
    historical: !!resolveComment && !resolved,
    line: resolved?.line ?? (line.type === "delete" ? line.oldLine : line.newLine),
    side: resolved?.side ?? (line.type === "delete" ? "LEFT" as const : "RIGHT" as const),
    index: line.changedIndex,
  }; };
  const submitComment = () => {
    if (!target?.line || !body.trim()) return;
    if (target.historical) onHistoricalComment?.(target.line, target.side, body.trim());
    else onAdd({ path: target.path, line: target.line, side: target.side, body: body.trim(), step });
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
    <article className="diff-file" hidden={hidden}>
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
              const current = inRanges(fileRanges, line.changedIndex);
              const lineStep = line.changedIndex === null ? undefined : changeSteps.get(line.changedIndex);
              const past = !showFullDiff && lineStep !== undefined && lineStep < step;
              const future = !showFullDiff && lineStep !== undefined && lineStep > step;
              const previousLine = hunk.lines[lineIndex - 1];
              const previousLineStep = previousLine?.changedIndex === null || previousLine?.changedIndex === undefined
                ? undefined
                : changeSteps.get(previousLine.changedIndex);
              const startsFutureGroup = future && previousLineStep !== lineStep;
              const futureChunk = lineStep === undefined ? undefined : replayChunks[lineStep];
              const anchor = commentTarget(line);
              const anchored = anchor.historical ? [] : comments.filter((comment) => comment.path === anchor.path && comment.line === anchor.line && comment.side === anchor.side);
              const anchoredFindings = anchor.historical ? [] : findingsAtNewLine(findings, anchor.path, anchor.side === "RIGHT" ? anchor.line : null);
              const composing = target?.line === anchor.line && target.side === anchor.side && target.historical === anchor.historical;
              return (
                <Fragment key={`${hunk.originalIndex}-${lineIndex}`}>
                  <div className={`diff-row ${line.type} ${current ? "current" : ""} ${past ? "past-change" : ""} ${future ? "future-change" : ""}`}>
                    {future
                      ? <span className="future-change-gutter" />
                      : <button className="add-comment" disabled={commentingDisabled} title={anchor.historical ? "Add a historical-line note to the review summary" : `Comment on PR line ${anchor.line}`} onClick={() => anchor.line && setTarget({ ...anchor, line: anchor.line })} aria-label={`${anchor.historical ? "Note on historical" : "Comment on"} line ${anchor.line}`}><span>+</span></button>}
                    <span className="line-number">{line.oldLine ?? ""}</span>
                    <span className="line-number">{line.newLine ?? ""}</span>
                    {future ? (
                      <code className="future-change-note">
                        {startsFutureGroup && futureChunk ? (
                          <button onClick={() => onGoToStep(lineStep, file.path)} title={`Go to Step ${lineStep + 1}: ${futureChunk.title}`}>
                            <ArrowRight size={11} /> Later in Step {lineStep + 1} <span>· {futureChunk.title}</span>
                          </button>
                        ) : <span aria-hidden="true" />}
                      </code>
                    ) : (
                      <code><i>{line.type === "add" ? "+" : line.type === "delete" ? "−" : " "}</i>{renderCode(highlightedHunks[hunk.originalIndex]?.[hunk.sourceLines.indexOf(line)], line.text)}</code>
                    )}
                  </div>
                  {!future && anchoredFindings.map((finding, findingIndex) => {
                    const staged = isFindingStaged(comments, finding, [file]);
                    return (
                      <div className="inline-finding" key={`${finding.title}-${findingIndex}`}>
                        <div className="inline-finding-header">
                          <Sparkles size={13} />
                          <span className={`severity ${finding.severity}`}>{finding.severity}</span>
                          <span>{finding.category}</span>
                          <strong>{finding.title}</strong>
                          {staged
                            ? <span className="finding-staged"><Check size={11} />Added to review</span>
                            : <button className="finding-add" onClick={() => onAddFinding(finding)}>+ Add to review</button>}
                        </div>
                        <p>{finding.description}</p>
                        {finding.suggestion && <div className="inline-finding-suggestion"><span>Suggestion</span><p>{finding.suggestion}</p></div>}
                      </div>
                    );
                  })}
                  {!future && anchored.map((comment) => editingCommentId === comment.id ? (
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
                  {!future && composing && (
                    <div className="inline-composer">
                      {target?.historical && <p className="historical-comment-hint">This line is from a historical version. Your note will be included in the review summary with its file and step.</p>}
                      <textarea autoFocus value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); submitComment(); } }} placeholder={`Leave a comment on ${file.path}:${anchor.line}`} />
                      <div><button className="text-button" onClick={() => { setTarget(null); setBody(""); }}>Cancel</button><button className="primary-button compact" onClick={submitComment} disabled={!body.trim()}>{target?.historical ? "Add to review summary" : "Add pending comment"}</button></div>
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

function RecordedReviewFile({ change, canonical, pull, step, hidden, hashCache, ...actions }: {
  change: RecordedChange; canonical?: DiffFile; pull: PullRequestDetail; step: number; hidden: boolean;
  hashCache: Map<string, Promise<string>>;
  comments: PendingComment[]; findings: ReviewFinding[];
  onAdd: (comment: Omit<PendingComment, "id">) => void;
  onAddFinding: (finding: ReviewFinding) => void;
  onUpdate: (id: string, body: string) => void; onDelete: (id: string) => void;
  onGoToStep: (step: number, file: string) => void;
  onHistoricalComment: (line: number, side: "LEFT" | "RIGHT", body: string) => void;
}) {
  const file = useMemo(() => recordedChangeDiff(change), [change]);
  const [verified, setVerified] = useState<{ baseHash?: string; headHash?: string } | null>(null);
  const [verificationError, setVerificationError] = useState(false);
  useEffect(() => {
    if (hidden) return;
    let active = true;
    async function hash(repo: string, ref: string, path: string) {
      const query = new URLSearchParams({ repo, ref, path }).toString();
      if (!hashCache.has(query)) hashCache.set(query, api<{ content: string }>(`/api/github/file?${query}`).then(({ content }) => contentHash(content)).catch((error) => { hashCache.delete(query); throw error; }));
      return hashCache.get(query)!;
    }
    const check = async () => {
      if (!canonical) { if (active) setVerified({}); return; }
      const results = await Promise.allSettled([
        canonical.status !== "added" ? hash(pull.baseRepo, pull.baseSha, canonical.oldPath ?? canonical.path) : Promise.resolve(undefined),
        canonical.status !== "deleted" ? hash(pull.headRepo, pull.headSha, canonical.path) : Promise.resolve(undefined),
      ]);
      if (!active) return;
      setVerified({ baseHash: results[0].status === "fulfilled" ? results[0].value : undefined, headHash: results[1].status === "fulfilled" ? results[1].value : undefined });
      setVerificationError(results.some((result) => result.status === "rejected"));
    };
    void check();
    return () => { active = false; };
  }, [canonical, hashCache, hidden, pull.baseRepo, pull.baseSha, pull.headRepo, pull.headSha]);
  return <div hidden={hidden}>
    {verificationError && <p className="recording-review-notice">PR line verification is unavailable for this file. Comments will be added to the review summary.</p>}
    {!file.hunks.length ? <p className="recording-review-notice"><code>{change.path}</code>: {file.status}; no visible line changes (empty file or line-ending change).</p> : <ReplayFileView {...actions} file={file} step={step} currentRanges={[{ file: file.path, start: 1, end: file.hunks.flatMap((hunk) => hunk.lines).filter((line) => line.changedIndex !== null).length }]} replayChunks={[]} changeSteps={new Map()} showFullDiff contentRepo="" contentRef="" localContent={change.after?.content ?? change.before?.content ?? ""} resolveComment={(line) => recordedLineAnchor(change, line, canonical, verified ?? {})} commentingDisabled={verified === null} />}
  </div>;
}

function ReviewSidebar({
  repo,
  pull,
  comments,
  files,
  aiReview,
  aiReviewBusy,
  aiReviewError,
  scoutModel,
  reviewerModel,
  event,
  summary,
  onRequestAiReview,
  onScoutModelChange,
  onReviewerModelChange,
  onAddFinding,
  onAddAllFindings,
  onGoToFinding,
  onEventChange,
  onSummaryChange,
  onUpdateComment,
  onDeleteComment,
  onSubmitted,
  onMerged,
}: {
  repo: string;
  pull: PullRequestDetail;
  comments: PendingComment[];
  files: DiffFile[];
  aiReview: AiReviewResult | null;
  aiReviewBusy: boolean;
  aiReviewError: string | null;
  scoutModel: string;
  reviewerModel: string;
  event: ReviewEvent;
  summary: string;
  onRequestAiReview: () => void;
  onScoutModelChange: (model: string) => void;
  onReviewerModelChange: (model: string) => void;
  onAddFinding: (finding: ReviewFinding) => void;
  onAddAllFindings: (findings: ReviewFinding[]) => void;
  onGoToFinding: (finding: ReviewFinding) => void;
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
        body: JSON.stringify({ repo, number: pull.number, event, body: summary, commitId: pull.headSha, comments }),
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
        body: JSON.stringify({ repo, number: pull.number, method: mergeMethod, sha: pull.headSha }),
      });
      setMessage("Pull request merged on GitHub."); setConfirmMerge(false); onMerged();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Merge failed."); }
    finally { setMergeBusy(false); }
  };

  const mergeLabel = pull.merged ? "Merged" : pull.state === "closed" ? "Closed" : pull.draft ? "Draft" : pull.mergeable === false ? "Conflicts" : pull.mergeable === null ? "Checking" : "Ready to merge";
  const mergeTone = pull.merged ? "purple" : pull.mergeable === false ? "red" : pull.mergeable === true ? "green" : "amber";
  const canAttemptMerge = pull.state === "open" && !pull.draft && pull.mergeable !== false && pull.allowedMergeMethods.length > 0;
  const findings = sortFindings(aiReview?.findings ?? []);
  const readyFindings = findings.filter((finding) => {
    const anchor = findingAnchor(files, finding);
    return anchor && !isFindingStaged(comments, finding, files);
  });

  return (
    <aside className="review-sidebar">
      <section className="review-section ai-review-section">
        <div className="section-title"><span><Sparkles size={13} /> AI review</span>{aiReview && <em>{findings.length}</em>}</div>
        {!aiReview ? (
          <>
            <p className="sidebar-empty">A scout triages the diff, then a reviewer returns only high-confidence, actionable findings.</p>
            <div className="ai-models">
              <label><span>Scout model</span><input value={scoutModel} onChange={(event) => onScoutModelChange(event.target.value)} spellCheck={false} /></label>
              <label><span>Reviewer model</span><input value={reviewerModel} onChange={(event) => onReviewerModelChange(event.target.value)} spellCheck={false} /></label>
            </div>
            {aiReviewError && <div className="ai-review-error"><XCircle size={13} />{aiReviewError}</div>}
            <button className="ai-review-button" onClick={onRequestAiReview} disabled={aiReviewBusy || !scoutModel.trim() || !reviewerModel.trim()}>
              {aiReviewBusy ? <><span className="spinner" />Scout and reviewer are analyzing…</> : <><Sparkles size={14} />Request AI review</>}
            </button>
          </>
        ) : (
          <>
            <div className="ai-review-meta"><span>Scout <code>{aiReview.scoutModel}</code></span><span>Reviewer <code>{aiReview.reviewerModel}</code></span></div>
            {aiReview.truncated && <p className="ai-review-warning">The diff was truncated for the models, so coverage may be incomplete.</p>}
            <p className="ai-review-summary">{aiReview.summary || "No summary returned."}</p>
            {aiReview.scout.intent && (
              <details className="scout-details">
                <summary>Scout triage · {aiReview.scout.focusAreas.length} focus area{aiReview.scout.focusAreas.length === 1 ? "" : "s"}</summary>
                <p>{aiReview.scout.intent}</p>
                {aiReview.scout.focusAreas.map((area, index) => <div className="focus-area" key={`${area.file}-${index}`}><span className={`risk ${area.risk}`}>{area.risk}</span><code>{area.file}</code><p>{area.reason}</p></div>)}
              </details>
            )}
            <div className="findings-heading"><span>{findings.length} finding{findings.length === 1 ? "" : "s"}</span>{readyFindings.length > 0 && <button onClick={() => onAddAllFindings(readyFindings)}>Add all {readyFindings.length}</button>}</div>
            {!findings.length && <p className="sidebar-empty no-findings"><CheckCircle2 size={14} />The reviewer had nothing high-confidence to report.</p>}
            <div className="finding-list">
              {findings.map((finding, index) => {
                const anchor = findingAnchor(files, finding);
                const staged = !!anchor && isFindingStaged(comments, finding, files);
                return <article className="finding-card" key={`${finding.file}-${finding.line}-${index}`}>
                  <div className="finding-labels"><span className={`severity ${finding.severity}`}>{finding.severity}</span><span>{finding.category}</span></div>
                  <button className="finding-jump" onClick={() => onGoToFinding(finding)}><strong>{finding.title}</strong><code>{finding.file}:{finding.line}</code></button>
                  <p>{finding.description}</p>
                  {finding.suggestion && <div className="finding-suggestion"><span>Suggestion</span><p>{finding.suggestion}</p></div>}
                  {staged ? <span className="finding-staged"><Check size={11} />Added to review</span> : anchor ? <button className="finding-add" onClick={() => onAddFinding(finding)}>+ Add to review</button> : <span className="finding-unanchored">Not on a diff line</span>}
                </article>;
              })}
            </div>
            {aiReviewError && <div className="ai-review-error"><XCircle size={13} />{aiReviewError}</div>}
            <button className="text-button ai-rerun" onClick={onRequestAiReview} disabled={aiReviewBusy}>{aiReviewBusy ? "Reviewing again…" : "Run review again"}</button>
          </>
        )}
      </section>
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

type BuildStage = "contacting" | "reconstructing" | "ordering";

function buildStageLabel(stage: BuildStage, chars: number, model: string): string {
  if (stage === "contacting") return `Contacting ${model}…`;
  if (stage === "ordering") return "Ordering the steps…";
  const size = chars < 1000 ? `${chars}` : `${(chars / 1000).toFixed(1)}k`;
  return `Reconstructing — ${size} characters so far…`;
}

type RecordingAttachment = { recording: Recording; name: string; headSha: string; origin: "upload" | "repository" | "gist"; url?: string };

function ReplayWorkspace({ repo, number, initialStep, defaultModel, defaultScoutModel, defaultReviewerModel, viewer, aiAvailable, onStepChange, onBack }: { repo: string; number: number; initialStep: number | null; defaultModel: string; defaultScoutModel: string; defaultReviewerModel: string; viewer: string; aiAvailable: boolean; onStepChange: (step: number) => void; onBack: () => void }) {
  const [pull, setPull] = useState<PullRequestDetail | null>(null);
  const [replay, setReplay] = useState<ReplayResult | null>(null);
  const [attachment, setAttachment] = useState<RecordingAttachment | null>(null);
  const [linkedRecording, setLinkedRecording] = useState<RecordingAttachment | null>(null);
  const [recordingBusy, setRecordingBusy] = useState(true);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const recordingInputRef = useRef<HTMLInputElement>(null);
  const [recordingHashCache] = useState(() => new Map<string, Promise<string>>());
  const aiReplayRef = useRef<ReplayResult | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [comments, setComments] = useState<PendingComment[]>([]);
  const [reviewEvent, setReviewEvent] = useState<ReviewEvent>("COMMENT");
  const [reviewSummary, setReviewSummary] = useState("");
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [buildStage, setBuildStage] = useState<BuildStage>("contacting");
  const [buildChars, setBuildChars] = useState(0);
  const [buildElapsed, setBuildElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState(defaultModel);
  const [scoutModel, setScoutModel] = useState(defaultScoutModel);
  const [reviewerModel, setReviewerModel] = useState(defaultReviewerModel);
  const [aiReview, setAiReview] = useState<AiReviewResult | null>(null);
  const [aiReviewBusy, setAiReviewBusy] = useState(false);
  const [aiReviewError, setAiReviewError] = useState<string | null>(null);
  const [showFullDiff, setShowFullDiff] = useState(false);
  // The file tab chosen for one step; any other step falls back to its first file.
  const [fileTab, setFileTab] = useState<{ step: number; file: string } | null>(null);
  const [stateReady, setStateReady] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLOListElement>(null);
  const stateRevisionRef = useRef(0);
  const buildAbortRef = useRef<AbortController | null>(null);
  // The deep-linked step is read once: later step changes only rewrite the URL.
  const bootStepRef = useRef(initialStep);
  const cacheKey = useMemo(() => reviewCacheKey(viewer, repo, number), [viewer, repo, number]);

  const refreshPull = async () => {
    const { pull } = await api<{ pull: PullRequestDetail }>(`/api/github/pull?repo=${encodeURIComponent(repo)}&number=${number}`);
    setPull(pull);
  };
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const { pull } = await api<{ pull: PullRequestDetail }>(`/api/github/pull?repo=${encodeURIComponent(repo)}&number=${number}`);
        if (!active) return;
        setPull(pull);
        let cached: PullRequestState | null = null;
        try {
          const remote = await api<{ state: PullRequestState | null; revision: number }>(
            `/api/state?repo=${encodeURIComponent(repo)}&number=${number}&headSha=${encodeURIComponent(pull.headSha)}`,
          );
          cached = remote.state;
          stateRevisionRef.current = remote.revision;
        } catch {
          // A local draft remains usable when the persistent store is temporarily unavailable.
        }
        if (!cached) {
          try {
            const legacy = loadInProgressReview(window.localStorage, cacheKey, pull.headSha);
            cached = legacy ? migrateInProgressReview(legacy) : null;
          }
          catch { /* Browser privacy settings must not block review work. */ }
        }
        if (!active) return;
        if (cached) {
          setReplay(upgradeReplay(cached.replay));
          if (cached.replay.source !== "recording") aiReplayRef.current = upgradeReplay(cached.replay);
          const restored = bootStepRef.current === null ? cached.step : bootStepRef.current - 1;
          setStep(Math.max(0, Math.min(restored, cached.replay.chunks.length - 1)));
          setComments(cached.review?.comments ?? []);
          setReviewSummary(cached.review?.summary ?? "");
          setReviewEvent(cached.review?.event ?? "COMMENT");
          setModel(cached.model);
          setShowFullDiff(cached.showFullDiff);
          setAiReview(cached.aiReview ?? null);
          setScoutModel(cached.scoutModel ?? cached.aiReview?.scoutModel ?? defaultScoutModel);
          setReviewerModel(cached.reviewerModel ?? cached.aiReview?.reviewerModel ?? defaultReviewerModel);
        }
        if (!active) return;
        setStateReady(true);
        setLoading(false);
        try {
          const result = await api<{ source: string | null; path: string; headSha: string; origin: "repository" | "gist"; url?: string }>(`/api/github/recording?${new URLSearchParams({ repo, number: String(number), headSha: pull.headSha })}`);
          if (result.source !== null) {
            const recording = await parseRecording(result.source);
            if (!active) return;
            const found: RecordingAttachment = { recording, name: result.path, origin: result.origin, url: result.url, headSha: result.headSha };
            setLinkedRecording(found);
            if (!cached || cached.replay.recordingId === recording.session.id) {
              setAttachment(found);
              setReplay(recordingReplay(recording, found.name));
              const restored = bootStepRef.current === null ? cached?.step ?? 0 : bootStepRef.current - 1;
              setStep(Math.max(0, Math.min(restored, recording.events.length)));
            }
          }
        } catch (error) {
          if (active) setRecordingError(error instanceof Error ? error.message : "Could not load the PR recording.");
        } finally { if (active) setRecordingBusy(false); }
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : "Could not load the pull request.");
      } finally {
        if (active) { setLoading(false); setRecordingBusy(false); }
      }
    };
    void load();
    return () => { active = false; };
  }, [repo, number, cacheKey, defaultScoutModel, defaultReviewerModel]);

  const selectRecording = (value: RecordingAttachment) => {
    if (replay && replay.source !== "recording") aiReplayRef.current = replay;
    setAttachment(value); setReplay(recordingReplay(value.recording, value.name));
    setStep(0); setFileTab(null); setPlaying(false); setShowFullDiff(false); setRecordingError(null);
  };
  const importRecording = async (file?: File) => {
    if (!file || !pull || recordingBusy) return;
    setRecordingBusy(true); setRecordingError(null); setPlaying(false);
    try {
      if (file.size > RECORDING_MAX_BYTES) throw new Error("Choose a recording smaller than 20 MB.");
      const recording = await parseRecording(await decompressRecording(await file.text()));
      selectRecording({ recording, name: file.name, headSha: pull.headSha, origin: "upload" });
    } catch (error) { setRecordingError(error instanceof Error ? error.message : "Could not read this recording."); }
    finally { setRecordingBusy(false); }
  };
  const selectAiSynopsis = () => {
    setReplay(aiReplayRef.current); setStep(0); setFileTab(null); setPlaying(false); setShowFullDiff(false);
  };
  useEffect(() => {
    // A rebuild briefly removes the replay from memory; retain the last complete
    // state until its replacement is ready.
    if (!stateReady || !pull || !replay) return;
    const state: PullRequestState = {
      headSha: pull.headSha,
      replay,
      step,
      model,
      showFullDiff,
      aiReview: aiReview ?? undefined,
      scoutModel,
      reviewerModel,
    };
    if (comments.length || reviewSummary.trim()) {
      state.review = { comments, summary: reviewSummary, event: reviewEvent };
    }
    const timer = window.setTimeout(async () => {
      const revision = Math.max(stateRevisionRef.current + 1, Date.now());
      stateRevisionRef.current = revision;
      try {
        await api("/api/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo, number, revision, state }),
        });
        try { clearInProgressReview(window.localStorage, cacheKey); } catch { /* Storage may be unavailable. */ }
      } catch {
        try {
          saveInProgressReview(window.localStorage, cacheKey, {
            ...state,
            comments: state.review?.comments ?? [],
            summary: state.review?.summary ?? "",
            event: state.review?.event ?? "COMMENT",
          });
        } catch { /* Keep the in-memory state usable. */ }
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [aiReview, cacheKey, comments, model, number, pull, replay, repo, reviewEvent, reviewSummary, reviewerModel, scoutModel, showFullDiff, stateReady, step]);
  useEffect(() => {
    if (!playing || !replay) return;
    if (step >= replay.chunks.length - 1) {
      const stop = window.setTimeout(() => setPlaying(false), 0);
      return () => window.clearTimeout(stop);
    }
    const timer = window.setTimeout(() => setStep((value) => Math.min(replay.chunks.length - 1, value + 1)), 2400);
    return () => window.clearTimeout(timer);
  }, [playing, step, replay]);
  useEffect(() => {
    if (!replay) return;
    timelineRef.current?.children.item(step)?.scrollIntoView({ block: "nearest" });
  }, [replay, step]);
  // Steps replace the current history entry, so Back leaves the replay instead
  // of walking every step of it. Waiting for the restore keeps a deep-linked
  // step in the URL until it has been applied.
  useEffect(() => {
    if (stateReady) onStepChange(replay ? step + 1 : 0);
  }, [onStepChange, replay, stateReady, step]);

  useEffect(() => {
    if (!building) return;
    const started = Date.now();
    const timer = window.setInterval(() => setBuildElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [building]);
  useEffect(() => () => buildAbortRef.current?.abort(), []);

  // The replay arrives as a stream of progress events, which the shared api()
  // helper cannot consume, so this request is made inline.
  const build = async () => {
    if (building) return;
    if (!aiAvailable) { setError("Connect OpenRouter to build an AI synopsis."); return; }
    const controller = new AbortController();
    buildAbortRef.current = controller;
    setBuilding(true); setBuildStage("contacting"); setBuildChars(0); setBuildElapsed(0); setError(null);
    try {
      const response = await authorizedFetch("/api/replay", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, number, model }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `${response.status} ${response.statusText}`);
      }
      let built: ReplayResult | null = null;
      for await (const event of readReplayEvents(response.body)) {
        if (event.type === "progress") { setBuildStage("reconstructing"); setBuildChars(event.chars); }
        else if (event.type === "parsing") setBuildStage("ordering");
        else if (event.type === "error") throw new Error(event.error);
        else built = event.replay;
      }
      if (!built) throw new Error("The replay stream ended before it finished.");
      aiReplayRef.current = built; setReplay(built); setStep(0);
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(error instanceof Error ? error.message : "Could not build replay.");
    }
    finally {
      if (buildAbortRef.current === controller) buildAbortRef.current = null;
      setBuilding(false);
    }
  };
  const cancelBuild = () => buildAbortRef.current?.abort();

  const files = useMemo(() => parseUnifiedDiff(pull?.diff ?? ""), [pull?.diff]);
  const isRecorded = replay?.source === "recording";
  const recording = isRecorded && attachment && attachment.recording.session.id === replay?.recordingId && attachment.headSha === pull?.headSha ? attachment.recording : null;
  const recordedEvent = recording?.events[step - 1];
  const chunk = replay?.chunks[step] ?? null;
  const stepFiles = useMemo(() => chunk ? chunk.files ?? chunkFiles(chunk) : [], [chunk]);
  const activeFile = fileTab?.step === step && stepFiles.includes(fileTab.file) ? fileTab.file : stepFiles[0] ?? null;
  const changeSteps = useMemo(() => replayStepMap(replay?.chunks ?? []), [replay?.chunks]);
  const aiFindings = useMemo(() => sortFindings(aiReview?.findings ?? []), [aiReview]);
  const go = (value: number, file?: string) => {
    if (!replay) return;
    const next = Math.max(0, Math.min(replay.chunks.length - 1, value));
    setPlaying(false); setStep(next);
    setFileTab(file ? { step: next, file } : null);
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const selectFileTab = (file: string) => {
    setFileTab({ step, file });
    scrollRef.current?.scrollTo({ top: 0 });
  };
  const completeReview = () => {
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
  const requestAiReview = async () => {
    if (!pull || aiReviewBusy) return;
    if (!aiAvailable) { setAiReviewError("Connect OpenRouter to run an AI review."); return; }
    setAiReviewBusy(true);
    setAiReviewError(null);
    try {
      const result = await api<{ review: AiReviewResult }>("/api/ai-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo,
          number: pull.number,
          headSha: pull.headSha,
          scoutModel,
          reviewerModel,
        }),
      });
      setAiReview(result.review);
    } catch (error) {
      setAiReviewError(error instanceof Error ? error.message : "Could not complete the AI review.");
    } finally {
      setAiReviewBusy(false);
    }
  };
  const addFinding = (finding: ReviewFinding) => {
    const anchor = findingAnchor(files, finding);
    if (!anchor) return;
    const findingStep = anchor.changedIndex === null ? step : (changeSteps.get(anchor.changedIndex) ?? step);
    const body = findingToCommentBody(finding);
    setComments((items) => items.some((comment) => comment.path === anchor.path && comment.line === anchor.line && comment.side === anchor.side && comment.body === body)
      ? items
      : [...items, { id: crypto.randomUUID(), path: anchor.path, line: anchor.line, side: anchor.side, body, step: findingStep }]);
  };
  const addAllFindings = (findings: ReviewFinding[]) => findings.forEach(addFinding);
  const goToFinding = (finding: ReviewFinding) => {
    const anchor = findingAnchor(files, finding);
    if (!anchor) return;
    if (isRecorded) { setShowFullDiff(true); return; }
    setShowFullDiff(anchor.changedIndex === null);
    if (anchor.changedIndex !== null) go(changeSteps.get(anchor.changedIndex) ?? step, anchor.path);
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
    return <main className="loading-screen"><span className="spinner large" /><strong>Loading #{number}</strong><span>{repo}</span>{error && <div className="error-banner">{error}</div>}</main>;
  }

  return (
    <main className="replay-shell">
      <header className="pr-header">
        <button className="back-button" onClick={onBack}><ArrowLeft size={16} /> Pull requests</button>
        <div className="pr-identity"><span className="open-dot" /><strong>{pull.title}</strong><span>#{pull.number}</span></div>
        <div className="pr-stats"><span className="additions">+{pull.additions}</span><span className="deletions">−{pull.deletions}</span><span>{pull.changedFiles} files</span><a href={pull.url} target="_blank" rel="noreferrer">GitHub <ExternalLink size={12} /></a></div>
      </header>
      <div className="replay-source-bar">
        <div className="diff-scope-toggle" role="group" aria-label="Replay source">
          <button className={!isRecorded ? "active" : ""} aria-pressed={!isRecorded} disabled={building || recordingBusy} onClick={selectAiSynopsis}>AI synopsis</button>
          <button className={isRecorded ? "active" : ""} aria-pressed={isRecorded} disabled={building || recordingBusy || !(attachment ?? linkedRecording)} onClick={() => { const value = attachment ?? linkedRecording; if (value) selectRecording(value); }}>Recording</button>
        </div>
        <button className="secondary-button compact" disabled={building || recordingBusy} onClick={() => recordingInputRef.current?.click()}><FileUp size={14} />{recordingBusy ? "Checking recording…" : "Attach recording"}</button>
        {linkedRecording && attachment?.origin === "upload" && <button className="text-button" onClick={() => selectRecording(linkedRecording)}>Use PR recording</button>}
        <span>{isRecorded ? replay.recordingName : linkedRecording ? "Recording found in this PR" : `Link a gist, commit ${PR_RECORDING_PATH}, or attach a file`}</span>
        {!aiAvailable && <a href="/api/auth/openrouter">Connect OpenRouter for AI</a>}
        <input ref={recordingInputRef} type="file" accept=".jsonl,.json,application/json,application/x-ndjson" hidden aria-label="Attach recording to this PR" onChange={(event) => { void importRecording(event.target.files?.[0]); event.target.value = ""; }} />
      </div>
      {recordingError && <div className="error-banner" role="alert">{recordingError}</div>}
      {isRecorded && <div className="recording-review-notice">
        {recording ? <>Recorded checkpoints · {attachment?.origin === "gist" ? <a href={attachment.url} target="_blank" rel="noreferrer">Gist linked in this PR</a> : attachment?.origin === "repository" ? `From this PR at ${pull.headSha.slice(0, 8)}` : "Attached to this PR for this tab; reattach after refreshing"}. Matching PR lines receive inline comments; historical-line notes go into the review summary.</> : <>Reattach <strong>{replay.recordingName}</strong> to resume recorded playback. Your review is restored; the full PR diff is still available.</>}
      </div>}
      {!replay ? (
        <section className="build-replay">
          <div className={`replay-illustration${building ? " building" : ""}`} aria-hidden="true">
            <div className="orbit-line" /><span className="node n1">1</span><span className="node n2">2</span><span className="node n3">3</span><span className="node n4"><Play size={17} fill="currentColor" /></span>
          </div>
          <div className="eyebrow"><RotateCcw size={13} /> Ready to reconstruct</div>
          <h2>Rewind #{pull.number}</h2>
          <p>A model will divide {pull.additions + pull.deletions} changed lines into a plausible implementation order. This is a reconstruction for comprehension—not the author&apos;s actual history.</p>
          <label className="model-field"><span>OpenRouter model</span><input value={model} onChange={(event) => setModel(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void build(); } }} spellCheck={false} /></label>
          {error && <div className="error-banner"><XCircle size={15} />{error}</div>}
          {building ? (
            <div className="build-progress">
              <div className="build-status" role="status" aria-live="polite">
                <span className="spinner" />
                <span className="build-stage">{buildStageLabel(buildStage, buildChars, model)}</span>
                <em className="build-elapsed">{buildElapsed}s</em>
              </div>
              <button type="button" className="text-button cancel-build" onClick={cancelBuild}>Cancel</button>
            </div>
          ) : (
            <button className="primary-button build-button" onClick={build} disabled={!model.trim() || !aiAvailable || recordingBusy}><Play size={15} fill="currentColor" />Build replay</button>
          )}
          <div className="pr-context"><Avatar src={pull.author.avatarUrl} alt="" size={22} /><span>Authored by <strong>@{pull.author.login}</strong></span><GitBranch size={13} /><code>{pull.head}</code><ArrowRight size={12} /><code>{pull.base}</code></div>
        </section>
      ) : (
        <div className="replay-grid">
          <aside className="timeline-panel">
            <div className="timeline-title"><span>{isRecorded ? "Recorded checkpoints" : "Reconstruction"}</span><em>{replay.chunks.length} steps</em></div>
            <ol ref={timelineRef}>
              {replay.chunks.map((item, index) => (
                <li className={`${index === step ? "active" : index < step ? "past" : ""}${item.impactful ? " impactful" : ""}`} key={index}>
                  <button onClick={() => go(index)}>
                    <span className="step-marker">
                      {index < step ? <Check size={12} /> : index + 1}
                      {item.impactful && <Star className="impact-star" size={10} fill="currentColor" aria-hidden="true" />}
                    </span>
                    <span>
                      <span className="step-title-row"><strong>{item.title}</strong>{item.impactful && <span className="impact-badge">High impact</span>}</span>
                      <code>{stepFilesLabel(item)}</code>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="timeline-model"><Sparkles size={13} /><span>{isRecorded ? "Agent explanations" : "Replayed by"}<br /><strong>{replay.model}</strong></span></div>
          </aside>
          <section className="code-stage">
            <header className="player-bar">
              <button className="icon-button" onClick={() => go(step - 1)} disabled={step === 0} aria-label="Previous replay step" aria-keyshortcuts="Meta+ArrowLeft" title="Previous step (⌘←)"><ChevronLeft size={16} /></button>
              <button className="play-button" onClick={() => { if (step === replay.chunks.length - 1) setStep(0); setPlaying((value) => !value); }}>{playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}{playing ? "Pause" : "Play"}</button>
              <button className="icon-button" onClick={() => go(step + 1)} disabled={step === replay.chunks.length - 1} aria-label="Next replay step" aria-keyshortcuts="Meta+ArrowRight" title="Next step (⌘→)"><ChevronRight size={16} /></button>
              <input type="range" min={0} max={Math.max(0, replay.chunks.length - 1)} value={step} onChange={(e) => go(Number(e.target.value))} aria-label="Replay position" />
              <strong>{step + 1} <span>/ {replay.chunks.length}</span></strong>
              {!isRecorded && <button className="rebuild-button" onClick={() => { setReplay(null); setPlaying(false); }}>Rebuild</button>}
            </header>
            {chunk && <div className="step-narration">
              <div className="step-narration-top">
                <div className="step-meta">
                  <span>Step {step + 1}</span>
                  {chunk.impactful && <span className="impact-label"><Star size={10} fill="currentColor" aria-hidden="true" />High impact</span>}
                  <code>{stepFilesLabel(chunk)}</code>
                </div>
                <div className="diff-scope-toggle" role="group" aria-label="Diff scope">
                  <button className={!showFullDiff ? "active" : ""} onClick={() => setShowFullDiff(false)} aria-pressed={!showFullDiff}>This step</button>
                  <button className={showFullDiff ? "active" : ""} onClick={() => setShowFullDiff(true)} aria-pressed={showFullDiff}>Full PR</button>
                </div>
              </div>
              <h2>{chunk.title}</h2><p>{chunk.description}</p>
            </div>}
            {chunk && !showFullDiff && stepFiles.length > 0 && (
              <div className="file-tabs" role="tablist" aria-label="Files in this step">
                {stepFiles.map((path) => {
                  const lines = chunk.ranges.filter((range) => range.file === path).reduce((sum, range) => sum + range.end - range.start + 1, 0);
                  const pending = comments.filter((comment) => comment.path === path).length;
                  const slash = path.lastIndexOf("/");
                  return (
                    <button key={path} role="tab" aria-selected={path === activeFile} className={path === activeFile ? "active" : ""} onClick={() => selectFileTab(path)} title={path}>
                      <code>{slash >= 0 && <span>{path.slice(0, slash + 1)}</span>}{path.slice(slash + 1)}</code>
                      {!isRecorded && <em>{lines} {lines === 1 ? "line" : "lines"}</em>}
                      {pending > 0 && <span className="tab-pending"><MessageSquare size={10} />{pending}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="diff-scroll" ref={scrollRef}>
              {isRecorded && !showFullDiff ? <>
                {!recording ? <p className="recording-review-notice">Attach the original recording to see its file changes, or select Full PR to keep reviewing.</p> : <>
                  {step === 0 && <p className="recording-review-notice">Starting snapshot · scope: {recording.session.scope.join(", ")}. Select the next step to review the first changes.</p>}
                  {(recordedEvent?.omitted ?? recording.session.omitted).length > 0 && <details className="recording-review-evidence"><summary>Omitted files at this checkpoint</summary><ul>{(recordedEvent?.omitted ?? recording.session.omitted).map((entry) => <li key={entry.path}><code>{entry.path}</code> — {entry.reason}</li>)}</ul></details>}
                  {recordedEvent?.command && <details className="recording-review-evidence" open><summary>Command result · {recordedEvent.command.exitCode === 0 ? "Passed" : "Failed"}{recordedEvent.command.signal ? ` (${recordedEvent.command.signal})` : ""}</summary><pre>{recordedEvent.command.argv.map((arg) => JSON.stringify(arg)).join(" ")}</pre><pre>{recordedEvent.command.output || "(no output)"}</pre>{recordedEvent.command.truncated && <p>Output truncated by the recorder.</p>}</details>}
                  {recordedEvent && !recordedEvent.changes.length && <p className="recording-review-notice">No file changes at this checkpoint. You can add a note in the review summary or review the full PR.</p>}
                  {recordedEvent?.changes.map((change) => <RecordedReviewFile key={`${recording.session.id}-${step}-${change.path}`} change={change} canonical={files.find((file) => file.path === change.path || file.oldPath === change.path)} pull={pull} step={step} hidden={change.path !== activeFile} hashCache={recordingHashCache} comments={comments} findings={aiFindings} onAdd={(comment) => setComments((items) => [...items, { ...comment, id: crypto.randomUUID() }])} onAddFinding={addFinding} onUpdate={updateComment} onDelete={deleteComment} onGoToStep={go} onHistoricalComment={(line, side, body) => setReviewSummary((current) => [current.trim(), historicalReviewNote(recordedEvent, change.path, line, side, body)].filter(Boolean).join("\n\n---\n\n"))} />)}
                </>}
              </> : files.map((file) => <ReplayFileView key={file.path} file={file} step={step} currentRanges={chunk?.ranges ?? []} hidden={!showFullDiff && file.path !== activeFile} replayChunks={replay.chunks} changeSteps={changeSteps} showFullDiff={showFullDiff} contentRepo={file.status === "deleted" ? pull.baseRepo : pull.headRepo} contentRef={file.status === "deleted" ? pull.baseSha : pull.headSha} comments={comments} findings={aiFindings} onAdd={(comment) => setComments((items) => [...items, { ...comment, id: crypto.randomUUID() }])} onAddFinding={addFinding} onUpdate={updateComment} onDelete={deleteComment} onGoToStep={go} />)}
            </div>
          </section>
          <ReviewSidebar repo={repo} pull={pull} files={files} comments={comments} aiReview={aiReview} aiReviewBusy={aiReviewBusy} aiReviewError={aiReviewError} scoutModel={scoutModel} reviewerModel={reviewerModel} event={reviewEvent} summary={reviewSummary} onRequestAiReview={() => void requestAiReview()} onScoutModelChange={setScoutModel} onReviewerModelChange={setReviewerModel} onAddFinding={addFinding} onAddAllFindings={addAllFindings} onGoToFinding={goToFinding} onEventChange={setReviewEvent} onSummaryChange={setReviewSummary} onUpdateComment={updateComment} onDeleteComment={deleteComment} onSubmitted={completeReview} onMerged={() => void refreshPull()} />
        </div>
      )}
    </main>
  );
}

export default function Home() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [route, setRoute] = useState<Route>(readRoute);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const routeRef = useRef(route);

  useEffect(() => {
    api<AuthState>("/api/auth/session").then((state) => {
      if (state.github.expired) setConnectionError(SESSION_EXPIRED_MESSAGE);
      setAuth(state);
    }).catch(() => setAuth({ github: { connected: false, user: null }, openrouter: { connected: false, userId: null }, configured: { github: false }, defaults: { model: "openai/gpt-5-mini", scoutModel: "openai/gpt-5-mini", reviewerModel: "openai/gpt-5-mini" } }));
  }, []);
  useEffect(() => {
    const restore = () => {
      routeRef.current = readRoute();
      setRoute(routeRef.current);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  // Every in-app navigation writes history here and popstate only reads it
  // back, so the two directions cannot feed each other.
  const navigate = useCallback((next: Route, mode: "push" | "replace") => {
    routeRef.current = next;
    setRoute(next);
    const url = routeUrl(next);
    if (mode === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }, []);
  const selectRepo = useCallback((repo: string, mode: "push" | "replace") => navigate({ repo, pull: null, step: null }, mode), [navigate]);
  const openPull = useCallback((repo: string, pull: number) => navigate({ repo, pull, step: null }, "push"), [navigate]);
  const closePull = useCallback(() => navigate({ repo: routeRef.current.repo, pull: null, step: null }, "push"), [navigate]);
  const syncStep = useCallback((step: number) => navigate({ ...routeRef.current, step }, "replace"), [navigate]);
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
    setConnectionError(SESSION_EXPIRED_MESSAGE);
    setAuth((current) => current ? {
      ...current,
      github: { connected: false, user: null, expired: true },
    } : current);
  }, []);
  // Any request whose 401 survived a session refresh lands here, whichever
  // screen made it.
  useEffect(() => onGithubSessionExpired(requireGithubReconnect), [requireGithubReconnect]);
  // A tab left open overnight re-checks (and refreshes) the session when it
  // regains focus, so the first click after a break does not hit a dead token.
  const githubConnected = auth?.github.connected ?? false;
  useEffect(() => {
    if (!githubConnected) return;
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
      if (hiddenAt === null || Date.now() - hiddenAt < SESSION_RECHECK_AFTER_MS) return;
      hiddenAt = null;
      api<AuthState>("/api/auth/session")
        .then((state) => { if (!state.github.connected) requireGithubReconnect(); })
        .catch(() => { /* A failed check changes nothing; the next request recovers on its own. */ });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [githubConnected, requireGithubReconnect]);
  if (!auth) return <main className="loading-screen"><span className="spinner large" /><strong>Opening Chronosphere</strong></main>;
  const ready = auth.github.connected && auth.github.user;
  return (
    <div className="app-frame">
      <AppHeader auth={auth} onToggleTheme={toggleTheme} onLogout={logout} />
      {!ready ? <ConnectionGate auth={auth} connectionError={connectionError} /> : route.repo && route.pull ? <ReplayWorkspace key={`${route.repo}#${route.pull}`} repo={route.repo} number={route.pull} initialStep={route.step} defaultModel={auth.defaults.model} defaultScoutModel={auth.defaults.scoutModel} defaultReviewerModel={auth.defaults.reviewerModel} viewer={auth.github.user!.login} aiAvailable={auth.openrouter.connected} onStepChange={syncStep} onBack={closePull} /> : <RepositoryPicker viewer={auth.github.user!} selectedRepo={route.repo} onSelectRepo={selectRepo} onOpen={openPull} />}
    </div>
  );
}
