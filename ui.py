import tempfile
from pathlib import Path

import streamlit as st

from ingest import ingest_file, get_classes, get_files, _collection
from rag import ask

st.set_page_config(page_title="Claudia", layout="wide", initial_sidebar_state="expanded")

# ── global styles ──────────────────────────────────────────────────────────────
st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');

*, *::before, *::after { box-sizing: border-box; }

:root {
  --bg:      #0e0f11;
  --panel:   #141518;
  --line:    #1e2025;
  --line2:   #272b32;
  --text:    #d4d8e2;
  --muted:   #555b6a;
  --accent:  #c89b5a;
  --acc-dim: rgba(200,155,90,0.08);
  --r:       6px;
}

html, body, .stApp { background: var(--bg) !important; }

#MainMenu, footer, header,
[data-testid="stToolbar"],
[data-testid="stDecoration"],
[data-testid="stStatusWidget"],
.stDeployButton { display: none !important; }

/* sidebar */
[data-testid="stSidebar"] {
  background: var(--panel) !important;
  border-right: 1px solid var(--line) !important;
}
[data-testid="stSidebar"] > div:first-child {
  padding: 24px 18px 20px !important;
}

/* main */
.main .block-container {
  padding: 36px 40px 80px !important;
  max-width: 760px !important;
}

/* base text */
p, li, span, label, div {
  font-family: 'Inter', sans-serif !important;
  font-size: 14px !important;
  color: var(--text) !important;
  line-height: 1.65 !important;
}

/* wordmark */
.cl-wordmark {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--text);
  padding-bottom: 18px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 18px;
  display: flex;
  align-items: center;
  gap: 7px;
}
.cl-dot {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: var(--accent);
  display: inline-block;
  flex-shrink: 0;
}

/* nav links */
.nav-item {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  padding: 7px 10px;
  border-radius: var(--r);
  cursor: pointer;
  text-decoration: none;
  transition: color 0.15s, background 0.15s;
  margin-bottom: 2px;
  border: none;
  background: none;
  width: 100%;
  text-align: left;
}
.nav-item.active {
  color: var(--text);
  background: var(--line);
}
.nav-item:hover { color: var(--text); background: var(--line); }

/* section label */
.sb-label {
  display: block;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 18px 0 8px;
}

/* stat */
.stat-row {
  font-family: 'IBM Plex Mono', monospace !important;
  font-size: 11px !important;
  color: var(--muted) !important;
  padding: 4px 0;
}
.stat-row b { color: var(--accent) !important; font-weight: 500 !important; }

/* file list in sidebar */
.sb-file {
  padding: 5px 0;
  border-bottom: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sb-file:last-child { border-bottom: none; }
.sb-filename { font-size: 11px !important; color: var(--text) !important; word-break: break-all; }
.sb-filemeta { font-size: 10px !important; color: var(--muted) !important; }

/* page headings */
.page-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: -0.02em;
  margin-bottom: 4px;
}
.page-sub {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 28px;
  line-height: 1.5;
}

/* upload card */
.upload-card {
  background: var(--panel);
  border: 1px solid var(--line2);
  border-radius: var(--r);
  padding: 24px;
  margin-bottom: 16px;
}

/* file uploader */
[data-testid="stFileUploaderDropzone"],
[data-testid="stFileUploadDropzone"] {
  background: var(--bg) !important;
  border: 1px solid var(--line2) !important;
  border-radius: var(--r) !important;
}
[data-testid="stFileUploaderDropzone"]:hover,
[data-testid="stFileUploadDropzone"]:hover {
  border-color: rgba(200,155,90,0.5) !important;
  background: var(--acc-dim) !important;
}
[data-testid="stFileUploaderDropzone"] *,
[data-testid="stFileUploadDropzone"] * {
  color: var(--muted) !important;
  font-size: 12px !important;
}

/* text input */
[data-testid="stTextInput"] input,
[data-testid="stSelectbox"] select,
.stTextInput input {
  background: var(--bg) !important;
  border: 1px solid var(--line2) !important;
  border-radius: var(--r) !important;
  color: var(--text) !important;
  font-family: 'Inter', sans-serif !important;
  font-size: 13px !important;
}
[data-testid="stTextInput"] input:focus,
.stTextInput input:focus {
  border-color: rgba(200,155,90,0.5) !important;
  box-shadow: 0 0 0 2px var(--acc-dim) !important;
}
[data-testid="stTextInput"] label,
.stTextInput label {
  font-size: 11px !important;
  font-weight: 600 !important;
  letter-spacing: 0.08em !important;
  text-transform: uppercase !important;
  color: var(--muted) !important;
}

