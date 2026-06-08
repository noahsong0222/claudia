"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import dynamic from "next/dynamic";
const Graph = dynamic(() => import("./components/Graph"), { ssr: false });
const FileViewer = dynamic(() => import("./components/FileViewer"), { ssr: false });

// ── types ──────────────────────────────────────────────────────────────────────
interface FileEntry { filename: string; class_name: string; ingested_at: string; tags: string[]; file_type?: string; }
interface Source { filename: string; class_name: string; chunk_index: number; score?: number; text?: string; }
interface Confidence { score: number; label: "High" | "Medium" | "Low"; strong_sources?: number; note: string; }
interface Flashcard { q: string; a: string; }
interface QuizQuestion { q: string; options: string[]; answer: string; explanation: string; }
interface SearchResult { text: string; filename: string; class_name: string; score: number; }
interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  sources?: Source[];
  confidence?: Confidence | null;
  streaming?: boolean;
  cards?: Flashcard[];
  quiz?: QuizQuestion[];
  searchResults?: SearchResult[];
}
type ContextScope =
  | { type: "all" }
  | { type: "class"; value: string }
  | { type: "file"; value: string };

interface ConvMeta {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}
interface ConvData {
  id: string;
  messages: Message[];
  scope: ContextScope;
}

// ── conversation storage ───────────────────────────────────────────────────────
const CONV_INDEX_KEY = "claudia:conversations";
const convKey = (id: string) => `claudia:conv:${id}`;
const MAX_CONVS = 50;

function listConversations(): ConvMeta[] {
  try { return JSON.parse(localStorage.getItem(CONV_INDEX_KEY) ?? "[]"); } catch { return []; }
}
function loadConversation(id: string): ConvData | null {
  try { return JSON.parse(localStorage.getItem(convKey(id)) ?? "null"); } catch { return null; }
}
function saveConversation(data: ConvData, title: string) {
  try {
    localStorage.setItem(convKey(data.id), JSON.stringify(data));
    const idx = listConversations().filter(c => c.id !== data.id);
    idx.unshift({ id: data.id, title, updatedAt: new Date().toISOString(), messageCount: data.messages.length });
    if (idx.length > MAX_CONVS) {
      idx.slice(MAX_CONVS).forEach(c => localStorage.removeItem(convKey(c.id)));
    }
    localStorage.setItem(CONV_INDEX_KEY, JSON.stringify(idx.slice(0, MAX_CONVS)));
  } catch { /* localStorage full */ }
}
function deleteConversation(id: string) {
  localStorage.removeItem(convKey(id));
  localStorage.setItem(CONV_INDEX_KEY, JSON.stringify(listConversations().filter(c => c.id !== id)));
}
function newConvId() { return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
function convTitle(messages: Message[]): string {
  const first = messages.find(m => m.role === "user");
  if (!first) return "New chat";
  return first.content.slice(0, 60) + (first.content.length > 60 ? "…" : "");
}

// ── md import/export ───────────────────────────────────────────────────────────
function exportToMd(messages: Message[]): string {
  return messages.map(m => {
    const role = m.role === "user" ? "**You**" : m.role === "system" ? "*system*" : "**Claudia**";
    const srcs = m.sources?.length ? "\n\n*Sources: " + [...new Set(m.sources.map(s => s.filename))].join(", ") + "*" : "";
    return `${role}\n\n${m.content}${srcs}`;
  }).join("\n\n---\n\n");
}
function importFromMd(text: string): Message[] {
  const blocks = text.split(/\n\n---\n\n/);
  const messages: Message[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let role: Message["role"] = "assistant";
    let content = trimmed;
    if (trimmed.startsWith("**You**")) { role = "user"; content = trimmed.replace(/^\*\*You\*\*\n\n/, ""); }
    else if (trimmed.startsWith("**Claudia**")) { role = "assistant"; content = trimmed.replace(/^\*\*Claudia\*\*\n\n/, ""); }
    else if (trimmed.startsWith("*system*")) { role = "system"; content = trimmed.replace(/^\*system\*\n\n/, ""); }
    // strip trailing sources line
    const sourcesMatch = content.match(/\n\n\*Sources: ([^*]+)\*$/);
    let sources: Source[] | undefined;
    if (sourcesMatch) {
      content = content.slice(0, -sourcesMatch[0].length);
      sources = sourcesMatch[1].split(", ").map(f => ({ filename: f.trim(), class_name: "", chunk_index: 0 }));
    }
    messages.push({ role, content, sources });
  }
  return messages;
}

// ── commands registry ──────────────────────────────────────────────────────────
const COMMANDS = [
  { cmd: "/summary",    args: "[file|class]",       desc: "Summarize documents",          icon: "◈" },
  { cmd: "/outline",    args: "[file|class]",       desc: "Generate structured outline",  icon: "≡" },
  { cmd: "/flashcards", args: "[file|class] [n]",   desc: "Create study flashcards",      icon: "⟐" },
  { cmd: "/quiz",       args: "[file|class] [n]",   desc: "Multiple-choice quiz",         icon: "?" },
  { cmd: "/explain",    args: "<topic>",            desc: "Deep-dive explanation",        icon: "◎" },
  { cmd: "/search",     args: "<query>",            desc: "Semantic search your docs",    icon: "⌕" },
  { cmd: "/note",       args: "<text>",             desc: "Save a quick note",            icon: "✎" },
  { cmd: "/stats",      args: "",                   desc: "Knowledge base statistics",    icon: "▤" },
  { cmd: "/clear",      args: "",                   desc: "Clear chat history",           icon: "⊘" },
];

// normalize typed command to canonical form (case-insensitive + aliases)
const CMD_ALIASES: Record<string, string> = {
  "/summarize": "/summary", "/sum": "/summary", "/summarise": "/summary",
  "/flash": "/flashcards", "/fc": "/flashcards", "/cards": "/flashcards", "/flashcard": "/flashcards",
  "/q": "/quiz", "/test": "/quiz",
  "/exp": "/explain", "/definition": "/explain", "/define": "/explain",
  "/find": "/search", "/lookup": "/search",
  "/n": "/note", "/quicknote": "/note", "/jot": "/note",
  "/stat": "/stats", "/info": "/stats",
  "/new": "/clear", "/reset": "/clear",
  "/ol": "/outline",
};

function normalizeCmd(raw: string): string {
  const lower = raw.toLowerCase();
  return CMD_ALIASES[lower] ?? lower;
}

// ── helpers ────────────────────────────────────────────────────────────────────
function apiGet(path: string) { return fetch(`/api/${path}`).then(r => r.json()); }

async function streamPost(
  path: string,
  body: unknown,
  onToken: (t: string) => void,
  onDone: (data: Record<string, unknown>) => void,
) {
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Request failed" }));
    throw new Error(err.detail ?? "Request failed");
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.token) onToken(data.token);
        if (data.done) onDone(data);
      } catch { /* skip malformed lines */ }
    }
  }
}

// simple markdown-ish renderer
function renderContent(text: string): string {
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, s => `<ul>${s}</ul>`)
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/^---$/gm, '<hr>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(?!<[a-z])(.+)$/gm, '$1');
}

// ── cursor ─────────────────────────────────────────────────────────────────────
function Cursor() {
  return (
    <span style={{
      display: "inline-block", width: 6, height: 14,
      background: "var(--accent)", marginLeft: 2, verticalAlign: "middle",
      borderRadius: 1, animation: "blink 1s step-end infinite",
    }} />
  );
}

