# Changes made outside this repo

Date: 2026-11-02
Machine: `omen00` (WSL2)

This file is the record of every change made to the live system so the setup
can be audited or rolled back. The repo is the canonical source; the live
copies are deployed by `install.sh`.

## Created

| Path | Notes |
| --- | --- |
| `~/.claude/router/router.mjs` | Router source (also in `router/`). |
| `~/.claude/router/setup-config.mjs` | Config generator (also in `router/`). |
| `~/.claude/router/providers.json` | **Contains real API keys.** Mode `0600`, gitignored. |
| `~/.claude/router/README.md` | Copy of the usage doc. |
| `~/.config/systemd/user/claude-router.service` | Rendered from `systemd/claude-router.service.template`. |

Service actions:

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-router.service
loginctl enable-linger inaki00
```

## Modified: `~/.claude/settings.json`

### Before

```json
{
  "model": "haiku",
  "skipDangerousModePermissionPrompt": true,
  "theme": "dark",
  "bash": {
    "deniedCommands": [
      "git commit",
      "git push",
      "kubectl edit",
      "k edit",
      "kubectl rollout restart",
      "k rollout restart"
    ]
  }
}
```

### After

See `claude/settings.example.json`. The changes:

- `model`: `haiku` -> `deepseek-v4-flash`
- Added `env`:
  - `ANTHROPIC_BASE_URL=http://127.0.0.1:4000`
  - `ANTHROPIC_AUTH_TOKEN=claude-router-local` (the router ignores it)
  - `ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro`
  - `ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash`
  - `ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash`
  - `ANTHROPIC_DEFAULT_FABLE_MODEL=deepseek-v4-flash`
- Added `modelPicker` with `replaceBuiltInOptions: true` and six rows:
  - `deepseek-v4-flash` (behavesAs `claude-haiku-5-5`)
  - `deepseek-v4-pro` (behavesAs `claude-sonnet-5-5`)
  - `openai/gpt-oss-120b`
  - `google/gemma-4-26b-a4b-it:free`
  - `nvidia/nemotron-3-ultra-550b-a55b:free`
  - `nvidia/nemotron-3.5-lightning:free`
- Removed `bash.deniedCommands` (not a supported key; it was silently ignored)
  and added `permissions.deny` with the same commands in real rule syntax:
  - `Bash(git commit:*)`, `Bash(git push:*)`, `Bash(kubectl edit:*)`,
    `Bash(k edit:*)`, `Bash(kubectl rollout restart:*)`,
    `Bash(k rollout restart:*)`
  - **Behavior change:** these commands are now actually blocked.
- Kept `skipDangerousModePermissionPrompt` and `theme`.

No backup of the original `settings.json` was taken before the first rewrite;
the original content is preserved above. `apply-settings.mjs` backs up on every
subsequent change (`settings.json.bak-<timestamp>`).

## Modified: `~/.claude/settings.local.json`

Removed the top-level `modelAliases` object. It is not a Claude Code setting
and was ignored. Backup: `settings.local.json.bak-<timestamp>`.

`permissions.allow` was preserved unchanged.

## Deleted: `~/.claude/remote-settings.json`

Not read by Claude Code. It held the DeepSeek and OpenRouter keys; those were
migrated into `~/.claude/router/providers.json`. The same keys remain in the
old `~/.bashrc` aliases, so nothing was lost.

## Modified: `~/.bashrc`

Original line 129:

```bash
export ANTHROPIC_API_KEY="sk-ant-"
```

Replaced with:

```bash
# ANTHROPIC_API_KEY disabled - router keys live in ~/.claude/router/providers.json
```

Reason: the key is invalid (Anthropic returns `401 invalid x-api-key`), and
Claude Code's settings `env` block cannot unset a shell-exported variable.
Settings `env` overrides shell values, but both `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` being present is ambiguous.

The `claude-kimi`, `claude-deepseek`, and `claude-free` alias block was left
untouched. Those aliases are now redundant: settings `env` overrides their base
URLs, so they all go through the router. `claude-deepseek` and `claude-free`
still work; `claude-kimi` will fail because the router has no Moonshot provider
(add one per README if needed).

Backup: `~/.bashrc.bak-<timestamp>`.

## Not changed

- `~/.claude/settings.local.json` permission allow rules.
- The `claude-kimi` / `claude-deepseek` / `claude-free` alias definitions.
- Any project-level `.claude/settings.json` files.

## Rollback

```bash
# 1. Stop and remove the service + router
systemctl --user disable --now claude-router
rm -f ~/.config/systemd/user/claude-router.service
systemctl --user daemon-reload
rm -rf ~/.claude/router

# 2. Restore settings.json from the "Before" block above
#    (or keep a .bak if one exists)

# 3. Restore shell/settings backups if desired
ls ~/.bashrc.bak-* ~/.claude/settings.local.json.bak-*

# 4. Recreate remote-settings.json from the keys in providers.json if needed
```

After rollback, `claude` will use whatever `ANTHROPIC_*` values are exported by
the shell/aliases again.