/* selectbox */
[data-testid="stSelectbox"] > div > div {
  background: var(--bg) !important;
  border: 1px solid var(--line2) !important;
  border-radius: var(--r) !important;
  color: var(--text) !important;
}
[data-testid="stSelectbox"] label {
  font-size: 11px !important;
  font-weight: 600 !important;
  letter-spacing: 0.08em !important;
  text-transform: uppercase !important;
  color: var(--muted) !important;
}

/* button */
.stButton > button {
  background: var(--acc-dim) !important;
  border: 1px solid rgba(200,155,90,0.3) !important;
  border-radius: var(--r) !important;
  color: var(--accent) !important;
  font-family: 'Inter', sans-serif !important;
  font-size: 12px !important;
  font-weight: 500 !important;
  letter-spacing: 0.04em !important;
  padding: 6px 16px !important;
  transition: background 0.15s, border-color 0.15s !important;
}
.stButton > button:hover {
  background: rgba(200,155,90,0.15) !important;
  border-color: rgba(200,155,90,0.5) !important;
}

/* recent uploads table */
.doc-row {
  display: grid;
  grid-template-columns: 1fr 120px 120px;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
  align-items: center;
}
.doc-row:last-child { border-bottom: none; }
.doc-row-header {
  font-size: 9px !important;
  font-weight: 600 !important;
  letter-spacing: 0.14em !important;
  text-transform: uppercase !important;
  color: var(--muted) !important;
}
.doc-name { font-size: 12px !important; color: var(--text) !important; word-break: break-all; }
.doc-class {
  font-size: 11px !important;
  color: var(--muted) !important;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 2px 7px;
  display: inline-block;
  font-family: 'IBM Plex Mono', monospace !important;
}
.doc-date { font-size: 11px !important; color: var(--muted) !important; font-family: 'IBM Plex Mono', monospace !important; }

/* chat messages */
.msg { display: flex; flex-direction: column; gap: 4px; margin-bottom: 20px; }
.msg-role {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  padding: 0 2px;
}
.msg-bubble {
  font-size: 14px;
  line-height: 1.7;
  color: var(--text);
}
.msg.user .msg-bubble {
  background: var(--panel);
  border: 1px solid var(--line2);
  border-radius: var(--r);
  padding: 10px 14px;
  max-width: 600px;
}
.msg.assistant .msg-bubble { padding: 0; }

.src-wrap { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.src-chip {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 2px 6px;
}

/* chat input */
[data-testid="stChatInputContainer"],
.stChatFloatingInputContainer {
  background: var(--bg) !important;
  border-top: 1px solid var(--line) !important;
  padding: 14px 40px !important;
}
[data-testid="stChatInput"] {
  background: var(--panel) !important;
  border: 1px solid var(--line2) !important;
  border-radius: var(--r) !important;
  color: var(--text) !important;
  font-family: 'Inter', sans-serif !important;
  font-size: 14px !important;
}
[data-testid="stChatInput"]:focus-within {
  border-color: rgba(200,155,90,0.4) !important;
  box-shadow: 0 0 0 2px var(--acc-dim) !important;
}
[data-testid="stChatInput"] textarea::placeholder { color: var(--muted) !important; }

/* alerts */
[data-testid="stAlert"] { border-radius: var(--r) !important; font-size: 13px !important; }
.stSpinner > div > div { border-top-color: var(--accent) !important; }

/* scrollbar */
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--line2); border-radius: 2px; }

