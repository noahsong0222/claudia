import os
import uuid
import json
import shutil
from datetime import datetime
from pathlib import Path

import pytesseract
from PIL import Image
import chromadb
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_ollama import OllamaEmbeddings

UPLOADS_DIR = Path(__file__).parent / "uploads"
DB_DIR = Path(__file__).parent / "db"
UPLOADS_DIR.mkdir(exist_ok=True)
DB_DIR.mkdir(exist_ok=True)

_client = chromadb.PersistentClient(path=str(DB_DIR))
_collection = _client.get_or_create_collection("claudia")
_embeddings = OllamaEmbeddings(model="nomic-embed-text")
_splitter = RecursiveCharacterTextSplitter(
    chunk_size=500,
    chunk_overlap=50,
    separators=["\n\n", "\n", ". ", " ", ""],
)

AUDIO_EXTS = {".mp3", ".mp4", ".wav", ".m4a", ".webm", ".ogg", ".flac", ".mov", ".mkv"}
IMAGE_EXTS  = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif", ".gif"}

# lazy whisper model – loaded on first audio ingest
_whisper_model = None


def _get_whisper():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        print("Loading Whisper model (first run – downloads ~150 MB)…")
        _whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
    return _whisper_model


# ── extractors ─────────────────────────────────────────────────────────────────

def _extract_pdf(path: Path) -> str:
    from pypdf import PdfReader
    reader = PdfReader(str(path))
    pages = [page.extract_text() or "" for page in reader.pages]
    text = "\n\n".join(pages).strip()
    if text:
        return text
    try:
        import fitz
        doc = fitz.open(str(path))
        parts = []
        for page in doc:
            pix = page.get_pixmap(dpi=200)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            parts.append(pytesseract.image_to_string(img))
        return "\n\n".join(parts).strip()
    except ImportError:
        raise RuntimeError("PDF had no extractable text and PyMuPDF is not installed for OCR fallback.")


def _extract_image(path: Path) -> str:
    return pytesseract.image_to_string(Image.open(path)).strip()


def _extract_docx(path: Path) -> str:
    from docx import Document
    doc = Document(str(path))
    return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())


def _extract_audio(path: Path) -> str:
    """Transcribe audio/video using faster-whisper (runs fully locally)."""
    model = _get_whisper()
    print(f"Transcribing {path.name} (this may take a minute)…")
    segments, info = model.transcribe(str(path), beam_size=5)
    print(f"  Detected language: {info.language} ({info.language_probability:.0%} confidence)")
    text = " ".join(seg.text.strip() for seg in segments)
    return text.strip()


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return _extract_pdf(path)
    if suffix in IMAGE_EXTS:
        return _extract_image(path)
    if suffix in {".docx", ".doc"}:
        return _extract_docx(path)
    if suffix in AUDIO_EXTS:
        return _extract_audio(path)
    raise ValueError(f"Unsupported file type: {suffix}")


def is_audio(path: Path) -> bool:
    return path.suffix.lower() in AUDIO_EXTS


# ── tags helpers ───────────────────────────────────────────────────────────────

def encode_tags(tags: list[str]) -> str:
    """Encode tag list as a JSON string for ChromaDB storage."""
    cleaned = [t.strip().lower() for t in tags if t.strip()]
    return json.dumps(sorted(set(cleaned)))


def decode_tags(tags_str: str | None) -> list[str]:
    if not tags_str:
        return []
    try:
        return json.loads(tags_str)
    except Exception:
        # legacy: comma-separated plain string
        return [t.strip() for t in tags_str.split(",") if t.strip()]


# ── ingest ─────────────────────────────────────────────────────────────────────

