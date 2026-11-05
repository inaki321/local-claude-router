# localrouter

One local Anthropic-compatible endpoint for Claude Code, backed by
[LiteLLM](https://docs.litellm.ai). Provider keys live in LiteLLM; Claude Code
only knows the local endpoint and a model name.

```text
claude -> 127.0.0.1:4000 (LiteLLM) --+-> DeepSeek    api.deepseek.com/anthropic
                                     +-> OpenRouter  openrouter.ai
                                     +-> LithosAI    api.lithosai.cloud/v1 (translated)
```

## local alias to run first ollama and then claude (litellm already starts at boot)

```
alias ollama-local='OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q4_0 OLLAMA_CONTEXT_LENGTH=81920 

alias claude-local='CLAUDE_CODE_MAX_CONTEXT_TOKENS=81920 ANTHROPIC_MODEL=qwen4b claude'
```

## Parts

| Path | Purpose |
| --- | --- |
| `install.sh` | Writes config, env and systemd unit. Never edits `~/.claude`. |
| `~/.config/litellm/config.yaml.example` | Which `model_name` maps to which provider. |
| `~/.config/litellm/env.example` | Provider keys and the LiteLLM master key. |
| `~/.config/litellm/README.md` | Gateway details, smoke tests, rollback. |
| `systemd/claude-litellm.service.template` | Runs LiteLLM at login. |
| `~/.claude/settings.example.json` | Target Claude settings: endpoint, token, picker. |
| `MODIFICATIONS.md` | Live-machine change log. |

After install, the live files are outside the repo and outside `~/.claude`:

```text
~/.config/litellm/config.yaml   0644, no secrets
~/.config/litellm/env           0600, keys
~/.config/systemd/user/claude-litellm.service
```

## Flow

1. Claude Code sends `POST /v1/messages` to `127.0.0.1:4000` with a `model` string.
2. LiteLLM matches it against `model_list[].model_name` and picks that provider's key.
3. The request is forwarded in the provider's native format and streamed back.

## Install

```bash
pipx install 'litellm[proxy]'

./install.sh --dry-run
./install.sh                      # creates files, stops on REPLACE_WITH
$EDITOR ~/.config/litellm/env
$EDITOR ~/.config/litellm/config.yaml
./install.sh                      # enables and starts the service
```

Then in `~/.claude/settings.json`:

```json
"ANTHROPIC_BASE_URL": "http://127.0.0.1:4000",
"ANTHROPIC_AUTH_TOKEN": "<LITELLM_MASTER_KEY>"
```

After the smoke tests, retire the old router:

```bash
systemctl --user disable --now claude-router
```

## Models

The picker is `modelPicker` in `~/.claude/settings.json`. LiteLLM's model list
is separate; any known `model_name` can be typed directly.

```text
/model                          # picker
/model deepseek-v4-pro
/model lithos-kimi-k3           # any model_name in config.yaml
```

Shortcuts (`ds`, `kimi`, `gemma`, ...) come from `model_group_alias` in
`~/.config/litellm/config.yaml`. Family aliases (`opus`, `sonnet`, `haiku`) come from
`ANTHROPIC_DEFAULT_*_MODEL` in settings.

Add a model in `~/.config/litellm/config.yaml`:

```yaml
- model_name: glm-5-3
  litellm_params:
    model: openai/glm-5.3
    api_base: https://api.lithosai.cloud/v1
    api_key: os.environ/LITHOSAI_API_KEY
```

```bash
systemctl --user restart claude-litellm
```

Optional: add `{"model":"glm-5-3","label":"GLM 5.3","description":"LithosAI"}`
to `modelPicker.options` to show it in the picker.

## Service

```bash
systemctl --user status claude-litellm
systemctl --user restart claude-litellm
journalctl --user -u claude-litellm -f
curl -s http://127.0.0.1:4000/health/liveliness
```

## Notes

- **What runs:** LiteLLM is a pipx-installed Python proxy, not a container. Binary at `~/.local/bin/litellm`, venv at `~/.local/share/pipx/venvs/litellm`; systemd runs it. It holds no weights and no database; `config.yaml` and `env` are the only state.
- **Auth:** `ANTHROPIC_AUTH_TOKEN` must equal `LITELLM_MASTER_KEY`; a 401 means they differ.
- **Keys:** only in `~/.config/litellm/env` (`0600`); the gateway binds loopback only.
- **Parameters:** `drop_params: true` drops Anthropic-only fields for OpenAI backends.
- **Paths:** `openai/` models need the `/v1` suffix in `api_base`; drop it on 404s.
- **Port:** if `:4000` is busy, the old `claude-router` is still running.
- **Rollback:** the router is in git history (`git log --all -- '~/.claude/router/router.mjs'`).
