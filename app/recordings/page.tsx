"use client";

import { decompressRecording } from "@/lib/recording-transport";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, FileUp, Pause, Play } from "lucide-react";
import Link from "next/link";
import { parseRecording, recordingStateAt, RECORDING_MAX_BYTES, type Recording, type RecordedFile } from "@/lib/recording";

function FileContent({ file, label }: { file: RecordedFile | null; label: string }) {
  return <section className="recording-source"><h3>{label}</h3>{file ? <pre tabIndex={0} aria-label={label}><code>{file.content || "(empty file)"}</code></pre> : <p className="recording-absent">File does not exist</p>}</section>;
}

export default function RecordingsPage() {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<"changes" | "workspace">("changes");
  const [selectedPath, setSelectedPath] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const importRequest = useRef(0);
  const state = useMemo(() => recording ? recordingStateAt(recording, step) : new Map<string, RecordedFile>(), [recording, step]);
  const event = recording?.events[step - 1];
  const paths = useMemo(() => [...state.keys()].sort(), [state]);
  const activePath = state.has(selectedPath) ? selectedPath : paths[0];
  const lastStep = recording?.events.length ?? 0;
  const omissions = event?.omitted ?? recording?.session.omitted ?? [];
  const completed = recording?.events.at(-1)?.type === "finish";

  useEffect(() => {
    if (!playing || step >= lastStep) return;
    const timer = window.setTimeout(() => {
      setStep((value) => value + 1);
      if (step + 1 >= lastStep) setPlaying(false);
    }, 2200);
    return () => window.clearTimeout(timer);
  }, [playing, step, lastStep]);

  function go(next: number) { setPlaying(false); setStep(Math.max(0, Math.min(lastStep, next))); }
  async function load(file?: File) {
    if (!file) return;
    const request = ++importRequest.current;
    setBusy(true); setError(null); setPlaying(false);
    try {
      if (file.size > RECORDING_MAX_BYTES) throw new Error("Choose a recording smaller than 20 MB.");
      const result = await parseRecording(await decompressRecording(await file.text()));
      if (request !== importRequest.current) return;
      setRecording(result); setStep(0); setSelectedPath(""); setView("changes");
    } catch (error) {
      if (request === importRequest.current) setError(error instanceof Error ? error.message : "Could not read this recording.");
    } finally { if (request === importRequest.current) setBusy(false); }
  }

  return <div className="app-frame recording-app">
    <header className="app-header">
      <Link className="recording-home" href="/"><ArrowLeft size={16} />Chronosphere</Link>
      <div className="header-right"><span className="recording-badge">Local experiment</span><button className="secondary-button" disabled={busy} onClick={() => fileInput.current?.click()}><FileUp size={16} />{busy ? "Checking recording…" : "Open recording"}</button></div>
      <input ref={fileInput} type="file" accept=".jsonl,.json,application/json,application/x-ndjson" hidden aria-label="Open recording file" onChange={(event) => { void load(event.target.files?.[0]); event.target.value = ""; }} />
    </header>
    {error && <div className="recording-error" role="alert">{error}</div>}
    {!recording ? <main className="recording-empty">
      <span className="recording-badge">Recorded checkpoints</span>
      <h1>Watch the changes as they happened.</h1>
      <p>Open a local recording to explore edits, explanations, and command results—including changes that were later undone.</p>
      <button className="primary-button" disabled={busy} onClick={() => fileInput.current?.click()}><FileUp size={17} />{busy ? "Checking recording…" : "Choose a recording"}</button>
      <p className="recording-privacy">The file stays in this browser tab. No upload, account, or AI connection is needed.</p>
      <p><a className="recording-home" href="https://github.com/trezm/chronosphere-skills" target="_blank" rel="noreferrer">Get agent skills to record your work or reconstruct a PR</a></p>
      <details className="recording-instructions"><summary>Create a recording</summary><p>In the Chronosphere checkout, start a session before editing:</p><pre><code>{`npm run record -- start --title 'My change'\n\n# After an edit, use the session path printed above:\nnpm run record -- checkpoint --session SESSION.jsonl \\\n  --title 'Add validation' --reason 'Reject invalid input early'`}</code></pre><p>Or run <code>npm run record:demo</code> for a small session with a failed test and a fix.</p></details>
    </main> : <main className="recording-main">
      <section className="recording-heading">
        <div><h1>{recording.session.title}</h1><p>{recording.session.repository.name} · {recording.session.repository.branch ?? "Detached or unborn branch"} · {new Date(recording.session.createdAt).toLocaleString()}</p></div>
        <span className="recording-badge">{completed ? "Finished session" : "Open session"}</span>
      </section>
      <div className="recording-notice">Ordered checkpoints of local files. Edits between checkpoints are not observed; explanations are supplied by the agent. {completed ? "" : "This file has no finish event and may be a partial session."}</div>
      <div className="recording-layout">
        <aside className="recording-timeline" aria-label="Recorded checkpoints">
          <h2>Recording <span>{lastStep} events</span></h2>
          <ol>
            <li><button aria-current={step === 0 ? "step" : undefined} onClick={() => go(0)}><span>0</span><div><strong>Starting snapshot</strong><small>{Object.keys(recording.session.baseline).length} text files</small></div></button></li>
            {recording.events.map((item, index) => <li key={item.id}><button aria-current={step === index + 1 ? "step" : undefined} onClick={() => go(index + 1)}><span>{item.sequence}</span><div><strong>{item.title}</strong><small>{item.type === "command" ? item.command?.exitCode === 0 ? "Command passed" : "Command failed" : item.type === "finish" ? "Session finished" : `${item.changes.length} files changed`}</small></div></button></li>)}
          </ol>
        </aside>
        <section className="recording-stage" aria-label="Checkpoint details">
          <div className="recording-player">
            <button className="icon-button" aria-label="Previous checkpoint" onClick={() => go(step - 1)} disabled={step === 0}><ChevronLeft size={18} /></button>
            <button className="secondary-button" disabled={!lastStep} onClick={() => { if (step === lastStep) setStep(0); setPlaying((value) => !value); }}>{playing ? <Pause size={16} /> : <Play size={16} />}{playing ? "Pause" : "Play"}</button>
            <button className="icon-button" aria-label="Next checkpoint" onClick={() => go(step + 1)} disabled={step === lastStep}><ChevronRight size={18} /></button>
            <input type="range" min={0} max={lastStep} value={step} onChange={(event) => go(Number(event.target.value))} aria-label="Recording position" />
            <span>{step} / {lastStep}</span>
          </div>
          <div className="recording-detail">
            <h2>{event?.title ?? "Starting snapshot"}</h2>
            {event ? <><p className="recording-caption">Agent explanation · {new Date(event.recordedAt).toLocaleTimeString()}</p><p className="recording-reason">{event.reason}</p></> : <p className="recording-reason">Files as they existed when recording began. Scope: {recording.session.scope.join(", ")}. Earlier edits are not part of this recording.</p>}
            {omissions.length > 0 && <details className="recording-omissions"><summary>{omissions.length} files omitted at this checkpoint</summary><p>These files are outside the captured text state. Any previously captured version stays at its last observed content.</p><ul>{omissions.map((item) => <li key={item.path}><code>{item.path}</code> — {item.reason}</li>)}</ul></details>}
            {event?.command && <section className="recording-command"><h3>Command result <span className={event.command.exitCode === 0 ? "recording-pass" : "recording-fail"}>{event.command.signal ? `Signal ${event.command.signal}` : `Exit ${event.command.exitCode ?? "unknown"}`}</span></h3><pre><code>{event.command.argv.map((arg) => JSON.stringify(arg)).join(" ")}</code></pre><pre tabIndex={0} aria-label="Command output"><code>{event.command.output || "(no output)"}</code></pre>{event.command.truncated && <p>Output truncated by the recorder.</p>}</section>}
            <div className="recording-view-switch" role="group" aria-label="File view"><button aria-pressed={view === "changes"} onClick={() => setView("changes")}>Changes at this step</button><button aria-pressed={view === "workspace"} onClick={() => setView("workspace")}>Workspace at this step</button></div>
            {view === "workspace" || !event ? <div className="recording-workspace">
              {paths.length ? <><label>File <select value={activePath} onChange={(event) => setSelectedPath(event.target.value)}>{paths.map((path) => <option key={path} value={path}>{path}</option>)}</select></label><FileContent file={state.get(activePath) ?? null} label={activePath} /></> : <p>No captured files exist at this step.</p>}
            </div> : event.changes.length ? event.changes.map((change) => <article className="recording-change" key={change.path}><h3><code>{change.path}</code><span>{change.before === null ? "Added" : change.after === null ? "Deleted" : "Modified"}</span></h3><div className="recording-file-pair"><FileContent file={change.before} label="Before" /><FileContent file={change.after} label="After" /></div></article>) : <p className="recording-no-changes">No file changes at this checkpoint.</p>}
          </div>
        </section>
      </div>
    </main>}
  </div>;
}