// ── flashcard deck ─────────────────────────────────────────────────────────────
function FlashcardDeck({ cards }: { cards: Flashcard[] }) {
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set());
  const [animating, setAnimating] = useState(false);

  const card = cards[idx];
  const progress = known.size / cards.length;

  function flip() { if (!animating) setFlipped(f => !f); }

  function go(dir: 1 | -1) {
    if (animating) return;
    setAnimating(true);
    setFlipped(false);
    setTimeout(() => {
      setIdx(i => Math.min(Math.max(i + dir, 0), cards.length - 1));
      setAnimating(false);
    }, 220);
  }

  function markKnown() {
    setKnown(s => new Set([...s, idx]));
    go(1);
  }

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === " ") { e.preventDefault(); flip(); }
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  return (
    <div style={{ marginTop: 14, animation: "fadeIn 0.2s ease", opacity: known.has(idx) ? 0.55 : 1, transition: "opacity 0.2s" }}>
      {/* progress */}
      <div style={{ height: 3, background: "var(--line2)", borderRadius: 2, marginBottom: 10, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${progress * 100}%`, background: "linear-gradient(90deg, var(--accent2), var(--accent))", borderRadius: 2, transition: "width 0.4s" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)", marginBottom: 12 }}>
        <span style={{ color: "var(--text2)" }}>{idx + 1} <span style={{ opacity: 0.5 }}>/ {cards.length}</span></span>
        <span style={{ color: "var(--green)" }}>{known.size} known</span>
        <span style={{ opacity: 0.4 }}>space=flip · ←→</span>
      </div>

      {/* 3D card */}
      <div className="card-scene" onClick={flip} style={{ cursor: "pointer", userSelect: "none" }}>
        <div className={`card-inner${flipped ? " flipped" : ""}`} style={{ minHeight: 130 }}>
          <div className="card-face card-front">
            <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 10 }}>question</div>
            <div style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.75 }}>{card.q}</div>
            <div style={{ position: "absolute", bottom: 10, right: 14, fontSize: 10, color: "var(--muted)", opacity: 0.5 }}>tap to flip</div>
          </div>
          <div className="card-face card-back">
            <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--accent)", marginBottom: 10 }}>answer</div>
            <div style={{ color: "var(--text)", fontSize: 13, lineHeight: 1.75 }}>{card.a}</div>
          </div>
        </div>
      </div>

      {/* controls */}
      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button onClick={e => { e.stopPropagation(); go(-1); }} disabled={idx === 0 || animating} style={btnStyle("var(--muted)", idx === 0 || animating)}>←</button>
        <button onClick={e => { e.stopPropagation(); flip(); }} disabled={animating} style={btnStyle("var(--accent)", false)}>flip</button>
        <button onClick={e => { e.stopPropagation(); markKnown(); }} disabled={animating} style={{ ...btnStyle("var(--green)", false), flex: 2 }}>✓ know it</button>
        <button onClick={e => { e.stopPropagation(); go(1); }} disabled={idx === cards.length - 1 || animating} style={btnStyle("var(--muted)", idx === cards.length - 1 || animating)}>→</button>
      </div>
    </div>
  );
}

function btnStyle(color: string, disabled: boolean): React.CSSProperties {
  return {
    flex: 1, background: "transparent", border: `1px solid ${disabled ? "var(--line2)" : "var(--line2)"}`,
    borderRadius: "var(--radius-sm)", padding: "6px 0", color: disabled ? "var(--muted)" : color,
    fontFamily: "inherit", fontSize: 11, cursor: disabled ? "not-allowed" : "pointer", transition: "all 0.12s",
  };
}

// ── quiz component ─────────────────────────────────────────────────────────────
function QuizDeck({ questions }: { questions: QuizQuestion[] }) {
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [done, setDone] = useState(false);
  const q = questions[idx];

  function pick(opt: string) {
    if (selected) return;
    const letter = opt.charAt(0);
    setSelected(letter);
    if (letter === q.answer) setScore(s => s + 1);
  }

  function next() {
    if (idx + 1 >= questions.length) { setDone(true); return; }
    setSelected(null);
    setIdx(i => i + 1);
  }

  if (done) return (
    <div style={{ marginTop: 12, padding: 16, background: "var(--panel2)", border: "1px solid var(--line2)", borderRadius: "var(--radius)", animation: "fadeIn 0.2s ease" }}>
      <div style={{ fontSize: 10, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 8 }}>quiz complete</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: score / questions.length >= 0.8 ? "var(--green)" : score / questions.length >= 0.5 ? "var(--amber)" : "var(--red)" }}>
        {score} / {questions.length}
      </div>
      <div style={{ color: "var(--text2)", fontSize: 12, marginTop: 4 }}>
        {score / questions.length >= 0.8 ? "Excellent work!" : score / questions.length >= 0.5 ? "Good effort, review the misses." : "Keep studying, you'll get it!"}
      </div>
    </div>
  );

  return (
    <div style={{ marginTop: 12, animation: "fadeIn 0.2s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)", marginBottom: 10 }}>
        <span>Q{idx + 1} / {questions.length}</span>
        <span style={{ color: "var(--green)" }}>{score} correct</span>
      </div>
      <div style={{ padding: "14px 16px", background: "var(--panel2)", border: "1px solid var(--line2)", borderRadius: "var(--radius)", marginBottom: 10 }}>
        <div style={{ color: "var(--text)", lineHeight: 1.65 }}>{q.q}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {q.options.map(opt => {
          const letter = opt.charAt(0);
          const isCorrect = letter === q.answer;
          const isPicked = letter === selected;
          let borderColor = "var(--line2)";
          let bgColor = "transparent";
          if (selected) {
            if (isCorrect) { borderColor = "var(--green)"; bgColor = "rgba(52,211,153,0.08)"; }
            else if (isPicked) { borderColor = "var(--red)"; bgColor = "rgba(248,113,113,0.08)"; }
          }
          return (
            <button key={opt} onClick={() => pick(opt)} disabled={!!selected} style={{
              textAlign: "left", padding: "9px 14px", background: bgColor,
              border: `1px solid ${borderColor}`, borderRadius: "var(--radius-sm)",
              color: selected ? (isCorrect ? "var(--green)" : isPicked ? "var(--red)" : "var(--muted)") : "var(--text2)",
              fontFamily: "inherit", fontSize: 12, cursor: selected ? "default" : "pointer",
              transition: "all 0.15s",
            }}
              onMouseEnter={e => { if (!selected) e.currentTarget.style.borderColor = "var(--accent)"; }}
              onMouseLeave={e => { if (!selected) e.currentTarget.style.borderColor = "var(--line2)"; }}>
              {opt}
            </button>
          );
        })}
      </div>
      {selected && (
        <div style={{ marginTop: 10, padding: "10px 14px", background: "var(--line)", borderRadius: "var(--radius-sm)", animation: "fadeIn 0.15s ease" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>explanation</div>
          <div style={{ color: "var(--text2)", fontSize: 12, lineHeight: 1.6 }}>{q.explanation}</div>
          <button onClick={next} style={{
            marginTop: 10, padding: "5px 16px", background: "var(--accent-bg)",
            border: "1px solid var(--accent)", borderRadius: "var(--radius-sm)",
            color: "var(--accent)", fontFamily: "inherit", fontSize: 11, cursor: "pointer",
          }}>
            {idx + 1 >= questions.length ? "see results →" : "next →"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── search results ─────────────────────────────────────────────────────────────
function SearchResults({ results }: { results: SearchResult[] }) {
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8, animation: "fadeIn 0.2s ease" }}>
      {results.map((r, i) => (
        <div key={i} style={{ padding: "10px 14px", background: "var(--panel2)", border: "1px solid var(--line2)", borderRadius: "var(--radius-sm)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
            <div style={{ display: "flex", gap: 6 }}>
              <span style={{ color: "var(--accent)", fontSize: 10 }}>{r.filename}</span>
              <span style={{ color: "var(--muted)", fontSize: 10 }}>· {r.class_name}</span>
            </div>
            <span style={{ fontSize: 10, color: r.score > 0.8 ? "var(--green)" : r.score > 0.6 ? "var(--amber)" : "var(--muted)" }}>
              {Math.round(r.score * 100)}% match
            </span>
          </div>
          <p style={{ color: "var(--text2)", fontSize: 11, lineHeight: 1.65, margin: 0 }}>
            {r.text.slice(0, 200)}{r.text.length > 200 ? "…" : ""}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── context scope picker ───────────────────────────────────────────────────────
function ScopePicker({ scope, setScope, files, classes }: {
  scope: ContextScope; setScope: (s: ContextScope) => void;
  files: FileEntry[]; classes: string[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const label = scope.type === "all" ? "All docs"
    : scope.type === "class" ? scope.value
    : scope.value.replace(/\.[^.]+$/, "");
  const isScoped = scope.type !== "all";

  const allOptions: { label: string; sub?: string; action: () => void }[] = [
    { label: "All documents", action: () => setScope({ type: "all" }) },
    ...classes.map(c => ({ label: c, sub: "class", action: () => setScope({ type: "class", value: c }) })),
    ...files.map(f => ({ label: f.filename.replace(/\.[^.]+$/, ""), sub: f.class_name, action: () => setScope({ type: "file", value: f.filename }) })),
  ];

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)} style={{
        display: "flex", alignItems: "center", gap: 5,
        padding: "4px 10px", borderRadius: 20,
        background: isScoped ? "var(--accent-bg)" : "transparent",
        border: `1px solid ${isScoped ? "var(--accent)" : "var(--line2)"}`,
        color: isScoped ? "var(--accent)" : "var(--text2)",
        fontFamily: "inherit", fontSize: 11, cursor: "pointer", transition: "all 0.15s",
      }}>
        <span style={{ fontSize: 10 }}>◎</span> {label}
        <span style={{ fontSize: 8, opacity: 0.6 }}>▼</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 6px)",
          background: "var(--panel2)", border: "1px solid var(--line2)",
          borderRadius: "var(--radius)", minWidth: 220, zIndex: 50,
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)", overflow: "hidden",
          animation: "fadeIn 0.1s ease",
        }}>
          <div style={{ padding: "8px 12px 4px", fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--muted)" }}>scope</div>
          <div style={{ maxHeight: 280, overflowY: "auto" }}>
            {allOptions.map((o, i) => (
              <button key={i} onClick={() => { o.action(); setOpen(false); }} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                width: "100%", padding: "7px 12px", background: "none", border: "none",
                color: "var(--text2)", fontFamily: "inherit", fontSize: 12, cursor: "pointer", textAlign: "left",
              }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--line)"; e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text2)"; }}>
                <span>{o.label}</span>
                {o.sub && <span style={{ fontSize: 10, color: "var(--muted)" }}>{o.sub}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── command palette ────────────────────────────────────────────────────────────
function CommandPalette({ query, onSelect, onClose }: {
  query: string; onSelect: (cmd: string) => void; onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const q = query.toLowerCase();
  const filtered = COMMANDS.filter(c => c.cmd.startsWith(q) || Object.entries(CMD_ALIASES).some(([alias, canon]) => canon === c.cmd && alias.startsWith(q)));

  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, filtered.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
      if (e.key === "Tab" && filtered[active]) { e.preventDefault(); onSelect(filtered[active].cmd); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [filtered, active, onSelect]);

  if (filtered.length === 0) return null;

  return (
    <div style={{
      position: "absolute", bottom: "calc(100% + 8px)", left: 0, right: 0,
      background: "var(--panel2)", border: "1px solid var(--line2)",
      borderRadius: "var(--radius)", zIndex: 50, overflow: "hidden",
      boxShadow: "0 -8px 32px rgba(0,0,0,0.5)", animation: "fadeIn 0.1s ease",
    }}>
      <div style={{ padding: "6px 12px 4px", fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--muted)" }}>
        commands · tab to select
      </div>
      {filtered.map((c, i) => (
        <button key={c.cmd} onClick={() => onSelect(c.cmd)}
          style={{
            display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 12px",
            background: i === active ? "var(--line)" : "none", border: "none", cursor: "pointer",
            fontFamily: "inherit", transition: "background 0.08s",
          }}
          onMouseEnter={() => setActive(i)}>
          <span style={{ width: 18, textAlign: "center", color: "var(--accent)", fontSize: 13, flexShrink: 0 }}>{c.icon}</span>
          <span style={{ color: "var(--accent)", fontSize: 12, width: 100, flexShrink: 0 }}>{c.cmd}</span>
          <span style={{ color: "var(--muted)", fontSize: 11 }}>{c.args}</span>
          <span style={{ color: "var(--text2)", fontSize: 11, marginLeft: "auto" }}>{c.desc}</span>
        </button>
      ))}
    </div>
  );
}

// ── show your work (sources + confidence) ──────────────────────────────────────
function ShowYourWork({ sources, confidence, onViewFile }: {
  sources: Source[]; confidence?: Confidence | null; onViewFile: (f: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const confColor = confidence?.label === "High" ? "var(--green)"
    : confidence?.label === "Medium" ? "var(--amber)" : "var(--red)";
  // unique files for the compact chip row
  const files = [...new Map(sources.map(s => [s.filename, s])).values()];

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {confidence && (
          <span title={confidence.note} style={{
            display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 600,
            color: confColor, border: `1px solid ${confColor}`, borderRadius: 20,
            padding: "1px 9px", background: "transparent",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: confColor }} />
            {confidence.label} confidence · {Math.round(confidence.score * 100)}%
          </span>
        )}
        {files.map((s, i) => (
          <button key={i} onClick={() => onViewFile(s.filename)} style={{
            fontSize: 10, color: "var(--muted)", border: "1px solid var(--line2)",
            borderRadius: 20, padding: "1px 8px", background: "var(--panel)",
            fontFamily: "inherit", cursor: "pointer", transition: "all 0.1s",
          }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.borderColor = "var(--accent)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--muted)"; e.currentTarget.style.borderColor = "var(--line2)"; }}>
            {s.filename}
          </button>
        ))}
        <button onClick={() => setOpen(o => !o)} style={{
          fontSize: 10, color: "var(--muted)", border: "1px dashed var(--line2)",
          borderRadius: 20, padding: "1px 8px", background: "transparent",
          fontFamily: "inherit", cursor: "pointer",
        }}>
          {open ? "hide work ▲" : "show work ▼"}
        </button>
      </div>

      {confidence?.note && (
        <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 5, fontStyle: "italic" }}>{confidence.note}</div>
      )}

      {open && (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--muted)" }}>
            Retrieved passages — what the answer was built from
          </div>
          {sources.map((s, i) => {
            const pct = Math.round((s.score ?? 0) * 100);
            return (
              <div key={i} style={{ border: "1px solid var(--line2)", borderRadius: "var(--radius-sm)", padding: "8px 10px", background: "var(--panel2)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                  <button onClick={() => onViewFile(s.filename)} style={{
                    fontSize: 10, color: "var(--accent)", background: "none", border: "none",
                    padding: 0, cursor: "pointer", fontFamily: "inherit", fontWeight: 500,
                  }}>{s.filename}</button>
                  <span style={{ fontSize: 9, color: "var(--muted)" }}>#{s.chunk_index}</span>
                  {/* relevance bar */}
                  <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 60, height: 4, borderRadius: 2, background: "var(--line)", overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: pct >= 60 ? "var(--green)" : pct >= 45 ? "var(--amber)" : "var(--red)" }} />
                    </div>
                    <span style={{ fontSize: 9, color: "var(--muted)", width: 28, textAlign: "right" }}>{pct}%</span>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "var(--text2)", lineHeight: 1.5 }}>{s.text}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── message bubble ─────────────────────────────────────────────────────────────
function MessageBubble({ msg, onViewFile }: { msg: Message; onViewFile: (f: string) => void }) {
  if (msg.role === "system") return (
    <div style={{ padding: "6px 16px", color: "var(--muted)", fontSize: 11, fontStyle: "italic", animation: "fadeIn 0.15s ease" }}>
      {msg.content}
    </div>
  );

  if (msg.role === "user") return (
    <div style={{ display: "flex", justifyContent: "flex-end", padding: "4px 16px", animation: "fadeIn 0.15s ease" }}>
      <div style={{
        maxWidth: "80%", padding: "10px 14px",
        background: "var(--user-bg)", border: "1px solid var(--line2)",
        borderRadius: "var(--radius) var(--radius) 4px var(--radius)",
        color: "var(--text)", fontSize: 13, lineHeight: 1.6,
      }}>
        {msg.content}
      </div>
    </div>
  );

  // assistant
  return (
    <div style={{ padding: "4px 16px", animation: "fadeIn 0.15s ease" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <div style={{
          width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
          background: "linear-gradient(135deg, var(--accent2), var(--accent))",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, color: "#fff", fontWeight: 700, marginTop: 1,
        }}>C</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 5, letterSpacing: "0.1em" }}>claudia</div>
          {msg.content && (
            <div
              className="prose"
              dangerouslySetInnerHTML={{ __html: `<p>${renderContent(msg.content)}</p>` }}
              style={{ fontSize: 13 }}
            />
          )}
          {msg.streaming && !msg.content && <Cursor />}
          {msg.streaming && msg.content && <span style={{ display: "inline-block" }}><Cursor /></span>}

          {msg.cards && <FlashcardDeck cards={msg.cards} />}
          {msg.quiz && <QuizDeck questions={msg.quiz} />}
          {msg.searchResults && <SearchResults results={msg.searchResults} />}

          {!msg.streaming && msg.sources && msg.sources.length > 0 && (
            <ShowYourWork sources={msg.sources} confidence={msg.confidence} onViewFile={onViewFile} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── chat view ──────────────────────────────────────────────────────────────────
function ChatView({ files, classes, onViewFile, convId, onConvSaved, onNewChat }: {
  files: FileEntry[]; classes: string[]; onViewFile: (f: string) => void;
  convId: string; onConvSaved: () => void; onNewChat: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [scope, setScope] = useState<ContextScope>({ type: "all" });
  const [showPalette, setShowPalette] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // load conversation when convId changes
  useEffect(() => {
    const saved = loadConversation(convId);
    if (saved) { setMessages(saved.messages); setScope(saved.scope); }
    else { setMessages([]); setScope({ type: "all" }); }
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [convId]);

  // auto-save after every completed exchange
  useEffect(() => {
    const nonStreaming = messages.filter(m => !m.streaming);
    if (nonStreaming.length === 0) return;
    const title = convTitle(nonStreaming);
    saveConversation({ id: convId, messages: nonStreaming, scope }, title);
    onConvSaved();
  }, [messages, scope, convId, onConvSaved]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  function handleImport(file: File) {
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      const imported = importFromMd(text);
      if (imported.length > 0) setMessages(imported);
    };
    reader.readAsText(file);
  }

  function addMsg(msg: Message) { setMessages(m => [...m, msg]); }
  function updateLast(update: Partial<Message>) {
    setMessages(m => { const u = [...m]; u[u.length - 1] = { ...u[u.length - 1], ...update }; return u; });
  }

  const scopeArgs = {
    class_name: scope.type === "class" ? scope.value : undefined,
    filename: scope.type === "file" ? scope.value : undefined,
  };

  async function handleCommand(raw: string) {
    const parts = raw.trim().split(/\s+/);
    const cmd = normalizeCmd(parts[0]);
    const arg = parts.slice(1).join(" ").trim();

    if (cmd === "/clear") { onNewChat(); setInput(""); return; }

    addMsg({ role: "user", content: raw });
    setInput("");
    setLoading(true);

    const resolveTarget = (a: string) => {
      if (!a) return scopeArgs;
      if (files.some(f => f.filename === a)) return { filename: a };
      return { class_name: a };
    };

    try {
      if (cmd === "/note") {
        if (!arg) { addMsg({ role: "system", content: "Usage: /note <your text here>" }); setLoading(false); return; }
        addMsg({ role: "assistant", content: "", streaming: true });
        const res = await fetch("/api/note", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: arg, class_name: scope.type === "class" ? scope.value : "General" }),
        });
        const data = await res.json();
        updateLast({ content: `Note saved as **${data.title}** in ${data.class_name} (${data.chunk_count} chunk${data.chunk_count !== 1 ? "s" : ""})`, streaming: false });
        setLoading(false); return;
      }

      if (cmd === "/search") {
        if (!arg) { addMsg({ role: "system", content: "Usage: /search <query>" }); setLoading(false); return; }
        addMsg({ role: "assistant", content: `Searching for: **${arg}**`, streaming: true });
        const res = await fetch("/api/search", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: arg, ...scopeArgs }),
        });
        const data = await res.json();
        updateLast({ content: `Found ${data.count} results for: **${arg}**`, streaming: false, searchResults: data.results });
        setLoading(false); return;
      }

      if (cmd === "/stats") {
        addMsg({ role: "assistant", content: "", streaming: true });
        const data = await apiGet("stats");
        const lines = [
          `**Knowledge base stats**\n`,
          `- ${data.total_chunks} total chunks`,
          `- ${data.total_files} files`,
          `- ${data.total_classes} classes\n`,
          "**By class:**",
          ...Object.entries(data.by_class as Record<string, { files: number; chunks: number }>)
            .map(([c, v]) => `- **${c}** — ${v.files} files, ${v.chunks} chunks`),
        ];
        updateLast({ content: lines.join("\n"), streaming: false });
        setLoading(false); return;
      }

      if (cmd === "/flashcards") {
        const countMatch = arg.match(/\d+/);
        const count = countMatch ? parseInt(countMatch[0]) : 10;
        const textArg = arg.replace(/\d+/, "").trim();
        const target = { ...resolveTarget(textArg), count };
        addMsg({ role: "assistant", content: "Generating flashcards…", streaming: true });
        const res = await fetch("/api/flashcards", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail ?? "Flashcard generation failed");
        if (!data.cards?.length) throw new Error("No flashcards returned — try with more content loaded");
        updateLast({ content: `Generated **${data.count} flashcard${data.count !== 1 ? "s"  : ""}** — tap a card to flip`, streaming: false, cards: data.cards });
        setLoading(false); return;
      }

      if (cmd === "/quiz") {
        const countMatch = arg.match(/\d+/);
        const count = countMatch ? parseInt(countMatch[0]) : 5;
        const textArg = arg.replace(/\d+/, "").trim();
        const target = { ...resolveTarget(textArg), count };
        addMsg({ role: "assistant", content: "Generating quiz…", streaming: true });
        const res = await fetch("/api/quiz", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail ?? "Quiz generation failed");
        if (!data.questions?.length) throw new Error("No questions returned — try with more content loaded");
        updateLast({ content: `**${data.count}-question quiz** — good luck!`, streaming: false, quiz: data.questions });
        setLoading(false); return;
      }

      if (cmd === "/explain") {
        if (!arg) { addMsg({ role: "system", content: "Usage: /explain <topic>" }); setLoading(false); return; }
        addMsg({ role: "assistant", content: "", streaming: true });
        let text = "";
        await streamPost("explain", { topic: arg, ...scopeArgs },
          t => { text += t; updateLast({ content: text, streaming: true }); },
          () => updateLast({ content: text, streaming: false }),
        );
        setLoading(false); return;
      }

      if (cmd === "/summary" || cmd === "/outline") {
        const endpoint = cmd.slice(1);
        const target = resolveTarget(arg);
        addMsg({ role: "assistant", content: "", streaming: true });
        let text = "";
        await streamPost(endpoint, target,
          t => { text += t; updateLast({ content: text, streaming: true }); },
          () => updateLast({ content: text, streaming: false }),
        );
        setLoading(false); return;
      }
    } catch (err: unknown) {
      updateLast({ content: `Error: ${err instanceof Error ? err.message : "something went wrong"}`, streaming: false });
    }

    setLoading(false);
  }

  async function send() {
    const q = input.trim();
    if (!q || loading) return;
    if (q.startsWith("/")) { setShowPalette(false); handleCommand(q.trim()); return; }

    setInput("");
    addMsg({ role: "user", content: q });
    setLoading(true);
    addMsg({ role: "assistant", content: "", streaming: true });

    let fullText = "";
    try {
      await streamPost("chat/stream", { question: q, ...scopeArgs },
        t => { fullText += t; updateLast({ content: fullText, streaming: true }); },
        d => updateLast({ content: fullText, streaming: false, sources: d.sources as Source[], confidence: d.confidence as Confidence | null }),
      );
    } catch (err: unknown) {
      updateLast({ content: `Error: ${err instanceof Error ? err.message : "connection failed"}`, streaming: false });
    }
    setLoading(false);
  }

  function exportChat() {
    const md = exportToMd(messages);
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([md], { type: "text/markdown" })),
      download: `claudia-${Date.now()}.md`,
    });
    a.click();
  }

  const scopeLabel = scope.type === "all" ? "all docs" : scope.type === "class" ? scope.value : scope.value.replace(/\.[^.]+$/, "");

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* top bar */}
      <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <span style={{ color: "var(--text2)", fontSize: 11, fontWeight: 500 }}>Chat</span>
        {scope.type !== "all" && (
          <span style={{ fontSize: 10, padding: "2px 8px", background: "var(--accent-bg)", border: "1px solid var(--accent)", borderRadius: 20, color: "var(--accent)" }}>
            {scopeLabel}
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {/* import .md */}
          <input ref={importRef} type="file" accept=".md,.txt" style={{ display: "none" }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleImport(f); e.target.value = ""; }} />
          <button onClick={() => importRef.current?.click()} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 10, cursor: "pointer", fontFamily: "inherit", padding: "3px 8px" }}
            onMouseEnter={e => e.currentTarget.style.color = "var(--text)"}
            onMouseLeave={e => e.currentTarget.style.color = "var(--muted)"}>
            import
          </button>
          {messages.length > 0 && (
            <button onClick={exportChat} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 10, cursor: "pointer", fontFamily: "inherit", padding: "3px 8px" }}
              onMouseEnter={e => e.currentTarget.style.color = "var(--text)"}
              onMouseLeave={e => e.currentTarget.style.color = "var(--muted)"}>
              export
            </button>
          )}
          <button onClick={onNewChat} style={{
            display: "flex", alignItems: "center", gap: 4,
            background: "transparent", border: "1px solid var(--line2)",
            borderRadius: 20, color: "var(--text2)",
            fontSize: 10, cursor: "pointer", fontFamily: "inherit", padding: "3px 10px",
            transition: "all 0.15s",
          }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--line2)"; e.currentTarget.style.color = "var(--text2)"; }}>
            + new
          </button>
          <ScopePicker scope={scope} setScope={setScope} files={files} classes={classes} />
        </div>
      </div>

      {/* messages */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px 0 8px" }}>
        {messages.length === 0 && (
          <div style={{ padding: "40px 24px", color: "var(--muted)", animation: "fadeIn 0.3s ease" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
              <div style={{ width: 32, height: 32, borderRadius: "50%", background: "linear-gradient(135deg, var(--accent2), var(--accent))", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 14, fontWeight: 700 }}>C</div>
              <div>
                <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 600 }}>Claudia</div>
                <div style={{ fontSize: 10, color: "var(--muted)" }}>your local AI second brain · context: {scopeLabel}</div>
              </div>
            </div>
            <div style={{ fontSize: 12, color: "var(--text2)", lineHeight: 1.8, marginBottom: 20 }}>
              Ask me anything about your documents, or use a slash command:
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {COMMANDS.filter(c => c.cmd !== "/clear").map(c => (
                <button key={c.cmd} onClick={() => { setInput(c.cmd + " "); inputRef.current?.focus(); }} style={{
                  display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 12px",
                  background: "var(--panel2)", border: "1px solid var(--line2)", borderRadius: "var(--radius-sm)",
                  cursor: "pointer", textAlign: "left", fontFamily: "inherit", transition: "all 0.1s",
                }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--accent-bg)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--line2)"; e.currentTarget.style.background = "var(--panel2)"; }}>
                  <span style={{ color: "var(--accent)", fontSize: 14, flexShrink: 0 }}>{c.icon}</span>
                  <div>
                    <div style={{ color: "var(--accent)", fontSize: 11 }}>{c.cmd}</div>
                    <div style={{ color: "var(--muted)", fontSize: 10, marginTop: 1 }}>{c.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} onViewFile={onViewFile} />
        ))}
        <div ref={bottomRef} style={{ height: 8 }} />
      </div>

      {/* input */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--line)", flexShrink: 0, position: "relative" }}>
        {showPalette && input.startsWith("/") && (
          <CommandPalette
            query={input.split(" ")[0].toLowerCase()}
            onSelect={cmd => { setInput(cmd + " "); setShowPalette(false); inputRef.current?.focus(); }}
            onClose={() => setShowPalette(false)}
          />
        )}
        <div style={{
          display: "flex", alignItems: "flex-end", gap: 8,
          background: "var(--panel2)", border: "1px solid var(--line2)",
          borderRadius: "var(--radius)", padding: "8px 12px",
          transition: "border-color 0.15s",
        }}
          onFocus={() => { /* handled below */ }}
        >
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            onChange={e => {
              setInput(e.target.value);
              const v = e.target.value;
              setShowPalette(v.startsWith("/") && !v.includes(" "));
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
            }}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); setShowPalette(false); send(); }
              if (e.key === "Escape") setShowPalette(false);
            }}
            disabled={loading}
            placeholder={loading ? "thinking…" : "Message Claudia, or type / for commands"}
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none",
              color: loading ? "var(--muted)" : "var(--text)", fontSize: 13,
              fontFamily: "inherit", resize: "none", lineHeight: 1.5,
              caretColor: "var(--accent)", overflow: "hidden",
            }}
          />
          <button
            onClick={send} disabled={loading || !input.trim()}
            style={{
              width: 28, height: 28, borderRadius: "var(--radius-sm)", flexShrink: 0,
              background: loading || !input.trim() ? "var(--line)" : "var(--accent)",
              border: "none", cursor: loading || !input.trim() ? "not-allowed" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: loading || !input.trim() ? "var(--muted)" : "#fff", fontSize: 12,
              transition: "all 0.15s",
            }}>
            {loading ? <span style={{ animation: "pulse 1s infinite" }}>…</span> : "↑"}
          </button>
        </div>
        <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 5, textAlign: "center", opacity: 0.6 }}>
          enter to send · shift+enter for newline · / for commands · ⌘K focus
        </div>
      </div>
    </div>
  );
}

// ── tag input component ────────────────────────────────────────────────────────
function TagInput({ tags, onChange, allTags }: { tags: string[]; onChange: (t: string[]) => void; allTags: string[] }) {
  const [input, setInput] = useState("");
  const suggestions = allTags.filter(t => t.includes(input.toLowerCase()) && !tags.includes(t) && input.length > 0);

  function addTag(tag: string) {
    const clean = tag.trim().toLowerCase();
    if (clean && !tags.includes(clean)) onChange([...tags, clean]);
    setInput("");
  }

  return (
    <div>
      <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>Tags <span style={{ opacity: 0.5 }}>(optional)</span></div>
      {tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
          {tags.map(t => (
            <span key={t} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", background: "var(--accent-bg)", border: "1px solid var(--accent)", borderRadius: 20, fontSize: 10, color: "var(--accent)" }}>
              {t}
              <button onClick={() => onChange(tags.filter(x => x !== t))} style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0, fontSize: 11, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ position: "relative" }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); if (input.trim()) addTag(input); } }}
          placeholder="Add tag, press Enter"
          style={{
            width: "100%", background: "var(--panel2)", border: "1px solid var(--line2)",
            borderRadius: "var(--radius-sm)", padding: "6px 10px", color: "var(--text)",
            fontFamily: "inherit", fontSize: 12, outline: "none", caretColor: "var(--accent)",
          }}
          onFocus={e => e.target.style.borderColor = "var(--accent)"}
          onBlur={e => { e.target.style.borderColor = "var(--line2)"; }}
        />
        {suggestions.length > 0 && (
          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "var(--panel2)", border: "1px solid var(--line2)", borderRadius: "var(--radius-sm)", zIndex: 20, overflow: "hidden" }}>
            {suggestions.slice(0, 5).map(s => (
              <button key={s} onMouseDown={() => addTag(s)} style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", background: "none", border: "none", color: "var(--text2)", fontFamily: "inherit", fontSize: 11, cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--line)"}
                onMouseLeave={e => e.currentTarget.style.background = "none"}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const AUDIO_EXTS_FE = new Set([".mp3", ".mp4", ".wav", ".m4a", ".webm", ".ogg", ".flac", ".mov", ".mkv"]);
function isAudio(filename: string) { return AUDIO_EXTS_FE.has(filename.slice(filename.lastIndexOf(".")).toLowerCase()); }
function fileIcon(f: FileEntry) {
  if (f.file_type === "audio" || isAudio(f.filename)) return "♪";
  if (f.file_type === "note") return "✎";
  return f.filename.split(".").pop()?.toUpperCase() ?? "FILE";
}

// ── upload view ────────────────────────────────────────────────────────────────
function UploadView({ files, onRefresh, onViewFile }: { files: FileEntry[]; onRefresh: () => void; onViewFile: (f: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [className, setClassName] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const grouped: Record<string, FileEntry[]> = {};
  for (const f of files) (grouped[f.class_name || "General"] ??= []).push(f);

  useEffect(() => {
    fetch("/api/tags").then(r => r.json()).then(d => setAllTags(d.tags ?? [])).catch(() => {});
  }, [files]);

  async function pickFile(f: File) {
    setFile(f);
    setStatus(null); setError(null);
    setSuggesting(true);
    try {
      const res = await fetch("/api/suggest-class", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: f.name, existing_classes: Object.keys(grouped) }),
      });
      const data = await res.json();
      if (data.suggestion) setClassName(data.suggestion);
    } catch { /* silent */ }
    setSuggesting(false);
  }

  const filtered = (() => {
    let list = files;
    if (tagFilter) list = list.filter(f => f.tags?.includes(tagFilter));
    if (search.trim()) list = list.filter(f =>
      f.filename.toLowerCase().includes(search.toLowerCase()) ||
      f.class_name.toLowerCase().includes(search.toLowerCase()) ||
      f.tags?.some(t => t.includes(search.toLowerCase()))
    );
    return search.trim() || tagFilter ? list : null;
  })();

  async function submit() {
    if (!file) { setError("Select a file first"); return; }
    if (!className.trim()) { setError("Enter a class name"); return; }
    setError(null); setStatus(null); setLoading(true);
    const isAudioFile = isAudio(file.name);
    if (isAudioFile) setStatus("Transcribing audio — this may take a minute…");
    const form = new FormData();
    form.append("file", file);
    form.append("class_name", className.trim());
    form.append("tags", tags.join(","));
    try {
      const res = await fetch("/api/ingest", { method: "POST", body: form });
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail ?? "Upload failed"); }
      const data = await res.json();
      setStatus(`✓ ${data.filename} ingested (${data.chunk_count} chunks${data.file_type === "audio" ? " · transcribed" : ""})`);
      setFile(null); setClassName(""); setTags([]); onRefresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Upload failed");
    }
    setLoading(false);
  }

  async function deleteFile(filename: string) {
    setDeleting(filename);
    await fetch(`/api/files/${encodeURIComponent(filename)}`, { method: "DELETE" }).catch(() => {});
    onRefresh(); setDeleting(null);
  }

  function toggleClass(c: string) {
    setExpanded(s => { const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n; });
  }

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* left: upload form */}
      <div style={{ width: 300, flexShrink: 0, borderRight: "1px solid var(--line)", padding: "20px 18px", display: "flex", flexDirection: "column", gap: 14, overflowY: "auto" }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text2)", letterSpacing: "0.05em" }}>Add to brain</div>

        {/* drop zone */}
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) pickFile(f); }}
          style={{
            border: `1px dashed ${dragging ? "var(--accent)" : file ? "var(--green)" : "var(--line2)"}`,
            borderRadius: "var(--radius)", padding: "20px 16px", cursor: "pointer", textAlign: "center",
            background: dragging ? "var(--accent-bg)" : file ? "rgba(52,211,153,0.05)" : "var(--panel2)",
            transition: "all 0.15s",
          }}>
          <div style={{ fontSize: 22, marginBottom: 6 }}>{file ? (isAudio(file.name) ? "♪" : "✓") : "↑"}</div>
          <div style={{ color: file ? "var(--green)" : "var(--text2)", fontSize: 12 }}>
            {file ? file.name : "Drop file or click to browse"}
          </div>
          <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>PDF · DOCX · PNG · JPG · MP3 · MP4 · WAV · M4A</div>
          {file && (
            <button onClick={e => { e.stopPropagation(); setFile(null); setClassName(""); }} style={{ marginTop: 8, background: "none", border: "1px solid var(--line2)", borderRadius: 4, color: "var(--muted)", padding: "2px 10px", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>
              remove
            </button>
          )}
        </div>
        <input ref={inputRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.mp3,.mp4,.wav,.m4a,.webm,.ogg,.flac,.mov,.mkv" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) pickFile(f); }} />

        {/* class */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--muted)" }}>Class / subject</span>
            {suggesting && <span style={{ fontSize: 9, color: "var(--accent)", animation: "pulse 1s infinite" }}>suggesting…</span>}
          </div>
          <input
            value={className}
            onChange={e => setClassName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && submit()}
            placeholder="e.g. Biology 101"
            list="class-list"
            style={{
              width: "100%", background: "var(--panel2)", border: `1px solid ${suggesting ? "var(--accent)" : "var(--line2)"}`,
              borderRadius: "var(--radius-sm)", padding: "8px 10px", color: "var(--text)",
              fontFamily: "inherit", fontSize: 12, outline: "none", caretColor: "var(--accent)", transition: "border-color 0.15s",
            }}
            onFocus={e => e.target.style.borderColor = "var(--accent)"}
            onBlur={e => { if (!suggesting) e.target.style.borderColor = "var(--line2)"; }}
          />
          <datalist id="class-list">{Object.keys(grouped).map(c => <option key={c} value={c} />)}</datalist>
        </div>

        <TagInput tags={tags} onChange={setTags} allTags={allTags} />

        <button onClick={submit} disabled={loading || !file || !className.trim()} style={{
          padding: "9px 0", borderRadius: "var(--radius-sm)", fontFamily: "inherit", fontSize: 12, cursor: "pointer",
          background: loading || !file || !className.trim() ? "var(--line)" : "var(--accent)",
          border: "none", color: loading || !file || !className.trim() ? "var(--muted)" : "#fff",
          transition: "all 0.15s", fontWeight: 500,
        }}>
          {loading ? (isAudio(file?.name ?? "") ? "Transcribing…" : "Ingesting…") : "Ingest file"}
        </button>

        {error && <div style={{ color: "var(--red)", fontSize: 11, padding: "8px 10px", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)", borderRadius: "var(--radius-sm)" }}>{error}</div>}
        {status && <div style={{ color: loading ? "var(--amber)" : "var(--green)", fontSize: 11, padding: "8px 10px", background: loading ? "rgba(251,191,36,0.08)" : "rgba(52,211,153,0.08)", border: `1px solid ${loading ? "rgba(251,191,36,0.2)" : "rgba(52,211,153,0.2)"}`, borderRadius: "var(--radius-sm)" }}>{status}</div>}
      </div>

      {/* right: library */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "var(--text2)", fontWeight: 500 }}>Library</span>
          <span style={{ fontSize: 10, color: "var(--muted)" }}>{files.length} files</span>
          {/* tag filter pills */}
          {allTags.length > 0 && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
              {allTags.map(t => (
                <button key={t} onClick={() => setTagFilter(tagFilter === t ? null : t)} style={{
                  padding: "2px 8px", borderRadius: 20, fontSize: 10, cursor: "pointer", fontFamily: "inherit",
                  background: tagFilter === t ? "var(--accent-bg)" : "transparent",
                  border: `1px solid ${tagFilter === t ? "var(--accent)" : "var(--line2)"}`,
                  color: tagFilter === t ? "var(--accent)" : "var(--muted)", transition: "all 0.1s",
                }}>#{t}</button>
              ))}
            </div>
          )}
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
            style={{
              marginLeft: "auto", background: "var(--panel2)", border: "1px solid var(--line2)",
              borderRadius: 20, color: "var(--text)", padding: "4px 12px", fontSize: 11,
              fontFamily: "inherit", outline: "none", width: 140,
            }} />
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
          {files.length === 0 && (
            <div style={{ textAlign: "center", color: "var(--muted)", paddingTop: 60, fontSize: 12 }}>
              <div style={{ fontSize: 24, marginBottom: 10 }}>↑</div>
              No files yet. Upload something to get started.
            </div>
          )}
          {filtered ? (
            <div>
              <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 10 }}>
                {filtered.length} result{filtered.length !== 1 ? "s" : ""}{tagFilter ? ` · #${tagFilter}` : ""}
              </div>
              {filtered.map(f => <FileRow key={f.filename} f={f} deleting={deleting} onDelete={deleteFile} onView={onViewFile} onRefresh={onRefresh} />)}
            </div>
          ) : (
            Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([cls, clsFiles]) => (
              <div key={cls} style={{ marginBottom: 4 }}>
                <button onClick={() => toggleClass(cls)} style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px",
                  background: expanded.has(cls) ? "var(--panel2)" : "transparent",
                  border: "1px solid " + (expanded.has(cls) ? "var(--line2)" : "transparent"),
                  borderRadius: "var(--radius-sm)", cursor: "pointer", fontFamily: "inherit", marginBottom: 2, transition: "all 0.1s",
                }}
                  onMouseEnter={e => { if (!expanded.has(cls)) e.currentTarget.style.background = "var(--panel2)"; }}
                  onMouseLeave={e => { if (!expanded.has(cls)) e.currentTarget.style.background = "transparent"; }}>
                  <span style={{ color: "var(--accent)", fontSize: 9 }}>{expanded.has(cls) ? "▼" : "▶"}</span>
                  <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 500 }}>{cls}</span>
                  <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--muted)" }}>{clsFiles.length}</span>
                </button>
                {expanded.has(cls) && (
                  <div style={{ paddingLeft: 12, borderLeft: "1px solid var(--line2)", marginLeft: 6, marginBottom: 4 }}>
                    {clsFiles.map(f => <FileRow key={f.filename} f={f} deleting={deleting} onDelete={deleteFile} onView={onViewFile} onRefresh={onRefresh} />)}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function FileRow({ f, deleting, onDelete, onView, onRefresh }: { f: FileEntry; deleting: string | null; onDelete: (n: string) => void; onView: (n: string) => void; onRefresh: () => void }) {
  const [hov, setHov] = useState(false);
  const [editingTags, setEditingTags] = useState(false);
  const [localTags, setLocalTags] = useState(f.tags ?? []);
  const icon = fileIcon(f);
  const isAudioFile = f.file_type === "audio" || isAudio(f.filename);

  async function saveTags(newTags: string[]) {
    setLocalTags(newTags);
    await fetch(`/api/files/${encodeURIComponent(f.filename)}/tags`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: newTags }),
    }).catch(() => {});
    onRefresh();
  }

  return (
    <div
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ marginBottom: 2, borderRadius: "var(--radius-sm)", background: hov ? "var(--panel2)" : "transparent", transition: "background 0.1s" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", cursor: "pointer" }} onClick={() => onView(f.filename)}>
        <div style={{
          width: 28, height: 28, borderRadius: 4, flexShrink: 0,
          background: isAudioFile ? "rgba(167,139,250,0.15)" : "var(--line)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: isAudioFile ? 13 : 8, fontWeight: 700,
          color: isAudioFile ? "var(--accent)" : "var(--accent)", letterSpacing: "0.05em",
        }}>{icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "var(--text)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.filename}</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 2, flexWrap: "wrap" }}>
            <span style={{ color: "var(--muted)", fontSize: 9 }}>{f.ingested_at.slice(0, 10)}</span>
            {localTags.map(t => (
              <span key={t} style={{ fontSize: 9, color: "var(--accent)", opacity: 0.7 }}>#{t}</span>
            ))}
          </div>
        </div>
        {hov && (
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            <button onClick={e => { e.stopPropagation(); setEditingTags(v => !v); }} style={{
              background: "none", border: "1px solid var(--line2)", borderRadius: 4, color: "var(--muted)",
              fontSize: 10, padding: "2px 6px", cursor: "pointer", fontFamily: "inherit",
            }}
              onMouseEnter={e => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.borderColor = "var(--accent)"; }}
              onMouseLeave={e => { e.currentTarget.style.color = "var(--muted)"; e.currentTarget.style.borderColor = "var(--line2)"; }}>
              tags
            </button>
            <button onClick={e => { e.stopPropagation(); onDelete(f.filename); }} disabled={deleting === f.filename} style={{
              background: "none", border: "1px solid var(--line2)", borderRadius: 4, color: "var(--red)",
              fontSize: 10, padding: "2px 6px", cursor: "pointer", fontFamily: "inherit",
            }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "var(--red)"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "var(--line2)"}>
              {deleting === f.filename ? "…" : "×"}
            </button>
          </div>
        )}
      </div>
      {editingTags && (
        <div style={{ padding: "4px 8px 10px 44px" }} onClick={e => e.stopPropagation()}>
          <TagInput tags={localTags} onChange={saveTags} allTags={[]} />
        </div>
      )}
    </div>
  );
}

