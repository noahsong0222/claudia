"""Style Studio — analyze the user's writing and replicate their voice.

Deliberately separate from the notes RAG pipeline. Writing samples and the
derived style profile live in their own JSON store under style/, so class
material never pollutes the user's personal voice.

Two halves:
  1. Deterministic metrics computed in Python (sentence length, vocabulary
     diversity, punctuation habits) — fast, objective, no LLM.
  2. A qualitative style profile + generation, both via the local LLM, which
     reads the samples and either describes the voice or writes in it.
"""

import re
import json
import uuid
from datetime import datetime
from pathlib import Path

STYLE_DIR = Path(__file__).parent / "style"
STYLE_DIR.mkdir(exist_ok=True)
SAMPLES_FILE = STYLE_DIR / "samples.json"
PROFILE_FILE = STYLE_DIR / "profile.json"


# ── sample store ────────────────────────────────────────────────────────────

def _load(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def list_samples() -> list[dict]:
    return _load(SAMPLES_FILE, [])


def add_sample(title: str, text: str) -> dict:
    text = text.strip()
    if not text:
        raise ValueError("Sample text is empty.")
    samples = list_samples()
    sample = {
        "id":       uuid.uuid4().hex[:12],
        "title":    title.strip() or f"sample-{len(samples) + 1}",
        "text":     text,
        "words":    len(text.split()),
        "added_at": datetime.now().isoformat(timespec="seconds"),
    }
    samples.append(sample)
    SAMPLES_FILE.write_text(json.dumps(samples, indent=2))
    return sample


def delete_sample(sample_id: str) -> bool:
    samples = list_samples()
    new = [s for s in samples if s["id"] != sample_id]
    if len(new) == len(samples):
        return False
    SAMPLES_FILE.write_text(json.dumps(new, indent=2))
    return True


# ── deterministic metrics ───────────────────────────────────────────────────

_STOP = {
    "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
    "with", "is", "are", "was", "were", "be", "been", "it", "this", "that",
    "i", "you", "he", "she", "they", "we", "as", "by", "from", "my", "me",
}


def compute_metrics(samples: list[dict] | None = None) -> dict:
    samples = samples if samples is not None else list_samples()
    text = "\n\n".join(s["text"] for s in samples).strip()
    if not text:
        return {"empty": True}

    words = re.findall(r"[A-Za-z']+", text)
    sentences = [s for s in re.split(r"[.!?]+", text) if s.strip()]
    paragraphs = [p for p in text.split("\n\n") if p.strip()]
    n_words = len(words) or 1
    n_sents = len(sentences) or 1

    lower = [w.lower() for w in words]
    unique = set(lower)

    def per100(ch: str) -> float:
        return round(text.count(ch) / n_words * 100, 2)

    # most-used distinctive words (skip common stop words)
    freq: dict[str, int] = {}
    for w in lower:
        if w not in _STOP and len(w) > 2:
            freq[w] = freq.get(w, 0) + 1
    top_words = sorted(freq.items(), key=lambda kv: kv[1], reverse=True)[:12]

    return {
        "empty":               False,
        "samples":             len(samples),
        "total_words":         n_words,
        "total_sentences":     n_sents,
        "avg_sentence_length": round(n_words / n_sents, 1),
        "avg_word_length":     round(sum(len(w) for w in words) / n_words, 2),
        "vocabulary_richness": round(len(unique) / n_words, 3),  # type-token ratio
        "avg_paragraph_sents": round(n_sents / max(len(paragraphs), 1), 1),
        "punctuation_per_100": {
            "comma":       per100(","),
            "semicolon":   per100(";"),
            "dash":        per100("—") + per100("-"),
            "exclamation": per100("!"),
            "question":    per100("?"),
        },
        "top_words":           [{"word": w, "count": c} for w, c in top_words],
    }


# ── LLM profile + generation ────────────────────────────────────────────────

def _samples_blob(max_chars: int = 6000) -> str:
    parts, total = [], 0
    for s in list_samples():
        chunk = f"--- {s['title']} ---\n{s['text']}"
        if total + len(chunk) > max_chars:
            chunk = chunk[: max_chars - total]
        parts.append(chunk)
        total += len(chunk)
        if total >= max_chars:
            break
    return "\n\n".join(parts)


def build_profile(llm) -> dict:
    """Ask the LLM to read all samples and describe the voice. Saves + returns."""
    from langchain_core.messages import HumanMessage, SystemMessage

    samples = list_samples()
    if not samples:
        raise ValueError("Add at least one writing sample first.")

    metrics = compute_metrics(samples)
    blob = _samples_blob()

    prompt = (
        "Below are writing samples from one author. Analyze their voice so it can "
        "be replicated. Be specific and concrete, quoting short phrases where useful.\n\n"
        f"SAMPLES:\n{blob}\n\n"
        "Return ONLY a JSON object with these keys:\n"
        '{\n'
        '  "voice_summary": "2-3 sentence description of how this person writes",\n'
        '  "tone": "e.g. dry and direct, warm and discursive",\n'
        '  "sentence_style": "rhythm, length variation, how they open/close sentences",\n'
        '  "vocabulary": "register, favorite words, jargon, simple vs fancy",\n'
        '  "punctuation": "habits with commas, dashes, semicolons, fragments",\n'
        '  "structure": "how they organize paragraphs and arguments",\n'
        '  "signature_moves": ["distinctive habit 1", "habit 2", "habit 3"],\n'
        '  "avoid": ["things this author never does"]\n'
        '}\n'
        "Reply with the JSON only, no preamble."
    )
    messages = [
        SystemMessage(content="You are a literary analyst specializing in authorial voice. Output only valid JSON."),
        HumanMessage(content=prompt),
    ]
    resp = llm.invoke(messages)
    text = resp.content.strip()
    start, end = text.find("{"), text.rfind("}") + 1
    try:
        profile = json.loads(text[start:end])
    except Exception:
        profile = {"voice_summary": text[:500], "raw": True}

    profile["metrics"] = metrics
    profile["generated_at"] = datetime.now().isoformat(timespec="seconds")
    profile["sample_count"] = len(samples)
    PROFILE_FILE.write_text(json.dumps(profile, indent=2))
    return profile


def get_profile() -> dict | None:
    return _load(PROFILE_FILE, None)


def build_generation_messages(task: str, mode: str = "write"):
    """Construct the system+user messages that make the LLM write as the user."""
    from langchain_core.messages import HumanMessage, SystemMessage

    profile = get_profile() or {}
    samples = list_samples()
    # 2-3 representative excerpts as few-shot anchors
    few_shot = "\n\n".join(
        f"EXAMPLE OF MY WRITING:\n{s['text'][:900]}" for s in samples[:3]
    )

    profile_desc = ""
    for k in ("voice_summary", "tone", "sentence_style", "vocabulary", "punctuation", "structure"):
        if profile.get(k):
            profile_desc += f"- {k.replace('_', ' ').title()}: {profile[k]}\n"
    if profile.get("signature_moves"):
        profile_desc += "- Signature moves: " + "; ".join(profile["signature_moves"]) + "\n"
    if profile.get("avoid"):
        profile_desc += "- Never do: " + "; ".join(profile["avoid"]) + "\n"

    system = (
        "You are a ghostwriter who writes EXACTLY in one specific person's voice. "
        "Match their rhythm, vocabulary, punctuation, and structure precisely. "
        "Do not explain what you are doing. Do not add commentary. Output only the "
        "writing itself, as if the person wrote it.\n\n"
        f"THE PERSON'S STYLE:\n{profile_desc or '(no profile yet — infer from the examples below)'}\n\n"
        f"{few_shot}"
    )

    if mode == "rewrite":
        user = (
            "Rewrite the following text so it sounds exactly like me, keeping the "
            f"meaning but matching my voice completely:\n\n{task}"
        )
    else:  # write
        user = f"Write the following in my voice:\n\n{task}"

    return [SystemMessage(content=system), HumanMessage(content=user)]
