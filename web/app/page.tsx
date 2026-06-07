"use client";

import { useState, useEffect, useRef } from "react";

// ── types ──────────────────────────────────────────────────────────────────────
interface FileEntry {
  filename: string;
  class_name: string;
  ingested_at: string;
}
interface Source {
  filename: string;
  class_name: string;
  chunk_index: number;
}
interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
}

// ── api helpers ────────────────────────────────────────────────────────────────
async function apiGet(path: string) {
  const res = await fetch(`/api/${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ── components ─────────────────────────────────────────────────────────────────
function Cursor() {
  return (
    <span style={{
      display: "inline-block", width: 7, height: 13,
      background: "var(--amber)", marginLeft: 2, verticalAlign: "middle",
      animation: "blink 1.1s step-end infinite",
    }} />
  );
}

function Prompt({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: "var(--amber)", flexShrink: 0, userSelect: "none" }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

// ── sidebar ────────────────────────────────────────────────────────────────────
function Sidebar({
  view, setView, files, classes, chunkCount,
}: {
  view: string;
  setView: (v: string) => void;
  files: FileEntry[];
  classes: string[];
  chunkCount: number;
}) {
  return (
    <div style={{
      width: 220, flexShrink: 0,
      background: "var(--panel)",
      borderRight: "1px solid var(--line)",
      display: "flex", flexDirection: "column",
      padding: "18px 0 16px",
      overflow: "hidden",
    }}>
      {/* wordmark */}
      <div style={{
        padding: "0 16px 14px",
        borderBottom: "1px solid var(--line)",
        marginBottom: 14,
        fontSize: 11, fontWeight: 700,
        letterSpacing: "0.2em", textTransform: "uppercase",
        color: "var(--text)",
        display: "flex", alignItems: "center", gap: 7,
      }}>
        <span style={{
          width: 5, height: 5, borderRadius: "50%",
          background: "var(--amber)", flexShrink: 0,
        }} />
        claudia
      </div>

      {/* nav */}
      <div style={{ padding: "0 10px", marginBottom: 16 }}>
        {["chat", "upload"].map((v) => (
          <button key={v} onClick={() => setView(v)} style={{
            display: "block", width: "100%", textAlign: "left",
            padding: "5px 8px", borderRadius: 3,
            background: view === v ? "var(--line)" : "transparent",
            border: "none", cursor: "pointer",
            color: view === v ? "var(--text)" : "var(--muted)",
            fontSize: 12, fontFamily: "inherit",
            letterSpacing: "0.04em",
            transition: "background 0.1s, color 0.1s",
          }}>
            {view === v ? "> " : "  "}{v}
          </button>
        ))}
      </div>

      {/* stats */}
      <div style={{
        padding: "0 16px 12px",
        borderBottom: "1px solid var(--line)",
        marginBottom: 14,
      }}>
        <div style={{ fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>
          index
        </div>
        <div style={{ color: "var(--muted)", fontSize: 11, lineHeight: 1.8 }}>
          <span style={{ color: "var(--amber)" }}>{chunkCount}</span> chunks<br />
          <span style={{ color: "var(--amber)" }}>{files.length}</span> files<br />
          <span style={{ color: "var(--amber)" }}>{classes.length}</span> classes
        </div>
      </div>

      {/* file list */}
      <div style={{ flex: 1, overflow: "auto", padding: "0 16px" }}>
        <div style={{ fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 8 }}>
          recent
        </div>
        {files.slice(0, 20).map((f, i) => (
          <div key={i} style={{
            paddingBottom: 8, marginBottom: 8,
            borderBottom: "1px solid var(--line)",
          }}>
            <div style={{ color: "var(--text)", fontSize: 11, wordBreak: "break-all", lineHeight: 1.4 }}>
              {f.filename}
            </div>
            <div style={{ color: "var(--muted)", fontSize: 10, marginTop: 2 }}>
              {f.class_name} · {f.ingested_at.slice(0, 10)}
            </div>
          </div>
        ))}
        {files.length === 0 && (
          <div style={{ color: "var(--muted)", fontSize: 11 }}>no files yet</div>
        )}
      </div>
    </div>
  );
}

// ── chat view ──────────────────────────────────────────────────────────────────
function ChatView({ classes }: { classes: string[] }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [filterClass, setFilterClass] = useState("all");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function send() {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: q }]);
    setLoading(true);
    try {
      const res = await apiPost("chat", {
        question: q,
        class_name: filterClass === "all" ? null : filterClass,
      });
      setMessages((m) => [...m, { role: "assistant", content: res.answer, sources: res.sources }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Error reaching the API." }]);
    }
    setLoading(false);
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* header */}
      <div style={{
        padding: "12px 20px",
        borderBottom: "1px solid var(--line)",
        display: "flex", alignItems: "center", gap: 12,
        flexShrink: 0,
      }}>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>claudia:chat</span>
        {classes.length > 0 && (
          <select
            value={filterClass}
            onChange={(e) => setFilterClass(e.target.value)}
            style={{
              marginLeft: "auto",
              background: "var(--line)", border: "1px solid var(--line2)",
              borderRadius: 3, color: "var(--text)", padding: "2px 8px",
              fontSize: 11, fontFamily: "inherit", cursor: "pointer",
            }}
          >
            <option value="all">all classes</option>
            {classes.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>

      {/* messages */}
      <div style={{ flex: 1, overflow: "auto", padding: "20px 20px 8px" }}>
        {messages.length === 0 && (
          <div style={{ color: "var(--muted)", paddingTop: 40 }}>
            <Prompt label="~$">
              <span>claudia --interactive</span>
            </Prompt>
            <div style={{ marginTop: 12, color: "var(--muted)", fontSize: 11, lineHeight: 2 }}>
              ready. ask anything about your notes.<br />
              {classes.length > 0 && `${classes.length} class(es) indexed: ${classes.join(", ")}`}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: 20 }}>
            {msg.role === "user" ? (
              <Prompt label="~$">
                <span style={{ color: "var(--text)" }}>{msg.content}</span>
              </Prompt>
            ) : (
              <div style={{ paddingLeft: 20 }}>
                <div style={{
                  fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase",
                  color: "var(--amber)", marginBottom: 6,
                }}>
                  claudia
                </div>
                <div style={{ color: "var(--text)", lineHeight: 1.75, whiteSpace: "pre-wrap" }}>
                  {msg.content}
                </div>
                {msg.sources && msg.sources.length > 0 && (
                  <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {[...new Map(msg.sources.map((s) => [s.filename, s])).values()].map((s, j) => (
                      <span key={j} style={{
                        fontSize: 10, color: "var(--muted)",
                        border: "1px solid var(--line2)",
                        borderRadius: 2, padding: "1px 6px",
                        background: "var(--panel)",
                      }}>
                        {s.filename} · {s.class_name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div style={{ paddingLeft: 20, marginBottom: 20 }}>
            <div style={{ fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--amber)", marginBottom: 6 }}>claudia</div>
            <Cursor />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* input */}
      <div style={{
        padding: "12px 20px",
        borderTop: "1px solid var(--line)",
        display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
      }}>
        <span style={{ color: "var(--amber)", flexShrink: 0 }}>~$</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="ask anything…"
          disabled={loading}
          autoFocus
          style={{
            flex: 1, background: "transparent", border: "none", outline: "none",
            color: "var(--text)", fontSize: 13, fontFamily: "inherit",
            caretColor: "var(--amber)",
          }}
        />
      </div>
    </div>
  );
}

// ── upload view ────────────────────────────────────────────────────────────────
function UploadView({ onRefresh }: { onRefresh: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [className, setClassName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit() {
    if (!file) { setError("no file selected"); return; }
    if (!className.trim()) { setError("class name required"); return; }
    setError(null); setStatus(null); setLoading(true);

    const form = new FormData();
    form.append("file", file);
    form.append("class_name", className.trim());

    try {
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setStatus(`✓ ${data.filename} ingested — ${data.chunk_count} chunks (${data.class_name})`);
      setFile(null); setClassName("");
      onRefresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "upload failed");
    }
    setLoading(false);
  }

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "28px 24px" }}>
      <div style={{ maxWidth: 560 }}>
        <Prompt label="~$">
          <span style={{ color: "var(--muted)" }}>claudia --ingest</span>
        </Prompt>

        <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 18 }}>
          {/* file drop */}
          <div>
            <div style={{ fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>
              file
            </div>
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
              style={{
                border: `1px dashed ${file ? "var(--amber)" : "var(--line2)"}`,
                borderRadius: 4, padding: "20px 16px",
                cursor: "pointer", textAlign: "center",
                color: file ? "var(--text)" : "var(--muted)",
                fontSize: 12,
                background: file ? "rgba(212,160,84,0.04)" : "transparent",
                transition: "border-color 0.15s, background 0.15s",
              }}
            >
              {file ? file.name : "drop file here or click to browse"}
              <br />
              <span style={{ fontSize: 10, color: "var(--muted)" }}>pdf · png · jpg · docx</span>
            </div>
            <input
              ref={inputRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.docx"
              style={{ display: "none" }}
              onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])}
            />
          </div>

          {/* class name */}
          <div>
            <div style={{ fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>
              class / category
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ color: "var(--amber)" }}>{">"}</span>
              <input
                value={className}
                onChange={(e) => setClassName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="e.g. Biology 101, History, Work"
                style={{
                  flex: 1, background: "transparent",
                  border: "none", borderBottom: "1px solid var(--line2)",
                  outline: "none", color: "var(--text)",
                  fontSize: 13, fontFamily: "inherit",
                  padding: "4px 0", caretColor: "var(--amber)",
                }}
              />
            </div>
          </div>

          {/* submit */}
          <div>
            <button
              onClick={submit}
              disabled={loading}
              style={{
                background: "transparent",
                border: "1px solid var(--line2)",
                borderRadius: 3, padding: "6px 16px",
                color: loading ? "var(--muted)" : "var(--text)",
                fontFamily: "inherit", fontSize: 12, cursor: loading ? "not-allowed" : "pointer",
                transition: "border-color 0.15s, color 0.15s",
              }}
              onMouseEnter={(e) => { if (!loading) (e.target as HTMLElement).style.borderColor = "var(--amber)"; }}
              onMouseLeave={(e) => { (e.target as HTMLElement).style.borderColor = "var(--line2)"; }}
            >
              {loading ? "ingesting…" : "ingest file"}
            </button>
          </div>

          {/* feedback */}
          {error && (
            <div style={{ color: "var(--red)", fontSize: 12 }}>
              error: {error}
            </div>
          )}
          {status && (
            <div style={{ color: "var(--green)", fontSize: 12 }}>
              {status}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── app ────────────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState("chat");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [classes, setClasses] = useState<string[]>([]);
  const [chunkCount, setChunkCount] = useState(0);

  async function refresh() {
    try {
      const [f, c, h] = await Promise.all([
        apiGet("files"),
        apiGet("classes"),
        apiGet("health"),
      ]);
      setFiles(f.files);
      setClasses(c.classes);
      setChunkCount(h.chunks);
    } catch {}
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        <Sidebar
          view={view} setView={setView}
          files={files} classes={classes} chunkCount={chunkCount}
        />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
          {view === "chat"
            ? <ChatView classes={classes} />
            : <UploadView onRefresh={refresh} />}
        </div>
      </div>
    </>
  );
}
