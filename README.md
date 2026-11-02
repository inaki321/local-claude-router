# localrouter

A tiny local Anthropic-compatible gateway that lets one `claude` process use
**DeepSeek direct** and **OpenRouter** models, switching with `/model`.

```text
claude  ->  127.0.0.1:4000  ->  deepseek-*        -> api.deepseek.com/anthropic
                            ->  vendor/model      -> openrouter.ai/api
                            ->  provider:model    -> explicit provider
```

Claude Code has one endpoint and one credential per process. The router gives
it a single local endpoint; each request's `model` field decides the upstream
provider and injects that provider's API key. Requests are forwarded untouched
in Anthropic Messages format — no API translation.

## Repo layout

| Path | Purpose |
| --- | --- |
| `router/router.mjs` | The router. Node 18+, no dependencies. |
| `router/setup-config.mjs` | Generates `providers.json` from env vars or existing keys. |
| `providers.example.json` | Config shape; placeholders only, safe to commit. |
| `claude/settings.example.json` | Canonical `~/.claude/settings.json` (no secrets). |
| `claude/settings.local.example.json` | Sanitized example of the local allow rules. |
| `scripts/apply-settings.mjs` | Merges the canonical settings into `~/.claude/settings.json` with a backup. |
| `systemd/claude-router.service.template` | Unit template; paths filled in by `install.sh`. |
| `install.sh` | Deploys the router, config, and service. |
| `MODIFICATIONS.md` | Exactly what was changed on this machine, with rollback notes. |

## Install / update

```bash
cd ~/repos/personal/localrouter
./install.sh                 # router + service only
./install.sh --settings      # also merge the canonical Claude settings
./install.sh --dry-run       # show what would happen
```

First install on a machine without `~/.claude/router/providers.json`:

```bash
DEEPSEEK_API_KEY=... OPENROUTER_API_KEY=... ./install.sh
```

or copy `providers.example.json` to `~/.claude/router/providers.json` and fill
in the keys. The live `providers.json` is `0600` and gitignored.

After pulling changes, rerun `./install.sh`; it restarts the service.

## Daily use

```text
claude                          # starts on deepseek-v4-flash
/model                          # opens the labeled picker
/model deepseek-v4-pro
/model deepseek-v4-flash
/model openai/gpt-oss-120b
/model google/gemma-4-26b-a4b-it:free
/model deepseek:deepseek-v4-pro        # explicit provider:model
/model openrouter:openai/gpt-oss-120b
```

Shortcuts: `ds`, `ds-flash`, `ds-pro`, `or`, `gemma`, `nemotron`, `lightning`,
`gpt-oss`, `opus` (-> `deepseek-v4-pro`), `sonnet`/`haiku`/`fable`
(-> `deepseek-v4-flash`).

`/model <name>` + Enter saves the choice as the new default. In the picker,
`s` switches for the current session only.

## Service

```bash
systemctl --user status claude-router
systemctl --user restart claude-router
systemctl --user stop claude-router
journalctl --user -u claude-router -f
curl -s http://127.0.0.1:4000/health
```

The unit is `~/.config/systemd/user/claude-router.service`; it is enabled at
login and restarts automatically. Linger is enabled where permitted. If you
switch Node versions with nvm, rerun `./install.sh` so the unit points at the
new `node` binary.

## Keys and models

Edit `~/.claude/router/providers.json` directly, or regenerate:

```bash
DEEPSEEK_API_KEY=... OPENROUTER_API_KEY=... node ~/.claude/router/setup-config.mjs
systemctl --user restart claude-router
```

Add a provider:

```json
{
  "providers": {
    "moonshot": {
      "name": "moonshot",
      "base_url": "https://api.moonshot.ai/anthropic",
      "api_key": "..."
    }
  },
  "rules": [
    { "match": "^kimi-", "provider": "moonshot" }
  ]
}
```

Rules are evaluated in order; first match wins. `prefix` prepends to the
upstream model id, `strip` removes a prefix, and `aliases` maps a short name to
`{provider, model}`. Restart the service after editing.

## What was changed outside the repo

See [MODIFICATIONS.md](MODIFICATIONS.md). In short: `~/.claude/settings.json`
was pointed at the router; `modelAliases` was removed from
`settings.local.json`; `~/.claude/remote-settings.json` was deleted; the
invalid `ANTHROPIC_API_KEY` export in `~/.bashrc` was commented out; and the
systemd user service was created and enabled.

## Security

- `providers.json` holds real keys. It is mode `0600` and gitignored.
- Never commit a filled `providers.json`; commit `providers.example.json`.
- Keys that have appeared in a chat or shared transcript should be rotated.
- The router listens on `127.0.0.1` only.

## Troubleshooting

- **429 `free-models-per-day`** — OpenRouter free-tier daily quota. Paid models
  still work; adding $10 credits unlocks 1000 free requests/day.
- **400 `Mid-conversation reasoning effort ...`** — an OpenRouter model that
  rejects Anthropic effort parameters. OpenRouter picker rows must not have
  `behavesAs`; only the DeepSeek rows use it.
- **`[claude-code:unrecognized_model]`** — cosmetic diagnostic for custom IDs
  without a `behavesAs` entry. Requests still work.
- **`claude` can't connect** — the service is down:
  `systemctl --user start claude-router`.
- **Anthropic direct** — not configured. The old key in `~/.bashrc` was
  invalid and is commented out.

## Uninstall

```bash
systemctl --user disable --now claude-router
rm -f ~/.config/systemd/user/claude-router.service
systemctl --user daemon-reload
rm -rf ~/.claude/router
```

Then remove the `env` block and `modelPicker` from `~/.claude/settings.json`
(or restore a `settings.json.bak-*` backup).
