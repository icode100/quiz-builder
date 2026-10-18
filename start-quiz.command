#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd -P)"
address='http://127.0.0.1:8765'
no_browser=true
case "${1:-}" in
  '') ;;
  --with-browser) no_browser=false ;;
  --no-browser) no_browser=true ;;
  *) echo 'Usage: bash start-quiz.command [--with-browser|--no-browser]' >&2; exit 1 ;;
esac
if (( $# > 1 )); then echo 'Too many arguments.' >&2; exit 1; fi

node_path="$(command -v node || true)"
if [[ -z "$node_path" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$candidate" ]]; then node_path="$candidate"; break; fi
  done
fi
if [[ -z "$node_path" ]]; then echo 'Node.js is required to run the quiz server.' >&2; exit 1; fi

healthy() {
  curl -fsS --max-time 1 "$address/health" 2>/dev/null |
    "$node_path" -e 'try { const h = JSON.parse(require("fs").readFileSync(0, "utf8")); process.exit(h.server === "gate-cse-quiz-server-v1" ? 0 : 1); } catch { process.exit(1); }'
}

if ! healthy; then
  if nc -z 127.0.0.1 8765 >/dev/null 2>&1; then
    echo 'Port 8765 is used by another service. Close it and try again.' >&2
    exit 1
  fi
  mkdir -p "$root/tmp"
  nohup "$node_path" "$root/server.cjs" > "$root/tmp/server-mac.log" 2>&1 &
  quiz_pid=$!
  ready=false
  for ((count=0; count<40; count++)); do
    if healthy; then ready=true; break; fi
    if ! kill -0 "$quiz_pid" 2>/dev/null; then break; fi
    sleep 0.1
  done
  if ! $ready; then
    echo "The quiz server could not start. See $root/tmp/server-mac.log" >&2
    exit 1
  fi
  if kill -0 "$quiz_pid" 2>/dev/null; then
    printf '%s\n%s\n' "$quiz_pid" "$node_path $root/server.cjs" > "$root/tmp/server-mac.pid"
  fi
fi
echo "Quiz server: $address/"
if ! $no_browser; then open "$address/"; fi