// ── docs view ──────────────────────────────────────────────────────────────────
const DOCS: { title: string; content: string }[] = [
  {
    title: "Getting started",
    content: `Claudia is your local AI second brain. All data stays on your machine — nothing goes to the cloud.

**How it works:**
1. Upload documents (PDF, image, DOCX) via the Library tab
2. Claudia chunks and embeds them into a local vector database
3. Ask questions in chat — Claudia retrieves relevant passages and answers using llama3.2

**First steps:**
- Upload a PDF or image from the Library tab
- Give it a class name (e.g. "Biology 101")
- Switch to Chat and ask a question about it`,
  },
  {
    title: "/summary — Summarize content",
    content: `/summary
Summarize everything in your brain.

/summary Biology 101
Summarize all files tagged with the "Biology 101" class.

/summary lecture-notes.pdf
Summarize a specific file.

**Tip:** Use the scope selector (top-right of chat) to pre-set a class or file, then just type /summary with no arguments.`,
  },
  {
    title: "/outline — Structured outline",
    content: `/outline
Generate a hierarchical outline of all your documents.

/outline Chemistry
Generate an outline scoped to the Chemistry class.

/outline chapter3.pdf
Outline a single file.

The outline uses Roman numerals (I, II, III) for top-level topics and letters (A, B, C) for subtopics — useful for building study guides.`,
  },
  {
    title: "/flashcards — Study cards",
    content: `/flashcards
Generate 10 flashcards from everything.

/flashcards 20
Generate 20 flashcards.

/flashcards Biology 101 15
Generate 15 flashcards scoped to Biology 101.

/flashcards midterm-notes.pdf
Flashcards from a specific file.

**Controls:**
- Click the card (or press Space) to flip
- ← → to navigate
- "✓ know it" to mark as learned and skip forward
- Progress bar tracks how many you've mastered`,
  },
  {
    title: "/quiz — Multiple-choice quiz",
    content: `/quiz
Generate a 5-question quiz from all your docs.

/quiz 10
Generate 10 questions.

/quiz Calculus 8
Generate 8 questions scoped to Calculus.

/quiz notes.pdf 5
Quiz from a specific file.

**How to use:**
- Select an answer to reveal if it's correct
- Read the explanation — it cites your notes
- Hit "next →" to continue
- Final score shown at the end`,
  },
  {
    title: "/explain — Deep explanation",
    content: `/explain mitosis
Explain "mitosis" using your Biology notes.

/explain the chain rule
Explain the chain rule using your Calculus notes.

Works best when you've set your scope (top-right picker) to the relevant class first, or after typing /explain you can include a class name:

/explain photosynthesis in Biology 101

Claudia finds the most relevant passages in your notes and explains the concept clearly, citing your own material.`,
  },
  {
    title: "/search — Semantic search",
    content: `/search protein folding
Find the most relevant chunks about "protein folding" across all docs.

/search returns ranked results with match scores:
- 90%+ = highly relevant
- 70–90% = relevant
- below 70% = loosely related

Click on a source chip to open the original file in the viewer.

**Tip:** Use /search to find exactly where something is before asking a detailed question with /explain.`,
  },
  {
    title: "/note — Quick notes",
    content: `/note The mitochondria is the powerhouse of the cell
Instantly saves this text to your General class.

Set your scope to a specific class first, or your note goes to "General".

Notes are chunked and embedded just like files — Claudia can reference them in future answers.

**Use cases:**
- Lecture notes typed on the fly
- Key facts to remember
- Links between topics ("Krebs cycle connects to ATP synthesis — see ch. 4")`,
  },
  {
    title: "/stats — Knowledge base info",
    content: `/stats
Shows a breakdown of your knowledge base:
- Total chunks, files, and classes
- Per-class file and chunk count

Use this to see what Claudia knows about and identify gaps.`,
  },
  {
    title: "Context scoping",
    content: `The **◎ scope selector** (top-right of chat) lets you focus Claudia on a specific class or file.

**All docs** — searches everything (default)
**Class scope** — only searches files tagged with that class
**File scope** — only searches within that one file

Scoping makes answers more focused and prevents interference between subjects.

**All slash commands respect the scope.** So if you set scope to "Chemistry" and type /flashcards, you'll get chemistry flashcards without needing to specify a class.

**Override any time** by passing a name as an argument:
/summary Biology 101  (ignores scope, uses Biology 101)`,
  },
  {
    title: "Knowledge graph",
    content: `The **Graph** view shows semantic connections between your files.

- **File nodes** (colored dots) — each uploaded document
- **Class nodes** (glowing rings) — class groups
- **Purple edges** — files with similar content (cosine similarity > 30%)
- **Faint edges** — class membership

**Interactions:**
- Drag nodes to rearrange
- Scroll to zoom
- Hover for details

The graph helps you discover unexpected connections across subjects — useful when studying for interdisciplinary exams.`,
  },
  {
    title: "Keyboard shortcuts",
    content: `⌘K — Focus chat input
⌘U — Jump to Library/Upload

**In chat input:**
/ — Open command palette
↑↓ — Navigate command palette
Tab — Select highlighted command
Enter — Send message
Shift+Enter — Newline

**In flashcards:**
Space — Flip card
← → — Previous / next card

**Everywhere:**
Esc — Close file viewer / command palette`,
  },
];

