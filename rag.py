from pathlib import Path

import chromadb
from langchain_ollama import OllamaEmbeddings, ChatOllama
from langchain_core.messages import HumanMessage, SystemMessage

# ── config ─────────────────────────────────────────────────────────────────────
DB_DIR = Path(__file__).parent / "db"
EMBED_MODEL = "nomic-embed-text"
CHAT_MODEL = "llama3.2"
N_RESULTS = 5  # chunks to retrieve

# ── clients ────────────────────────────────────────────────────────────────────
_client = chromadb.PersistentClient(path=str(DB_DIR))
_collection = _client.get_or_create_collection("claudia")
_embeddings = OllamaEmbeddings(model=EMBED_MODEL)
_llm = ChatOllama(model=CHAT_MODEL)

# ── system prompt ───────────────────────────────────────────────────────────────
_SYSTEM = """You are Claudia, a personal AI second brain. Answer the user's question
using only the context excerpts provided. If the answer isn't in the context, say so.
Always cite which file(s) the information came from."""


def search(query: str, n: int = N_RESULTS, filename: str | None = None) -> list[dict]:
    """Return the top-n most relevant chunks for a query."""
    vector = _embeddings.embed_query(query)

    where = {"filename": filename} if filename else None
    results = _collection.query(
        query_embeddings=[vector],
        n_results=min(n, _collection.count() or 1),
        where=where,
        include=["documents", "metadatas", "distances"],
    )

    chunks = []
    for doc, meta, dist in zip(
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0],
    ):
        chunks.append({"text": doc, "metadata": meta, "distance": dist})
    return chunks


def ask(question: str, filename: str | None = None) -> dict:
    """
    Answer a question using RAG.

    Returns a dict with:
      - answer: the LLM's response string
      - sources: list of metadata dicts for the retrieved chunks
    """
    chunks = search(question, filename=filename)
    if not chunks:
        return {"answer": "No documents have been ingested yet.", "sources": []}

    context = "\n\n---\n\n".join(
        f"[{c['metadata']['filename']}]\n{c['text']}" for c in chunks
    )

    messages = [
        SystemMessage(content=_SYSTEM),
        HumanMessage(content=f"Context:\n{context}\n\nQuestion: {question}"),
    ]

    response = _llm.invoke(messages)
    sources = [c["metadata"] for c in chunks]

    return {"answer": response.content, "sources": sources}


# ── CLI ─────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python rag.py \"your question here\"")
        sys.exit(1)

    question = " ".join(sys.argv[1:])
    result = ask(question)

    print("\nAnswer:")
    print(result["answer"])
    print("\nSources:")
    seen = set()
    for s in result["sources"]:
        key = (s["filename"], s["chunk_index"])
        if key not in seen:
            seen.add(key)
            print(f"  • {s['filename']} (chunk {s['chunk_index']}, ingested {s['ingested_at']})")
