#!/usr/bin/env bash
# Snapshot everything Claudia knows: the vector DB and the uploaded files.
# Usage: ./backup.sh [destination_dir]
#   default destination: ./backups
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$DEST/claudia-backup-$STAMP.tar.gz"

mkdir -p "$DEST"

# Build the list of things that actually exist (db/ may be absent on a fresh repo).
ITEMS=()
[ -d "$ROOT/db" ]       && ITEMS+=("db")
[ -d "$ROOT/uploads" ]  && ITEMS+=("uploads")
[ -d "$ROOT/style" ]    && ITEMS+=("style")
[ -d "$ROOT/homework" ] && ITEMS+=("homework")

if [ ${#ITEMS[@]} -eq 0 ]; then
  echo "Nothing to back up — no db/ or uploads/ found in $ROOT."
  exit 0
fi

echo "Backing up: ${ITEMS[*]}"
tar -czf "$ARCHIVE" -C "$ROOT" "${ITEMS[@]}"

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "✓ Saved $ARCHIVE ($SIZE)"

# Keep only the 10 most recent backups in the default dir.
if [ "$DEST" = "$ROOT/backups" ]; then
  ls -1t "$DEST"/claudia-backup-*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm --
fi