function DocsView() {
  const [active, setActive] = useState(0);
  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {/* nav */}
      <div style={{ width: 200, flexShrink: 0, borderRight: "1px solid var(--line)", overflowY: "auto", padding: "12px 8px" }}>
        <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--muted)", padding: "4px 8px 10px" }}>documentation</div>
        {DOCS.map((d, i) => (
          <button key={i} onClick={() => setActive(i)} style={{
            display: "block", width: "100%", textAlign: "left", padding: "6px 10px",
            borderRadius: "var(--radius-sm)", background: active === i ? "var(--accent-bg)" : "none",
            border: `1px solid ${active === i ? "var(--accent)" : "transparent"}`,
            color: active === i ? "var(--accent)" : "var(--text2)", fontFamily: "inherit",
            fontSize: 11, cursor: "pointer", marginBottom: 2, transition: "all 0.1s",
          }}
            onMouseEnter={e => { if (active !== i) { e.currentTarget.style.background = "var(--panel2)"; e.currentTarget.style.color = "var(--text)"; } }}
            onMouseLeave={e => { if (active !== i) { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text2)"; } }}>
            {d.title.startsWith("/") ? <span style={{ color: active === i ? "var(--accent)" : "var(--muted)" }}>{d.title}</span> : d.title}
          </button>
        ))}
      </div>

      {/* content */}
      <div style={{ flex: 1, overflow: "auto", padding: "28px 32px" }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 16 }}>{DOCS[active].title}</h1>
        <div
          className="prose"
          style={{ fontSize: 13, lineHeight: 1.85, color: "var(--text2)", maxWidth: 640 }}
          dangerouslySetInnerHTML={{ __html: `<p>${DOCS[active].content
            .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/^- (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.*<\/li>\n?)+/g, s => `<ul>${s}</ul>`)
            .replace(/\n\n/g, '</p><p>')
          }</p>` }}
        />
      </div>
    </div>
  );
}

