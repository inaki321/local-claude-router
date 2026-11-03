#!/usr/bin/env bash
#
# Deploy the LiteLLM gateway as the local Anthropic-compatible endpoint.
#
# Usage:
#   ./install.sh [--port 4000] [--dry-run] [--force]
#
# Deploys:
#   ~/.config/litellm/config.yaml
#   ~/.config/litellm/env            (0600, never committed)
#   ~/.config/systemd/user/claude-litellm.service
#
# This script NEVER writes to ~/.claude. The one settings.json change it cannot
# make for you is printed at the end.
#
# Prerequisite:
#   pipx install 'litellm[proxy]'

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME}"
CONFIG_DIR="$HOME_DIR/.config/litellm"
UNIT_DIR="$HOME_DIR/.config/systemd/user"
SERVICE_NAME="claude-litellm.service"

PORT="4000"
DRY_RUN=0
FORCE=0

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while (($#)); do
  case "$1" in
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ ! "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
  echo "error: invalid port: $PORT" >&2
  exit 2
fi

LITELLM_BIN="$(command -v litellm || true)"
if [[ -z "$LITELLM_BIN" ]]; then
  if ((DRY_RUN)); then
    LITELLM_BIN="/path/to/litellm"
  else
    echo "error: litellm not found on PATH" >&2
    echo "  install it first:  pipx install 'litellm[proxy]'" >&2
    exit 1
  fi
fi
LITELLM_DIR="$(dirname "$LITELLM_BIN")"

echo "repo:    $REPO_DIR"
echo "config:  ~/.config/litellm/config.yaml.example -> $CONFIG_DIR/config.yaml"
echo "env:     $CONFIG_DIR/env (0600)"
echo "unit:    $UNIT_DIR/$SERVICE_NAME"
echo "listen:  127.0.0.1:$PORT"
echo "claude:  NOT touched by this script"

if ((DRY_RUN)); then
  echo "DRY RUN: no files written, service not touched"
  exit 0
fi

mkdir -p "$CONFIG_DIR" "$UNIT_DIR"

if [[ -f "$CONFIG_DIR/config.yaml" && $FORCE -eq 0 ]]; then
  echo "keeping existing $CONFIG_DIR/config.yaml (use --force to replace)"
else
  install -m 644 "$REPO_DIR/~/.config/litellm/config.yaml.example" "$CONFIG_DIR/config.yaml"
  echo "wrote $CONFIG_DIR/config.yaml"
fi

if [[ -f "$CONFIG_DIR/env" ]]; then
  echo "keeping existing $CONFIG_DIR/env"
else
  install -m 600 "$REPO_DIR/~/.config/litellm/env.example" "$CONFIG_DIR/env"
  chmod 600 "$CONFIG_DIR/env"
  echo "wrote $CONFIG_DIR/env (0600)"
fi

if grep -q 'REPLACE_WITH' "$CONFIG_DIR/env"; then
  echo "error: fill the placeholders in $CONFIG_DIR/env, then re-run." >&2
  exit 1
fi
if grep -q 'REPLACE_WITH' "$CONFIG_DIR/config.yaml"; then
  echo "error: replace REPLACE_WITH_LITHOS_MODEL_ID in $CONFIG_DIR/config.yaml" >&2
  echo "  list ids: curl -s https://api.lithosai.cloud/v1/models \\" >&2
  echo "              -H \"Authorization: Bearer \$LITHOSAI_API_KEY\"" >&2
  exit 1
fi

sed \
  -e "s|__LITELLM_BIN__|$LITELLM_BIN|g" \
  -e "s|__LITELLM_DIR__|$LITELLM_DIR|g" \
  -e "s|__LITELLM_PORT__|$PORT|g" \
  -e "s|__HOME__|$HOME_DIR|g" \
  "$REPO_DIR/systemd/claude-litellm.service.template" > "$UNIT_DIR/$SERVICE_NAME"

if systemctl --user is-active --quiet claude-router 2>/dev/null; then
  echo "note: claude-router is still running and occupies :4000." >&2
  echo "      after this service starts, retire it with:" >&2
  echo "      systemctl --user disable --now claude-router" >&2
fi

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
loginctl enable-linger "$USER" 2>/dev/null || true
systemctl --user restart "$SERVICE_NAME"

ok=0
for _ in $(seq 1 40); do
  if curl -sf --max-time 1 "http://127.0.0.1:$PORT/health/liveliness" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 0.25
done
if ((ok)); then
  echo "litellm is healthy on http://127.0.0.1:$PORT"
else
  echo "warning: no healthy answer; check: journalctl --user -u $SERVICE_NAME -n 50" >&2
fi

cat <<EOF

Next step (manual; this script never edits ~/.claude):
  In ~/.claude/settings.json set
    ANTHROPIC_BASE_URL   = http://127.0.0.1:$PORT
    ANTHROPIC_AUTH_TOKEN = <the LITELLM_MASTER_KEY value from $CONFIG_DIR/env>
  If the port is still 4000, only the token needs to change.
  Then retire the old router:
    systemctl --user disable --now claude-router

Smoke tests first: see litellm/README.md
Rollback: systemctl --user disable --now $SERVICE_NAME
EOF
