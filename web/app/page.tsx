"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
const Graph = dynamic(() => import("./components/Graph"), { ssr: false });

// ── types ──────────────────────────────────────────────────────────────────────
interface FileEntry {
  filename: string;
  class_name: string;
  ingested_at: string;
  chunk_count?: number;
}
interface Source { filename: string; class_name: string; chunk_index: number; }
interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  streaming?: boolean;
}

// ── helpers ────────────────────────────────────────────────────────────────────
const S = (style: React.CSSProperties) => style;

function apiGet(path: string) {
  return fetch(`/api/${path}`).then((r) => r.json());
}

// ── primitives ─────────────────────────────────────────────────────────────────
function Cursor() {
  return <span style={{ display: "inline-block", width: 7, height: 13, background: "var(--amber)", marginLeft: 2, verticalAlign: "middle", animation: "blink 1.1s step-end infinite" }} />;
}

function Label({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 7 }}>{children}</div>;
}

function Btn({ onClick, disabled, children, danger }: { onClick: () => void; disabled?: boolean; children: React.ReactNode; danger?: boolean }) {
  const [hov, setHov] = useState(false);
  return (
    <button onClick={onClick} disabled={disabled} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} style={{
      background: "transparent", border: `1px solid ${hov && !disabled ? (danger ? "var(--red)" : "var(--amber)") : "var(--line2)"}`,
      borderRadius: 3, padding: "5px 14px", color: disabled ? "var(--muted)" : hov ? (danger ? "var(--red)" : "var(--amber)") : "var(--text)",
      fontFamily: "inherit", fontSize: 11, cursor: disabled ? "not-allowed" : "pointer", transition: "all 0.15s",
    }}>{children}</button>
  );
}

