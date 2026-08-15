#!/usr/bin/env bash
# Restore Claudia's vector DB + uploaded files from a backup archive.
# Usage: ./restore.sh [archive.tar.gz]
#   no argument: restores the most recent backup in ./backups
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

if [ $# -ge 1 ]; then
  ARCHIVE="$1"
else
  ARCHIVE="$(ls -1t "$ROOT/backups"/claudia-backup-*.tar.gz 2>/dev/null | head -n1 || true)"
fi

if [ -z "${ARCHIVE:-}" ] || [ ! -f "$ARCHIVE" ]; then
  echo "No backup archive found. Pass one explicitly: ./restore.sh path/to/backup.tar.gz"
  exit 1
fi

echo "About to restore from: $ARCHIVE"
echo "This OVERWRITES the current db/ and uploads/ in $ROOT."
read -r -p "Continue? [y/N] " ans
case "$ans" in
  [yY]*) ;;
  *) echo "Aborted."; exit 0 ;;
esac

# Safety net: stash the current state before overwriting.
PRE=()
for d in db uploads style homework; do
  [ -d "$ROOT/$d" ] && PRE+=("$d")
done
if [ ${#PRE[@]} -gt 0 ]; then
  SAFETY="$ROOT/backups/pre-restore-$(date +%Y%m%d-%H%M%S).tar.gz"
  mkdir -p "$ROOT/backups"
  tar -czf "$SAFETY" -C "$ROOT" "${PRE[@]}"
  echo "Current state saved to $SAFETY (in case you need to undo)."
  for d in "${PRE[@]}"; do rm -rf "${ROOT:?}/$d"; done
fi

tar -xzf "$ARCHIVE" -C "$ROOT"
echo "✓ Restored. Restart the backend (python api.py) to load it."