// ── conversation row ───────────────────────────────────────────────────────────
function ConvRow({ conv, active, onLoad, onDelete }: { conv: ConvMeta; active: boolean; onLoad: () => void; onDelete: () => void }) {
  const [hov, setHov] = useState(false);
  const ago = (() => {
    const d = new Date(conv.updatedAt);
    const mins = Math.floor((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  })();

  return (
    <div
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        display: "flex", alignItems: "flex-start", gap: 6, padding: "6px 8px",
        borderRadius: "var(--radius-sm)", marginBottom: 2, cursor: "pointer",
        background: active ? "var(--accent-bg)" : hov ? "var(--line)" : "transparent",
        border: `1px solid ${active ? "var(--accent)" : "transparent"}`,
        transition: "all 0.1s",
      }}
      onClick={onLoad}>
      <span style={{ color: active ? "var(--accent)" : "var(--muted)", fontSize: 11, marginTop: 1, flexShrink: 0 }}>◎</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: active ? "var(--accent)" : "var(--text2)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {conv.title}
        </div>
        <div style={{ color: "var(--muted)", fontSize: 9, marginTop: 1 }}>{ago} · {conv.messageCount} msgs</div>
      </div>
      {hov && (
        <button onClick={e => { e.stopPropagation(); onDelete(); }} style={{
          background: "none", border: "none", color: "var(--muted)", cursor: "pointer",
          fontSize: 12, padding: "0 2px", lineHeight: 1, flexShrink: 0,
        }}
          onMouseEnter={e => e.currentTarget.style.color = "var(--red)"}
          onMouseLeave={e => e.currentTarget.style.color = "var(--muted)"}>×</button>
      )}
    </div>
  );
}