hr { border: none !important; border-top: 1px solid var(--line) !important; margin: 20px 0 !important; }
</style>
""", unsafe_allow_html=True)


# ── session state ──────────────────────────────────────────────────────────────
if "page" not in st.session_state:
    st.session_state.page = "chat"
if "messages" not in st.session_state:
    st.session_state.messages = []
if "upload_success" not in st.session_state:
    st.session_state.upload_success = None


# ── sidebar ────────────────────────────────────────────────────────────────────
with st.sidebar:
    st.markdown('<div class="cl-wordmark"><span class="cl-dot"></span>Claudia</div>', unsafe_allow_html=True)

    if st.button("Chat", key="nav_chat"):
        st.session_state.page = "chat"
        st.rerun()
    if st.button("Upload", key="nav_upload"):
        st.session_state.page = "upload"
        st.rerun()

    count = _collection.count()
    files = get_files()
    classes = get_classes()

    st.markdown('<span class="sb-label">Library</span>', unsafe_allow_html=True)
    st.markdown(
        f'<div class="stat-row"><b>{count}</b> chunks &nbsp;·&nbsp; <b>{len(files)}</b> files &nbsp;·&nbsp; <b>{len(classes)}</b> classes</div>',
        unsafe_allow_html=True,
    )

    if files:
        st.markdown('<span class="sb-label">Recent</span>', unsafe_allow_html=True)
        for f in files[:8]:
            date = f["ingested_at"][:10]
            st.markdown(
                f'<div class="sb-file">'
                f'<span class="sb-filename">{f["filename"]}</span>'
                f'<span class="sb-filemeta">{f["class_name"]} · {date}</span>'
                f'</div>',
                unsafe_allow_html=True,
            )


# ── upload page ────────────────────────────────────────────────────────────────
if st.session_state.page == "upload":
    st.markdown('<div class="page-title">Upload</div>', unsafe_allow_html=True)
    st.markdown('<div class="page-sub">Add a PDF, image, or document to your second brain.</div>', unsafe_allow_html=True)

    with st.container():
        uploaded = st.file_uploader(
            "File",
            type=["pdf", "png", "jpg", "jpeg", "webp", "tiff", "docx"],
            label_visibility="collapsed",
        )

        class_input = st.text_input(
            "Class / Category",
            placeholder="e.g. Biology 101, History, Work",
        )

        if st.button("Ingest file") and uploaded:
            if not class_input.strip():
                st.error("Please enter a class or category name.")
            else:
                with st.spinner(f"Processing {uploaded.name}…"):
                    suffix = Path(uploaded.name).suffix
                    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                        tmp.write(uploaded.read())
                        tmp_path = tmp.name
                    try:
                        result = ingest_file(tmp_path, class_input.strip())
                        dest = Path(tmp_path).parent / uploaded.name
                        Path(tmp_path).rename(dest)
                        st.session_state.upload_success = result
                        st.rerun()
                    except Exception as e:
                        st.error(f"Failed: {e}")

    if st.session_state.upload_success:
        r = st.session_state.upload_success
        st.success(f"✓ {r['filename']} · {r['chunk_count']} chunks · {r['class_name']}")
        st.session_state.upload_success = None

    files = get_files()
    if files:
        st.markdown("<br>", unsafe_allow_html=True)
        st.markdown('<div class="page-title" style="font-size:15px;">All documents</div>', unsafe_allow_html=True)
        st.markdown("<br>", unsafe_allow_html=True)

        header = '<div class="doc-row"><span class="doc-row-header">Filename</span><span class="doc-row-header">Class</span><span class="doc-row-header">Date</span></div>'
        rows = "".join(
            f'<div class="doc-row">'
            f'<span class="doc-name">{f["filename"]}</span>'
            f'<span class="doc-class">{f["class_name"]}</span>'
            f'<span class="doc-date">{f["ingested_at"][:10]}</span>'
            f'</div>'
            for f in files
        )
        st.markdown(f'<div>{header}{rows}</div>', unsafe_allow_html=True)


# ── chat page ──────────────────────────────────────────────────────────────────
elif st.session_state.page == "chat":
    classes = get_classes()

    col1, col2 = st.columns([3, 1])
    with col1:
        st.markdown('<div class="page-title">Chat</div>', unsafe_allow_html=True)
    with col2:
        if classes:
            filter_class = st.selectbox(
                "Filter by class",
                ["All classes"] + classes,
                label_visibility="collapsed",
            )
            active_class = None if filter_class == "All classes" else filter_class
        else:
            active_class = None

    if not st.session_state.messages and _collection.count() == 0:
        st.markdown(
            '<div style="padding: 60px 0; color: #3a3f4a; font-size: 13px;">'
            'No documents yet. Go to <strong style="color:#555b6a;">Upload</strong> to add your first file.'
            '</div>',
            unsafe_allow_html=True,
        )
    elif not st.session_state.messages:
        st.markdown(
            '<div style="padding: 60px 0; color: #3a3f4a; font-size: 13px;">Ask anything about your notes.</div>',
            unsafe_allow_html=True,
        )

    for msg in st.session_state.messages:
        sources = msg.get("sources", [])
        chips = ""
        if sources:
            seen = set()
            chip_list = []
            for s in sources:
                k = (s["filename"], s["class_name"])
                if k not in seen:
                    seen.add(k)
                    chip_list.append(f'<span class="src-chip">{s["filename"]} · {s["class_name"]}</span>')
            chips = f'<div class="src-wrap">{"".join(chip_list)}</div>'

        st.markdown(
            f'<div class="msg {msg["role"]}">'
            f'<div class="msg-role">{"you" if msg["role"] == "user" else "claudia"}</div>'
            f'<div class="msg-bubble">{msg["content"]}</div>'
            f'{chips}'
            f'</div>',
            unsafe_allow_html=True,
        )

    if prompt := st.chat_input("Ask Claudia…"):
        st.session_state.messages.append({"role": "user", "content": prompt, "sources": []})

        if _collection.count() == 0:
            reply, sources = "No documents ingested yet. Go to Upload first.", []
        else:
            with st.spinner(""):
                result = ask(prompt, class_name=active_class if classes else None)
            reply, sources = result["answer"], result["sources"]

        st.session_state.messages.append({"role": "assistant", "content": reply, "sources": sources})
        st.rerun()
