#!/usr/bin/env bash
# FLUX LoRA studio — start the server (unless it already runs) and open the browser.
cd "$(dirname "$0")"
PORT="${PORT:-8123}"
URL="http://127.0.0.1:${PORT}"

if curl -sf "${URL}/api/models" >/dev/null 2>&1; then
  xdg-open "${URL}" >/dev/null 2>&1
  exit 0
fi

# Up to 30 minutes: the first run installs PyTorch.
( for _ in $(seq 3600); do
    curl -sf "${URL}/api/models" >/dev/null 2>&1 && { xdg-open "${URL}" >/dev/null 2>&1; break; }
    sleep 0.5
  done ) &

exec ./run.sh