// ── sidebar ────────────────────────────────────────────────────────────────────
function Sidebar({ view, setView, files, classes, chunkCount }: {
  view: string; setView: (v: string) => void;
  files: FileEntry[]; classes: string[]; chunkCount: number;
}) {
  return (
    <div style={{ width: 210, flexShrink: 0, background: "var(--panel)", borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", padding: "18px 0 16px", overflow: "hidden" }}>
      <div style={{ padding: "0 16px 14px", borderBottom: "1px solid var(--line)", marginBottom: 14, fontSize: 11, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--text)", display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--amber)", flexShrink: 0 }} />
        claudia
      </div>

      <div style={{ padding: "0 10px", marginBottom: 16 }}>
        {["chat", "upload", "graph"].map((v) => (
          <button key={v} onClick={() => setView(v)} style={{ display: "block", width: "100%", textAlign: "left", padding: "5px 8px", borderRadius: 3, background: view === v ? "var(--line)" : "transparent", border: "none", cursor: "pointer", color: view === v ? "var(--text)" : "var(--muted)", fontSize: 12, fontFamily: "inherit", letterSpacing: "0.04em", transition: "all 0.1s" }}>
            {view === v ? "> " : "  "}{v}
          </button>
        ))}
      </div>

      <div style={{ padding: "0 16px 12px", borderBottom: "1px solid var(--line)", marginBottom: 14 }}>
        <Label>index</Label>
        <div style={{ color: "var(--muted)", fontSize: 11, lineHeight: 1.9 }}>
          <span style={{ color: "var(--amber)" }}>{chunkCount}</span> chunks<br />
          <span style={{ color: "var(--amber)" }}>{files.length}</span> files<br />
          <span style={{ color: "var(--amber)" }}>{classes.length}</span> classes
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "0 16px" }}>
        <Label>recent</Label>
        {files.length === 0 && <div style={{ color: "var(--muted)", fontSize: 11 }}>no files yet</div>}
        {files.slice(0, 15).map((f, i) => (
          <div key={i} style={{ paddingBottom: 8, marginBottom: 8, borderBottom: "1px solid var(--line)" }}>
            <div style={{ color: "var(--text)", fontSize: 11, wordBreak: "break-all", lineHeight: 1.4 }}>{f.filename}</div>
            <div style={{ color: "var(--muted)", fontSize: 10, marginTop: 2 }}>{f.class_name} · {f.ingested_at.slice(0, 10)}</div>
          </div>
        ))}
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // keyboard shortcut: Cmd+K focuses chat input
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  async function send() {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: q }]);
    setLoading(true);

    // add streaming placeholder
    setMessages((m) => [...m, { role: "assistant", content: "", streaming: true }]);

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, class_name: filterClass === "all" ? null : filterClass }),
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let sources: Source[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = decoder.decode(value).split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = JSON.parse(line.slice(6));
          if (data.token) {
            fullText += data.token;
            setMessages((m) => {
              const updated = [...m];
              updated[updated.length - 1] = { role: "assistant", content: fullText, streaming: true };
              return updated;
            });
          }
          if (data.done) {
            sources = data.sources ?? [];
            setMessages((m) => {
              const updated = [...m];
              updated[updated.length - 1] = { role: "assistant", content: fullText, streaming: false, sources };
              return updated;
            });
          }
        }
      }
    } catch {
      setMessages((m) => {
        const updated = [...m];
        updated[updated.length - 1] = { role: "assistant", content: "Error reaching the API.", streaming: false };
        return updated;
      });
    }
    setLoading(false);
  }

  function exportChat() {
    const md = messages.map((m) => {
      const role = m.role === "user" ? "**You**" : "**Claudia**";
      const sources = m.sources?.length
        ? "\n\n*Sources: " + [...new Set(m.sources.map((s) => s.filename))].join(", ") + "*"
        : "";
      return `${role}\n\n${m.content}${sources}`;
    }).join("\n\n---\n\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `claudia-chat-${Date.now()}.md`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: "10px 20px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>claudia:chat</span>
        {messages.length > 0 && (
          <button onClick={exportChat} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 10, cursor: "pointer", padding: "2px 6px", borderRadius: 2, fontFamily: "inherit" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}>
            export .md
          </button>
        )}
        {classes.length > 0 && (
          <select value={filterClass} onChange={(e) => setFilterClass(e.target.value)} style={{ marginLeft: "auto", background: "var(--line)", border: "1px solid var(--line2)", borderRadius: 3, color: "var(--text)", padding: "2px 8px", fontSize: 11, fontFamily: "inherit", cursor: "pointer" }}>
            <option value="all">all classes</option>
            {classes.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "20px 20px 8px" }}>
        {messages.length === 0 && (
          <div style={{ color: "var(--muted)", paddingTop: 40 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <span style={{ color: "var(--amber)" }}>~$</span>
              <span>claudia --interactive</span>
            </div>
            <div style={{ marginTop: 12, fontSize: 11, lineHeight: 2.2, paddingLeft: 20 }}>
              ready. ask anything about your notes.<br />
              <span style={{ opacity: 0.5 }}>⌘K to focus · enter to send · export .md above</span>
              {classes.length > 0 && <><br />{classes.length} class(es): {classes.join(", ")}</>}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{ marginBottom: 20 }}>
            {msg.role === "user" ? (
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ color: "var(--amber)", flexShrink: 0 }}>~$</span>
                <span style={{ color: "var(--text)" }}>{msg.content}</span>
              </div>
            ) : (
              <div style={{ paddingLeft: 20 }}>
                <div style={{ fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--amber)", marginBottom: 6 }}>claudia</div>
                <div style={{ color: "var(--text)", lineHeight: 1.75, whiteSpace: "pre-wrap" }}>
                  {msg.content}{msg.streaming && <Cursor />}
                </div>
                {!msg.streaming && msg.sources && msg.sources.length > 0 && (
                  <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 5 }}>
                    {[...new Map(msg.sources.map((s) => [s.filename, s])).values()].map((s, j) => (
                      <span key={j} style={{ fontSize: 10, color: "var(--muted)", border: "1px solid var(--line2)", borderRadius: 2, padding: "1px 6px", background: "var(--panel)" }}>
                        {s.filename} · {s.class_name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <div style={{ padding: "12px 20px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ color: "var(--amber)", flexShrink: 0 }}>~$</span>
        <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="ask anything… (⌘K)" disabled={loading} autoFocus
          style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "var(--text)", fontSize: 13, fontFamily: "inherit", caretColor: "var(--amber)" }} />
      </div>
    </div>
  );
}

// ── upload view ────────────────────────────────────────────────────────────────
function UploadView({ files, onRefresh }: { files: FileEntry[]; onRefresh: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [className, setClassName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedClass, setExpandedClass] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // keyboard shortcut: Cmd+U focuses upload
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "u") { e.preventDefault(); inputRef.current?.click(); }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  async function submit() {
    if (!file) { setError("no file selected"); return; }
    if (!className.trim()) { setError("class name required"); return; }
    setError(null); setStatus(null); setLoading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("class_name", className.trim());
    try {
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail ?? "upload failed");
      }
      const data = await res.json();
      setStatus(`✓ ${data.filename} — ${data.chunk_count} chunks`);
      setFile(null); setClassName(""); onRefresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "upload failed");
    }
    setLoading(false);
  }

  async function deleteFile(filename: string) {
    setDeleting(filename);
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(filename)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      onRefresh();
    } catch { }
    setDeleting(null);
  }

  // group files by class
  const grouped: Record<string, FileEntry[]> = {};
  for (const f of files) {
    const key = f.class_name || "General";
    (grouped[key] ??= []).push(f);
  }

  const filtered = search.trim()
    ? files.filter((f) => f.filename.toLowerCase().includes(search.toLowerCase()) || f.class_name.toLowerCase().includes(search.toLowerCase()))
    : null;

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* left: upload form */}
      <div style={{ width: 340, flexShrink: 0, borderRight: "1px solid var(--line)", padding: "24px 20px", display: "flex", flexDirection: "column", gap: 18, overflowY: "auto" }}>
        <div style={{ display: "flex", gap: 8 }}>
          <span style={{ color: "var(--amber)" }}>~$</span>
          <span style={{ color: "var(--muted)", fontSize: 12 }}>claudia --ingest</span>
        </div>

        {/* drop zone */}
        <div>
          <Label>file <span style={{ opacity: 0.5 }}>(⌘U)</span></Label>
          <div onClick={() => inputRef.current?.click()} onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
            style={{ border: `1px dashed ${file ? "var(--amber)" : "var(--line2)"}`, borderRadius: 4, padding: "20px 16px", cursor: "pointer", textAlign: "center", color: file ? "var(--text)" : "var(--muted)", fontSize: 12, background: file ? "rgba(167,139,250,0.04)" : "transparent", transition: "all 0.15s" }}>
            {file ? file.name : "drop file or click to browse"}
            <br /><span style={{ fontSize: 10, color: "var(--muted)" }}>pdf · png · jpg · docx</span>
          </div>
          <input ref={inputRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.docx" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && setFile(e.target.files[0])} />
        </div>

        {/* class */}
        <div>
          <Label>class / subject</Label>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "var(--amber)" }}>{">"}</span>
            <input value={className} onChange={(e) => setClassName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="e.g. Biology 101, History"
              list="class-list"
              style={{ flex: 1, background: "transparent", border: "none", borderBottom: "1px solid var(--line2)", outline: "none", color: "var(--text)", fontSize: 13, fontFamily: "inherit", padding: "4px 0", caretColor: "var(--amber)" }} />
            <datalist id="class-list">
              {Object.keys(grouped).map((c) => <option key={c} value={c} />)}
            </datalist>
          </div>
        </div>

        <Btn onClick={submit} disabled={loading}>{loading ? "ingesting…" : "ingest file"}</Btn>

        {error && <div style={{ color: "var(--red)", fontSize: 11 }}>error: {error}</div>}
        {status && <div style={{ color: "var(--green)", fontSize: 11 }}>{status}</div>}
      </div>

      {/* right: library */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* search */}
        <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ color: "var(--muted)", fontSize: 11 }}>claudia:library</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search files…"
            style={{ marginLeft: "auto", background: "var(--line)", border: "1px solid var(--line2)", borderRadius: 3, color: "var(--text)", padding: "3px 10px", fontSize: 11, fontFamily: "inherit", outline: "none", width: 180, caretColor: "var(--amber)" }} />
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
          {files.length === 0 && (
            <div style={{ color: "var(--muted)", fontSize: 12, paddingTop: 40 }}>no files ingested yet.</div>
          )}

          {/* search results */}
          {filtered && (
            <div>
              <Label>{filtered.length} result{filtered.length !== 1 ? "s" : ""}</Label>
              {filtered.map((f) => <FileRow key={f.filename} f={f} deleting={deleting} onDelete={deleteFile} />)}
            </div>
          )}

          {/* grouped by class */}
          {!filtered && Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([cls, clsFiles]) => (
            <div key={cls} style={{ marginBottom: 16 }}>
              <button onClick={() => setExpandedClass(expandedClass === cls ? null : cls)}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "none", border: "none", cursor: "pointer", padding: "4px 0", marginBottom: 6 }}>
                <span style={{ color: "var(--amber)", fontSize: 10 }}>{expandedClass === cls ? "▼" : "▶"}</span>
                <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 600 }}>{cls}</span>
                <span style={{ color: "var(--muted)", fontSize: 10 }}>{clsFiles.length} file{clsFiles.length !== 1 ? "s" : ""}</span>
              </button>
              {expandedClass === cls && clsFiles.map((f) => <FileRow key={f.filename} f={f} deleting={deleting} onDelete={deleteFile} />)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FileRow({ f, deleting, onDelete }: { f: FileEntry; deleting: string | null; onDelete: (name: string) => void }) {
  const [hov, setHov] = useState(false);
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 8px", borderRadius: 3, background: hov ? "var(--line)" : "transparent", marginBottom: 2, transition: "background 0.1s" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: "var(--text)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.filename}</div>
        <div style={{ color: "var(--muted)", fontSize: 10, marginTop: 1 }}>{f.ingested_at.slice(0, 10)}</div>
      </div>
      {hov && (
        <button onClick={() => onDelete(f.filename)} disabled={deleting === f.filename}
          style={{ background: "none", border: "1px solid var(--red)", borderRadius: 2, color: "var(--red)", fontSize: 10, padding: "1px 7px", cursor: "pointer", fontFamily: "inherit", opacity: deleting === f.filename ? 0.5 : 1 }}>
          {deleting === f.filename ? "…" : "del"}
        </button>
      )}
    </div>
  );
}

// ── app ────────────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState("chat");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [classes, setClasses] = useState<string[]>([]);
  const [chunkCount, setChunkCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [f, c, h] = await Promise.all([apiGet("files"), apiGet("classes"), apiGet("health")]);
      setFiles(f.files); setClasses(c.classes); setChunkCount(h.chunks);
    } catch { }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  // Cmd+U switches to upload view
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "u") setView("upload");
      if ((e.metaKey || e.ctrlKey) && e.key === "k") setView("chat");
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <>
      <style>{`@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`}</style>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        <Sidebar view={view} setView={setView} files={files} classes={classes} chunkCount={chunkCount} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
          {view === "chat" && <ChatView classes={classes} />}
          {view === "upload" && <UploadView files={files} onRefresh={refresh} />}
          {view === "graph" && <Graph />}
        </div>
      </div>
    </>
  );
}