def ingest_file(
    source_path: str | Path,
    class_name: str = "General",
    tags: list[str] | None = None,
) -> dict:
    source_path = Path(source_path)
    if not source_path.exists():
        raise FileNotFoundError(source_path)

    dest = UPLOADS_DIR / source_path.name
    if source_path.resolve() != dest.resolve():
        shutil.copy2(source_path, dest)

    filename    = dest.name
    ingested_at = datetime.now().isoformat(timespec="seconds")
    class_name  = class_name.strip() or "General"
    tags_str    = encode_tags(tags or [])
    file_type   = "audio" if is_audio(dest) else "document"

    print(f"Extracting text from {filename}…")
    text = extract_text(dest)
    if not text:
        raise ValueError(f"No text could be extracted from {filename}")

    print(f"Splitting into chunks…")
    chunks = _splitter.split_text(text)

    print(f"Embedding {len(chunks)} chunks…")
    vectors = _embeddings.embed_documents(chunks)

    ids = [str(uuid.uuid4()) for _ in chunks]
    metadatas = [
        {
            "filename":    filename,
            "class_name":  class_name,
            "ingested_at": ingested_at,
            "chunk_index": i,
            "tags":        tags_str,
            "file_type":   file_type,
        }
        for i in range(len(chunks))
    ]

    _collection.add(ids=ids, embeddings=vectors, documents=chunks, metadatas=metadatas)

    invalidate_cache()
    total = _collection.count()
    print(f"Done. {len(chunks)} chunks stored (total: {total}).")
    return {
        "filename":         filename,
        "class_name":       class_name,
        "tags":             decode_tags(tags_str),
        "file_type":        file_type,
        "chunk_count":      len(chunks),
        "collection_total": total,
        "ingested_at":      ingested_at,
    }


# ── preview (for auto-tag suggestion) ─────────────────────────────────────────

def extract_preview(path: Path, max_chars: int = 1500) -> str:
    """Extract a short text preview without full chunking/embedding. Fast."""
    try:
        text = extract_text(path)
        return text[:max_chars]
    except Exception:
        return ""


# ── derived-data cache ───────────────────────────────────────────────────────
# get_files / get_classes / get_all_tags / stats all need the same per-file
# rollup of chunk metadata. Scanning the whole collection on every call is fine
# at 20 chunks but O(n) and wasteful at tens of thousands. We compute the rollup
# once, cache it, and invalidate on any write (ingest / delete / tag update /
# note). Reads (the hot path, hit on every UI refresh) become O(1).

_rollup_cache: dict | None = None


def invalidate_cache() -> None:
    """Drop the derived-data cache. Call after any write to the collection."""
    global _rollup_cache
    _rollup_cache = None


def _rollup() -> dict:
    """Build (or return cached) per-file rollup from one full metadata scan."""
    global _rollup_cache
    if _rollup_cache is not None:
        return _rollup_cache

    files: dict[str, dict] = {}
    tags: set[str] = set()

    if _collection.count() > 0:
        all_meta = _collection.get(include=["metadatas"])["metadatas"]
        for m in all_meta:
            key = m["filename"]
            f = files.get(key)
            if f is None:
                f = files[key] = {
                    "filename":    key,
                    "class_name":  m.get("class_name", "General"),
                    "ingested_at": m.get("ingested_at", ""),
                    "tags":        decode_tags(m.get("tags", "")),
                    "file_type":   m.get("file_type", "document"),
                    "chunk_count": 0,
                }
            f["chunk_count"] += 1
            tags.update(f["tags"])

    files_sorted = sorted(files.values(), key=lambda x: x["ingested_at"], reverse=True)
    classes = sorted({f["class_name"] for f in files_sorted})

    _rollup_cache = {
        "files":   files_sorted,
        "classes": classes,
        "tags":    sorted(tags),
    }
    return _rollup_cache


# ── queries ────────────────────────────────────────────────────────────────────

def get_classes() -> list[str]:
    return _rollup()["classes"]


def get_all_tags() -> list[str]:
    """Return a sorted list of every tag used across all files."""
    return _rollup()["tags"]


def get_files() -> list[dict]:
    return _rollup()["files"]


def update_file_tags(filename: str, tags: list[str]) -> int:
    """Update tags on every chunk of a file. Returns chunk count updated."""
    results = _collection.get(where={"filename": filename}, include=["metadatas"])
    ids = results["ids"]
    if not ids:
        return 0
    tags_str = encode_tags(tags)
    updated_metas = [{**m, "tags": tags_str} for m in results["metadatas"]]
    _collection.update(ids=ids, metadatas=updated_metas)
    invalidate_cache()
    return len(ids)


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python ingest.py <file> [class_name] [tag1,tag2]")
        sys.exit(1)
    class_arg = sys.argv[2] if len(sys.argv) > 2 else "General"
    tags_arg  = sys.argv[3].split(",") if len(sys.argv) > 3 else []
    print(ingest_file(sys.argv[1], class_arg, tags_arg))
