import os
import uuid
from datetime import datetime
from pathlib import Path

import pytesseract
from PIL import Image
import chromadb
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_ollama import OllamaEmbeddings

# ── paths ──────────────────────────────────────────────────────────────────────
UPLOADS_DIR = Path(__file__).parent / "uploads"
DB_DIR = Path(__file__).parent / "db"
UPLOADS_DIR.mkdir(exist_ok=True)
DB_DIR.mkdir(exist_ok=True)

# ── Chroma client + collection ─────────────────────────────────────────────────
_client = chromadb.PersistentClient(path=str(DB_DIR))
_collection = _client.get_or_create_collection("claudia")

# ── embeddings (nomic-embed-text is lightweight and ships with Ollama) ─────────
_embeddings = OllamaEmbeddings(model="nomic-embed-text")

# ── text splitter ──────────────────────────────────────────────────────────────
_splitter = RecursiveCharacterTextSplitter(
    chunk_size=500,
    chunk_overlap=50,
    separators=["\n\n", "\n", ". ", " ", ""],
)


# ── extraction helpers ─────────────────────────────────────────────────────────

def _extract_pdf(path: Path) -> str:
    """Extract text from a PDF using PyMuPDF (fitz) with pytesseract fallback."""
    try:
        import fitz  # PyMuPDF
        doc = fitz.open(str(path))
        pages = [page.get_text() for page in doc]
        text = "\n\n".join(pages).strip()
        if text:
            return text
    except ImportError:
        pass  # fall through to OCR

    # OCR fallback: render each page as an image
    try:
        import fitz
        doc = fitz.open(str(path))
        parts = []
        for page in doc:
            pix = page.get_pixmap(dpi=200)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            parts.append(pytesseract.image_to_string(img))
        return "\n\n".join(parts).strip()
    except Exception as exc:
        raise RuntimeError(f"PDF extraction failed: {exc}") from exc


def _extract_image(path: Path) -> str:
    """Extract text from an image via OCR."""
    img = Image.open(path)
    return pytesseract.image_to_string(img).strip()


def extract_text(path: Path) -> str:
    """Dispatch to the right extractor based on file extension."""
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return _extract_pdf(path)
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif", ".gif"}:
        return _extract_image(path)
    raise ValueError(f"Unsupported file type: {suffix}")


# ── main ingest function ───────────────────────────────────────────────────────

def ingest_file(source_path: str | Path) -> dict:
    """
    Ingest a PDF or image into the Chroma vector DB.

    Returns a summary dict with filename, chunk_count, and collection size.
    """
    source_path = Path(source_path)
    if not source_path.exists():
        raise FileNotFoundError(source_path)

    # copy to uploads/ if not already there
    dest = UPLOADS_DIR / source_path.name
    if source_path.resolve() != dest.resolve():
        import shutil
        shutil.copy2(source_path, dest)

    filename = dest.name
    ingested_at = datetime.now().isoformat(timespec="seconds")

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
        {"filename": filename, "ingested_at": ingested_at, "chunk_index": i}
        for i in range(len(chunks))
    ]

    _collection.add(
        ids=ids,
        embeddings=vectors,
        documents=chunks,
        metadatas=metadatas,
    )

    total = _collection.count()
    print(f"Done. {len(chunks)} chunks stored (collection total: {total}).")
    return {
        "filename": filename,
        "chunk_count": len(chunks),
        "collection_total": total,
        "ingested_at": ingested_at,
    }


# ── CLI ────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python ingest.py <file>")
        sys.exit(1)

    result = ingest_file(sys.argv[1])
    print(result)
