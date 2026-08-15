"""Homework tracker — assignments, due dates, and status, saved on disk.

Same pattern as style.py: a JSON-backed store under homework/, separate from
the notes RAG. Everything writes to disk immediately on each change.
"""

import json
import uuid
from datetime import datetime, date
from pathlib import Path

HOMEWORK_DIR = Path(__file__).parent / "homework"
HOMEWORK_DIR.mkdir(exist_ok=True)
TASKS_FILE = HOMEWORK_DIR / "tasks.json"

PRIORITIES = {"high", "medium", "low"}
STATUSES = {"todo", "done"}


def _load() -> list[dict]:
    if not TASKS_FILE.exists():
        return []
    try:
        return json.loads(TASKS_FILE.read_text())
    except Exception:
        return []


def _save(tasks: list[dict]) -> None:
    TASKS_FILE.write_text(json.dumps(tasks, indent=2))


def _days_left(due: str | None) -> int | None:
    if not due:
        return None
    try:
        return (date.fromisoformat(due) - date.today()).days
    except ValueError:
        return None


def _decorate(t: dict) -> dict:
    """Attach computed fields the UI needs (never stored)."""
    days = _days_left(t.get("due_date"))
    return {
        **t,
        "days_left": days,
        "overdue": t["status"] == "todo" and days is not None and days < 0,
    }


def list_tasks() -> list[dict]:
    """All tasks, decorated, sorted: overdue first, then by due date, then no-date."""
    tasks = [_decorate(t) for t in _load()]

    def sort_key(t: dict):
        # done tasks sink to the bottom, newest-completed first
        if t["status"] == "done":
            return (2, 0, -(len(t.get("completed_at", ""))), t.get("completed_at", ""))
        days = t["days_left"]
        if days is None:
            return (1, 0, 0, t.get("created_at", ""))
        return (0, days, 0, "")

    return sorted(tasks, key=sort_key)


def add_task(title: str, class_name: str = "", due_date: str = "",
             priority: str = "medium", notes: str = "") -> dict:
    title = title.strip()
    if not title:
        raise ValueError("Title is required.")
    if due_date:
        date.fromisoformat(due_date)  # raises ValueError if malformed
    if priority not in PRIORITIES:
        priority = "medium"

    tasks = _load()
    task = {
        "id":           uuid.uuid4().hex[:12],
        "title":        title,
        "class_name":   class_name.strip(),
        "due_date":     due_date or None,
        "priority":     priority,
        "notes":        notes.strip(),
        "status":       "todo",
        "created_at":   datetime.now().isoformat(timespec="seconds"),
        "completed_at": None,
    }
    tasks.append(task)
    _save(tasks)
    return _decorate(task)


def update_task(task_id: str, **fields) -> dict | None:
    tasks = _load()
    for t in tasks:
        if t["id"] != task_id:
            continue
        if "title" in fields and fields["title"] is not None:
            title = fields["title"].strip()
            if title:
                t["title"] = title
        if "class_name" in fields and fields["class_name"] is not None:
            t["class_name"] = fields["class_name"].strip()
        if "due_date" in fields and fields["due_date"] is not None:
            dd = fields["due_date"]
            if dd:
                date.fromisoformat(dd)
            t["due_date"] = dd or None
        if "priority" in fields and fields["priority"] in PRIORITIES:
            t["priority"] = fields["priority"]
        if "notes" in fields and fields["notes"] is not None:
            t["notes"] = fields["notes"].strip()
        if "status" in fields and fields["status"] in STATUSES:
            if fields["status"] != t["status"]:
                t["status"] = fields["status"]
                t["completed_at"] = (
                    datetime.now().isoformat(timespec="seconds")
                    if fields["status"] == "done" else None
                )
        _save(tasks)
        return _decorate(t)
    return None


def delete_task(task_id: str) -> bool:
    tasks = _load()
    new = [t for t in tasks if t["id"] != task_id]
    if len(new) == len(tasks):
        return False
    _save(new)
    return True


def stats() -> dict:
    tasks = [_decorate(t) for t in _load()]
    todo = [t for t in tasks if t["status"] == "todo"]
    return {
        "total":     len(tasks),
        "todo":      len(todo),
        "done":      len(tasks) - len(todo),
        "overdue":   sum(1 for t in todo if t["overdue"]),
        "due_week":  sum(1 for t in todo if t["days_left"] is not None and 0 <= t["days_left"] <= 7),
    }
