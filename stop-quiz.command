#!/bin/bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd -P)"
pid_file="$root/tmp/server-mac.pid"
if [[ ! -f "$pid_file" ]]; then
  echo 'No server started by this Mac launcher is recorded.'
  exit 0
fi
{
  IFS= read -r quiz_pid
  IFS= read -r expected_command
} < "$pid_file"
if [[ ! "$quiz_pid" =~ ^[1-9][0-9]*$ || "$expected_command" != *" $root/server.cjs" ]]; then
  echo 'Invalid server record; refusing to stop a process.' >&2
  exit 1
fi
if ! kill -0 "$quiz_pid" 2>/dev/null; then
  rm -f "$pid_file"
  echo 'This quiz server is already stopped.'
  exit 0
fi
owner="$(ps -p "$quiz_pid" -o uid= | tr -d '[:space:]')"
actual_command="$(ps -ww -p "$quiz_pid" -o command=)"
if [[ "$owner" != "$(id -u)" || "$actual_command" != "$expected_command" ]]; then
  echo 'The recorded process is not this quiz server; refusing to stop it.' >&2
  exit 1
fi
kill "$quiz_pid"
rm -f "$pid_file"
echo 'Quiz server stopped.'
