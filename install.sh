#!/usr/bin/env bash
#
# Deploy the local router and its systemd user service.
#
# Usage:
#   ./install.sh                 # install router + service, keep existing keys
#   ./install.sh --settings      # also merge claude/settings.example.json
#   ./install.sh --dry-run ...   # show what would happen, change nothing
#
# First-time install without ~/.claude/router/providers.json:
#   DEEPSEEK_API_KEY=... OPENROUTER_API_KEY=... ./install.sh
# or copy providers.example.json to ~/.claude/router/providers.json and edit it.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME}"
TARGET_DIR="$HOME_DIR/.claude/router"
UNIT_DIR="$HOME_DIR/.config/systemd/user"
SERVICE_NAME="claude-router.service"

APPLY_SETTINGS=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --settings) APPLY_SETTINGS=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found on PATH (need Node 18+)" >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  echo "error: Node 18+ required, found $("$NODE_BIN" --version)" >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

echo "repo:   $REPO_DIR"
echo "router: $TARGET_DIR"
echo "node:   $NODE_BIN"
echo "unit:   $UNIT_DIR/$SERVICE_NAME"

if (( DRY_RUN )); then
  echo "DRY RUN: no files written, service not touched"
  if (( APPLY_SETTINGS )); then
    "$NODE_BIN" "$REPO_DIR/scripts/apply-settings.mjs" --dry-run
  fi
  exit 0
fi

mkdir -p "$TARGET_DIR" "$UNIT_DIR"

install -m 644 "$REPO_DIR/router/router.mjs" "$TARGET_DIR/router.mjs"
install -m 644 "$REPO_DIR/router/setup-config.mjs" "$TARGET_DIR/setup-config.mjs"
install -m 644 "$REPO_DIR/README.md" "$TARGET_DIR/README.md"

if [[ -f "$TARGET_DIR/providers.json" ]]; then
  echo "keeping existing $TARGET_DIR/providers.json"
else
  if [[ -n "${DEEPSEEK_API_KEY:-}" && -n "${OPENROUTER_API_KEY:-}" ]] || \
     [[ -f "$HOME_DIR/.claude/remote-settings.json" ]]; then
    "$NODE_BIN" "$TARGET_DIR/setup-config.mjs"
  else
    echo "error: no providers.json and no credentials available" >&2
    echo "  set DEEPSEEK_API_KEY and OPENROUTER_API_KEY, or" >&2
    echo "  cp $REPO_DIR/providers.example.json $TARGET_DIR/providers.json  (then edit it)" >&2
    exit 1
  fi
fi
chmod 600 "$TARGET_DIR/providers.json"

sed \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__NODE_DIR__|$NODE_DIR|g" \
  -e "s|__HOME__|$HOME_DIR|g" \
  "$REPO_DIR/systemd/claude-router.service.template" > "$UNIT_DIR/$SERVICE_NAME"

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"
loginctl enable-linger "$USER" 2>/dev/null || true

ok=0
for _ in $(seq 1 40); do
  if curl -sf --max-time 1 http://127.0.0.1:4000/health >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 0.25
done
if (( ok )); then
  echo "router is healthy: $(curl -s --max-time 2 http://127.0.0.1:4000/health)"
else
  echo "warning: router did not answer /health; check: journalctl --user -u $SERVICE_NAME -n 50" >&2
fi

if (( APPLY_SETTINGS )); then
  "$NODE_BIN" "$REPO_DIR/scripts/apply-settings.mjs"
fi

echo
echo "Done. Open a new shell (or source ~/.bashrc) and run: claude"
echo "  /model                         picker"
echo "  /model deepseek-v4-pro         DeepSeek direct"
echo "  /model openai/gpt-oss-120b     OpenRouter"
