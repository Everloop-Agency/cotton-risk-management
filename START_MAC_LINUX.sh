#!/bin/sh
cd "$(dirname "$0")" || exit 1
PORT=8000
printf '%s\n' "Cotton Risk Management local server"
printf '%s\n' "Open: http://localhost:${PORT}"
if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  python -m http.server "$PORT"
else
  printf '%s\n' "Python was not found. Install Python 3 and run this file again."
  exit 1
fi
