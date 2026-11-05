# LiteLLM gateway

The only local endpoint. Accepts Anthropic Messages and routes each request to a
provider by `model_name`, translating to OpenAI format only where required.

| `model_name` | Provider | Format |
| --- | --- | --- |
| `deepseek-v4-flash`, `deepseek-v4-pro` | DeepSeek direct | Anthropic |
| `openai/gpt-oss-120b`, `google/gemma-…:free`, … | OpenRouter | native provider |
| `lithos-kimi-k3` | LithosAI | OpenAI, translated |

Shortcuts live in `router_settings.model_group_alias` (`ds`, `kimi`, `gemma`, …).
Claude Code's picker comes from `modelPicker` in settings, not from this file.

## update env variables for litellm
```
# depends on what you want to update, apikey or endpoint
nano ~/.config/litellm/ <env> or <config.yaml> 

# restart service with changes

systemctl --user restart claude-litellm

```

## What LiteLLM is

A Python proxy server (FastAPI/uvicorn), not a container and not an LLM. It is
installed with pipx into an isolated venv:

```text
~/.local/share/pipx/venvs/litellm/          # package + dependencies
~/.local/bin/litellm -> .../bin/litellm     # executable used by systemd
```

`claude-litellm.service` runs that binary with `--config` and `--host/--port`.
It holds no model weights and no database; `config.yaml` and `env` are the only
state. A Docker image exists (`ghcr.io/berriai/litellm`) but is not used here.

```bash
litellm --version
pipx upgrade litellm
```

## Files

| Path | Purpose |
| --- | --- |
| `config.yaml.example` | `model_list`, shortcuts, `drop_params`, master key. |
| `env.example` | Provider keys; deployed to `~/.config/litellm/env` (`0600`). |
| `../../../systemd/claude-litellm.service.template` | Unit rendered by `../../../install.sh`. |
| `../../../install.sh` | Deploys config, env and unit. Never edits `~/.claude`. |

## Install

```bash
pipx install 'litellm[proxy]'
cd ../../..
./install.sh                        # stops on REPLACE_WITH placeholders
$EDITOR ~/.config/litellm/env
$EDITOR ~/.config/litellm/config.yaml
./install.sh
```

Auth: Claude Code sends `ANTHROPIC_AUTH_TOKEN`; LiteLLM accepts it as Bearer.
Set it to the `LITELLM_MASTER_KEY` value.

## Smoke test

```bash
KEY=$(grep '^LITELLM_MASTER_KEY=' ~/.config/litellm/env | cut -d= -f2-)

curl -s http://127.0.0.1:4000/v1/messages \
  -H "x-api-key: $KEY" -H 'anthropic-version: 2023-06-01' \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-flash","max_tokens":32,
       "messages":[{"role":"user","content":"hi"}]}'

claude --settings '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4000",
                           "ANTHROPIC_AUTH_TOKEN":"'"$KEY"'"}}'
```

## Add a model

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

Add a picker row in `~/.claude/settings.json` only if you want it listed;
`/model <name>` works without one.

## Notes

- `provider:model` syntax and regex rules belonged to the old router; use
  `model_name` values or `model_group_alias`.
- `openai/` models: keep `/v1` in `api_base`; drop it if requests 404.
- Pin the LiteLLM version once it works; its config surface moves.
- Rollback: `systemctl --user disable --now claude-litellm`; the old router is
  in git history (`git log --all -- '~/.claude/router/router.mjs'`).
