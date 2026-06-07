import os
import uuid
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


def _extract_pdf(path: Path) -> str:
    from pypdf import PdfReader
    reader = PdfReader(str(path))
    pages = [page.extract_text() or "" for page in reader.pages]
    text = "\n\n".join(pages).strip()
    if text:
        return text
    # OCR fallback via PyMuPDF if installed
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


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return _extract_pdf(path)
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif", ".gif"}:
        return _extract_image(path)
    if suffix in {".docx", ".doc"}:
        return _extract_docx(path)
    raise ValueError(f"Unsupported file type: {suffix}")


def ingest_file(source_path: str | Path, class_name: str = "General") -> dict:
    """
    Ingest a file into Chroma.
    class_name: the course or category this file belongs to.
    """
    source_path = Path(source_path)
    if not source_path.exists():
        raise FileNotFoundError(source_path)

    dest = UPLOADS_DIR / source_path.name
    if source_path.resolve() != dest.resolve():
        shutil.copy2(source_path, dest)

    filename = dest.name
    ingested_at = datetime.now().isoformat(timespec="seconds")
    class_name = class_name.strip() or "General"

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
            "filename": filename,
            "class_name": class_name,
            "ingested_at": ingested_at,
            "chunk_index": i,
        }
        for i in range(len(chunks))
    ]

    _collection.add(ids=ids, embeddings=vectors, documents=chunks, metadatas=metadatas)

    total = _collection.count()
    print(f"Done. {len(chunks)} chunks stored (total: {total}).")
    return {
        "filename": filename,
        "class_name": class_name,
        "chunk_count": len(chunks),
        "collection_total": total,
        "ingested_at": ingested_at,
    }


def get_classes() -> list[str]:
    """Return a sorted list of all class names in the DB."""
    if _collection.count() == 0:
        return []
    all_meta = _collection.get(include=["metadatas"])["metadatas"]
    return sorted({m.get("class_name", "General") for m in all_meta})


def get_files() -> list[dict]:
    """Return a deduplicated list of ingested files with metadata."""
    if _collection.count() == 0:
        return []
    all_meta = _collection.get(include=["metadatas"])["metadatas"]
    seen = {}
    for m in all_meta:
        key = m["filename"]
        if key not in seen:
            seen[key] = {"filename": m["filename"], "class_name": m.get("class_name", "General"), "ingested_at": m.get("ingested_at", "")}
    return sorted(seen.values(), key=lambda x: x["ingested_at"], reverse=True)


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python ingest.py <file> [class_name]")
        sys.exit(1)
    class_arg = sys.argv[2] if len(sys.argv) > 2 else "General"
    print(ingest_file(sys.argv[1], class_arg))
