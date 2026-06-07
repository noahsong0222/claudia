"use client";

import { useEffect, useState } from "react";

interface Props {
  filename: string;
  onClose: () => void;
}

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif", ".gif"];
const PDF_EXT = ".pdf";
const DOCX_EXTS = [".docx", ".doc"];

function ext(filename: string) {
  return filename.slice(filename.lastIndexOf(".")).toLowerCase();
}

export default function FileViewer({ filename, onClose }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const fileExt = ext(filename);
  const fileUrl = `http://localhost:8000/uploads/${encodeURIComponent(filename)}`;

  // load extracted text for docx
  useEffect(() => {
    if (!DOCX_EXTS.includes(fileExt)) return;
    setTextLoading(true);
    fetch(`/api/files/${encodeURIComponent(filename)}/text`)
      .then((r) => r.json())
      .then((d) => setText(d.text))
      .catch(() => setText("Could not extract text."))
      .finally(() => setTextLoading(false));
  }, [filename, fileExt]);

  // close on Escape
  useEffect(() => {
    function handler(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      {/* backdrop */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 40, backdropFilter: "blur(2px)" }} />

      {/* panel */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0,
        width: "min(760px, 80vw)",
        background: "var(--panel)",
        borderLeft: "1px solid var(--line)",
        zIndex: 50,
        display: "flex", flexDirection: "column",
        animation: "slideIn 0.18s ease-out",
      }}>
        <style>{`
          @keyframes slideIn {
            from { transform: translateX(40px); opacity: 0; }
            to   { transform: translateX(0);    opacity: 1; }
          }
        `}</style>

        {/* header */}
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span style={{ color: "var(--amber)", fontSize: 10 }}>◈</span>
          <span style={{ color: "var(--text)", fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {filename}
          </span>
          <a href={fileUrl} download={filename} style={{ color: "var(--muted)", fontSize: 10, textDecoration: "none", padding: "2px 8px", border: "1px solid var(--line2)", borderRadius: 2 }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}>
            download
          </a>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--muted)", fontSize: 16, cursor: "pointer", padding: "0 4px", lineHeight: 1, fontFamily: "inherit" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}>
            ×
          </button>
        </div>

        {/* content */}
        <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {fileExt === PDF_EXT && (
            <iframe
              src={`${fileUrl}#toolbar=1`}
              style={{ flex: 1, border: "none", width: "100%", background: "#fff" }}
              title={filename}
            />
          )}

          {IMAGE_EXTS.includes(fileExt) && (
            <div style={{ flex: 1, overflow: "auto", padding: 24, display: "flex", alignItems: "flex-start", justifyContent: "center", background: "var(--bg)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={fileUrl} alt={filename} style={{ maxWidth: "100%", borderRadius: 4, border: "1px solid var(--line)" }} />
            </div>
          )}

          {DOCX_EXTS.includes(fileExt) && (
            <div style={{ flex: 1, overflow: "auto", padding: "20px 24px" }}>
              {textLoading && <div style={{ color: "var(--muted)", fontSize: 12 }}>extracting text…</div>}
              {text && (
                <pre style={{ color: "var(--text)", fontSize: 12, lineHeight: 1.8, whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0 }}>
                  {text}
                </pre>
              )}
            </div>
          )}

          {!PDF_EXT.includes(fileExt) && !IMAGE_EXTS.includes(fileExt) && !DOCX_EXTS.includes(fileExt) && (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 12 }}>
              preview not available for this file type
            </div>
          )}
        </div>
      </div>
    </>
  );
}
