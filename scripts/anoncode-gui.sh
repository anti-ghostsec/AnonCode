#!/usr/bin/env bash
# Launch the AnonCode GUI: starts the local server (which auto-opens your
# browser to the correct tokenized URL) and stays running until you close it.
# Safe to double-click or run from a terminal.
set -euo pipefail
DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$DIR"

if ! command -v bun >/dev/null 2>&1; then
  echo "Bun is required but was not found on PATH. Install it from https://bun.sh"
  read -r -p "Press Enter to close…" _
  exit 1
fi

exec bun run src/cli/index.ts gui "$@"