// ── resizable sidebar ──────────────────────────────────────────────────────────
function Sidebar({ view, setView, files, classes, chunkCount, onViewFile, width, onResize, conversations, activeConvId, onLoadConv, onDeleteConv, onNewChat }: {
  view: string; setView: (v: string) => void;
  files: FileEntry[]; classes: string[]; chunkCount: number;
  onViewFile: (f: string) => void;
  width: number; onResize: (w: number) => void;
  conversations: ConvMeta[]; activeConvId: string;
  onLoadConv: (id: string) => void; onDeleteConv: (id: string) => void;
  onNewChat: () => void;
}) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  function onMouseDown(e: React.MouseEvent) {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      onResize(Math.max(160, Math.min(400, startW.current + delta)));
    }
    function onUp() {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [onResize]);

  const navItems = [
    { id: "chat",   label: "Chat",    icon: "◎" },
    { id: "upload", label: "Library", icon: "↑" },
    { id: "graph",  label: "Graph",   icon: "⟐" },
    { id: "docs",   label: "Docs",    icon: "?" },
  ];

  return (
    <div style={{ width, flexShrink: 0, display: "flex", position: "relative" }}>
      <div style={{ flex: 1, background: "var(--panel)", borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* wordmark */}
        <div style={{ padding: "14px 16px 12px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 24, height: 24, borderRadius: "50%", background: "linear-gradient(135deg, var(--accent2), var(--accent))", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>C</div>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", letterSpacing: "0.06em" }}>claudia</span>
          <span style={{ fontSize: 9, color: "var(--muted)", marginLeft: "auto", padding: "1px 6px", border: "1px solid var(--line2)", borderRadius: 10 }}>local</span>
        </div>

        {/* nav */}
        <div style={{ padding: "8px 8px", borderBottom: "1px solid var(--line)" }}>
          {navItems.map(n => (
            <button key={n.id} onClick={() => setView(n.id)} style={{
              display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 10px",
              borderRadius: "var(--radius-sm)", border: "none", cursor: "pointer", fontFamily: "inherit",
              background: view === n.id ? "var(--accent-bg)" : "transparent",
              color: view === n.id ? "var(--accent)" : "var(--text2)",
              fontSize: 12, transition: "all 0.1s",
            }}
              onMouseEnter={e => { if (view !== n.id) { e.currentTarget.style.background = "var(--line)"; e.currentTarget.style.color = "var(--text)"; } }}
              onMouseLeave={e => { if (view !== n.id) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text2)"; } }}>
              <span style={{ fontSize: 13, width: 16, textAlign: "center" }}>{n.icon}</span>
              {width > 180 && <span>{n.label}</span>}
            </button>
          ))}
        </div>

        {/* stats */}
        {width > 170 && (
          <div style={{ padding: "10px 16px 8px", borderBottom: "1px solid var(--line)" }}>
            <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>index</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              {[["chunks", chunkCount], ["files", files.length], ["classes", classes.length]].map(([label, val]) => (
                <div key={label as string} style={{ textAlign: "center", padding: "6px 4px", background: "var(--panel2)", borderRadius: "var(--radius-sm)", border: "1px solid var(--line2)" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--accent)" }}>{val}</div>
                  <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 1 }}>{label}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* conversations (chat view) or recent files (other views) */}
        {width > 170 && (
          <div style={{ flex: 1, overflow: "auto", padding: "8px 10px" }}>
            {view === "chat" ? (
              <>
                <div style={{ display: "flex", alignItems: "center", padding: "4px 6px 8px" }}>
                  <span style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--muted)" }}>conversations</span>
                  <button onClick={onNewChat} style={{
                    marginLeft: "auto", background: "none", border: "1px solid var(--line2)",
                    borderRadius: 10, color: "var(--muted)", fontSize: 9, padding: "1px 7px",
                    cursor: "pointer", fontFamily: "inherit",
                  }}
                    onMouseEnter={e => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.borderColor = "var(--accent)"; }}
                    onMouseLeave={e => { e.currentTarget.style.color = "var(--muted)"; e.currentTarget.style.borderColor = "var(--line2)"; }}>
                    + new
                  </button>
                </div>
                {conversations.length === 0 && (
                  <div style={{ color: "var(--muted)", fontSize: 11, padding: "0 6px" }}>no saved chats yet</div>
                )}
                {conversations.map(c => (
                  <ConvRow key={c.id} conv={c} active={c.id === activeConvId}
                    onLoad={() => { onLoadConv(c.id); setView("chat"); }}
                    onDelete={() => onDeleteConv(c.id)} />
                ))}
              </>
            ) : (
              <>
                <div style={{ fontSize: 9, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--muted)", padding: "4px 6px 8px" }}>recent files</div>
                {files.length === 0 && <div style={{ color: "var(--muted)", fontSize: 11, padding: "0 6px" }}>no files yet</div>}
                {files.slice(0, 12).map((f, i) => (
                  <button key={i} onClick={() => onViewFile(f.filename)} style={{
                    display: "block", width: "100%", textAlign: "left", padding: "6px 8px",
                    borderRadius: "var(--radius-sm)", border: "none", background: "none",
                    cursor: "pointer", fontFamily: "inherit", marginBottom: 2,
                  }}
                    onMouseEnter={e => e.currentTarget.style.background = "var(--line)"}
                    onMouseLeave={e => e.currentTarget.style.background = "none"}>
                    <div style={{ color: "var(--text2)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.filename}</div>
                    <div style={{ color: "var(--muted)", fontSize: 9, marginTop: 1 }}>{f.class_name}</div>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {/* drag handle */}
      <div
        onMouseDown={onMouseDown}
        style={{
          position: "absolute", right: -3, top: 0, bottom: 0, width: 6,
          cursor: "col-resize", zIndex: 10,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
        title="Drag to resize sidebar"
      >
        <div style={{ width: 2, height: 32, background: "var(--line2)", borderRadius: 2, opacity: 0, transition: "opacity 0.15s" }}
          onMouseEnter={e => e.currentTarget.style.opacity = "1"}
          onMouseLeave={e => e.currentTarget.style.opacity = "0"} />
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
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [convId, setConvId] = useState(() => newConvId());
  const [conversations, setConversations] = useState<ConvMeta[]>([]);

  const refreshConvs = useCallback(() => setConversations(listConversations()), []);

  const refresh = useCallback(async () => {
    try {
      const [f, c, h] = await Promise.all([apiGet("files"), apiGet("classes"), apiGet("health")]);
      setFiles(f.files); setClasses(c.classes); setChunkCount(h.chunks);
    } catch { }
  }, []);

  useEffect(() => { refresh(); const id = setInterval(refresh, 5000); return () => clearInterval(id); }, [refresh]);
  useEffect(() => { refreshConvs(); }, [refreshConvs]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "u") { e.preventDefault(); setView("upload"); }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setView("chat"); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  function handleNewChat() { setConvId(newConvId()); setView("chat"); }
  function handleLoadConv(id: string) { setConvId(id); setView("chat"); }
  function handleDeleteConv(id: string) {
    deleteConversation(id);
    refreshConvs();
    if (id === convId) handleNewChat();
  }

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "var(--bg)" }}>
      <Sidebar
        view={view} setView={setView}
        files={files} classes={classes} chunkCount={chunkCount}
        onViewFile={setViewingFile}
        width={sidebarWidth} onResize={setSidebarWidth}
        conversations={conversations} activeConvId={convId}
        onLoadConv={handleLoadConv} onDeleteConv={handleDeleteConv}
        onNewChat={handleNewChat}
      />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {view === "chat" && (
          <ChatView
            files={files} classes={classes} onViewFile={setViewingFile}
            convId={convId} onConvSaved={refreshConvs} onNewChat={handleNewChat}
          />
        )}
        {view === "upload" && <UploadView files={files} onRefresh={refresh} onViewFile={setViewingFile} />}
        {view === "graph"  && <Graph />}
        {view === "docs"   && <DocsView />}
      </div>
      {viewingFile && <FileViewer filename={viewingFile} onClose={() => setViewingFile(null)} />}
    </div>
  );
}
