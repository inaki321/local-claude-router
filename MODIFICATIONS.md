# Changes made outside this repo

Date: 2026-11-02
Machine: `omen00` (WSL2)

This file is the record of every change made to the live system so the setup
can be audited or rolled back. The repo is the canonical source; the live
copies are deployed by `install.sh`.

## 2026-11-05: Ollama local models fixed

The live Ollama was a manually started `ollama serve` (PID 9000, started
16:50) with no `OLLAMA_*` variables in its environment. `ollama ps` showed a
4096-token context, so Claude Code's ~34,673-token request failed with
`request (34673 tokens) exceeds the available context size (4096 tokens)`.
The system-wide unit was already disabled.

Changes:

- Added `systemd/ollama.service` (optional user unit) with
  `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q4_0` and
  `OLLAMA_CONTEXT_LENGTH=81920`. It is **disabled** on this machine: Ollama is
  started manually (below), as before. The unit stays in the repo only for
  anyone who wants it started at login.
- `~/.config/litellm/config.yaml.example`: added per-model `num_ctx`
  (4B: 81920, 7B: 32768, 1.5B: 32768), overriding the global default.
- `~/.claude/settings.example.json`: added a `qwen3-4b-instruct-2507` row to
  `modelPicker`.
- Use `/model qwen3-4b-instruct-2507` (or `qwen4b`), not the
  `ollama_chat/...` tag: LiteLLM treats the raw tag as a direct provider
  route, so `think: false` and `drop_params` never apply.
- Start local-model sessions with `CLAUDE_CODE_MAX_CONTEXT_TOKENS=81920`;
  otherwise Claude Code assumes 200k and never compacts before Ollama
  overflows. The live `~/.claude/settings.json` also contains
  `modelSettings.*.contextWindow`, which is not a supported key and does
  nothing; it can be removed at will.

### LithosAI

- `model_list`: `deepseek-v4-flash-lith` -> `openai/deepseek-ai/DeepSeek-V4.1-Flash`
  at `https://api.lithosai.cloud/v1`. Alias: `lith`.
- `LITHOSAI_API_KEY` added to `~/.config/litellm/env` (0600). The key is not
  recorded here or in the repo.
- The model is a reasoning model: it returns `reasoning_content` before the
  answer, so budget enough `max_tokens`.
- This replaces the repo example's `REPLACE_WITH_LITHOS_MODEL_ID` placeholder,
  so `install.sh` no longer refuses to run.
- Added `deepseek-v4-flash-lith` to the live `~/.claude/settings.json` picker
  (the default model remains `qwen3-4b-instruct-2507`), and replaced the stale
  `lithos-kimi-k3` row in the repo example.
- Fix: `litellm_settings.use_chat_completions_url_for_anthropic_messages: true`.
  Claude Code uses `/v1/messages`; LiteLLM otherwise sends `openai/`
  deployments to the Responses API (`/v1/responses`), which LithosAI returns
  404 for. That cooled the deployment down and surfaced as
  `429 No deployments available for selected model`.

Measured (RTX 4060 Laptop, 8,188 MiB), qwen3 4B Q4_K_M:

| KV | context | size | placement |
| --- | --- | --- | --- |
| q8_0 | 49,152 | 6.8 GiB | 91% GPU |
| q8_0 | 65,536 | 8.0 GiB | 79% GPU |
| q4_0 | 65,536 | 5.6 GiB | 100% GPU |
| q4_0 | 81,920 | 6.3 GiB | 100% GPU |
| q4_0 | 98,304 | 7.4 GiB | 86% GPU |

Not viable here: Ornith-1.5-35B-A3B and Qwen3.5-35B-A3B (23 GB Ollama tag).
"3B active" reduces compute, not memory; the weights must be resident. 8 GiB
VRAM + ~10 GiB WSL RAM does not hold 23 GB. The "runs on 8 GB" reports mean
8 GB VRAM plus 32-64 GB system RAM. `ornith-1.5:9b` (6.6 GB) is the only
plausible Ornith and is still tight with Claude Code's ~35k baseline.

Manual start (the live workflow):

```bash
OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q4_0 OLLAMA_CONTEXT_LENGTH=81920 ollama serve
```

LiteLLM was updated in place (`num_ctx` added to the three Ollama entries) and
restarted. `./install.sh --force` was **not** run: the example's Lithos entry
still contains `REPLACE_WITH_LITHOS_MODEL_ID`, which the installer refuses.
Restart after editing the live config:

```bash
systemctl --user restart claude-litellm
```

## Status 2026-11-03: LiteLLM applied, router removed

Applied on this machine:

- Installed LiteLLM 1.106.6 via `pipx install 'litellm[proxy]'`.
- Created `~/.config/litellm/config.yaml` (DeepSeek + OpenRouter; Lithos
  commented out until a key and model id exist) and `~/.config/litellm/env`
  (`0600`, existing DeepSeek/OpenRouter keys).
- Created and enabled `~/.config/systemd/user/claude-litellm.service`. It
  listens on `127.0.0.1:4000` and starts at login (linger enabled).
- `~/.claude/settings.json` needed no edit: `ANTHROPIC_BASE_URL` was already
  `http://127.0.0.1:4000`, and `ANTHROPIC_AUTH_TOKEN` (`claude-router-local`)
  was reused as `LITELLM_MASTER_KEY`.
- Disabled and deleted `claude-router.service`; removed `~/.claude/router/`.
- Backup of the old router, unit and settings:
  `~/.config/litellm/backup-20261103-174950/` (0700/0600).

Verified end-to-end: `deepseek-v4-flash` and `openai/gpt-oss-120b` both answer
through `:4000`, including from a nested `claude` session.

Lithos remains disabled: no key/model id yet. To enable it, uncomment the
`model_list` entry in `~/.config/litellm/config.yaml`, add `LITHOSAI_API_KEY`
to the env file, and `systemctl --user restart claude-litellm`.

Rollback: restore the backup, reinstall the old unit, `systemctl --user enable
--now claude-router`, and `systemctl --user disable --now claude-litellm`.

Everything below is the historical record of the 2026-11-02 router setup.

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
