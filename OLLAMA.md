# Ollama Setup for localrouter

This document explains how to run Ollama locally and integrate it with the
LiteLLM gateway.

## Quick Start (after install)

Ollama is started **manually**, in its own terminal. The env vars are not
optional: without them Ollama picks a 4096-token context from VRAM and
truncates Claude Code's ~35k prompt.

```bash
# Terminal 1 (keep it open)
OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q4_0 OLLAMA_CONTEXT_LENGTH=81920 ollama serve

# Terminal 2: pull the models (first time only)
ollama pull qwen2.5-coder:1.5b
ollama pull qwen2.5-coder:7b-instruct-q4_K_M
ollama pull qwen3:4b-instruct-2507-q4_K_M

# Verify
ollama ps
ollama run qwen3:4b-instruct-2507-q4_K_M "Hello"
```

Ollama listens on `http://127.0.0.1:11434`.

Keep both the system-wide `ollama.service` and the optional user unit disabled.
`systemd/ollama.service` exists only for starting the same server at login.

## Models

Measured on the RTX 4060 Laptop (8,188 MiB), Q4_K_M weights, q4_0 KV cache.

| LiteLLM `model_name` | Alias | Pull tag | Window | VRAM | Placement |
|---|---|---|---|---|---|
| `qwen2.5-coder-1.5b` | `qwen2.5` | `qwen2.5-coder:1.5b` | 32k | 1.4 GiB | 100% GPU |
| `qwen2.5-coder-7b` | `qwen7b` | `qwen2.5-coder:7b-instruct-q4_K_M` | 32k | 5.1 GiB | 100% GPU |
| `qwen3-4b-instruct-2507` | `qwen4b` | `qwen3:4b-instruct-2507-q4_K_M` | 80k | 6.3 GiB | 100% GPU |

The 4B at the other settings we tested:

| KV cache | Window | Size | Placement |
|---|---|---|---|
| q8_0 | 40,960 | 5.9 GiB | 100% GPU |
| q8_0 | 49,152 | 6.8 GiB | 91% GPU |
| q8_0 | 65,536 | 8.0 GiB | 79% GPU |
| q4_0 | 65,536 | 5.6 GiB | 100% GPU |
| q4_0 | 81,920 | 6.3 GiB | 100% GPU |
| q4_0 | 98,304 | 7.4 GiB | 86% GPU |

**Why 80k.** Claude Code's first request is ~34,673 tokens (system prompt plus
tool definitions). A 32k or 40k window leaves little or no working room, so
auto-compact fires constantly. 80k leaves ~46k for the conversation. q4_0 is
the KV-cache trade-off that buys it; q8_0 cannot reach 80k on this GPU.

Even at 4B, expect tool-call mistakes in long sessions — these are fallbacks,
not replacements for the hosted DeepSeek models.

## Deploy to LiteLLM

```bash
cd ~/repos/personal/localrouter
./install.sh --force          # writes the Ollama entries with num_ctx
systemctl --user restart claude-litellm
```

## Test the Integration

```bash
curl -X POST http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -d '{"model": "qwen3-4b-instruct-2507", "messages": [{"role": "user", "content": "Hello"}], "stream": false}'
```

## Use in Claude Code

Use the LiteLLM `model_name`, never the Ollama tag:

```bash
/model qwen3-4b-instruct-2507   # or: /model qwen4b
```

Do **not** pass `ollama_chat/qwen3:4b-instruct-2507-q4_K_M`. LiteLLM treats an
unknown `provider/model` string as a direct route, so the entry's `think: false`
and `drop_params` never apply.

Tell Claude Code the real window for local sessions:

```bash
CLAUDE_CODE_MAX_CONTEXT_TOKENS=81920 claude
```

Without it, Claude Code assumes 200k for an unrecognized model (the "Model
isn't recognized · context assumed to be 200k" warning) and never compacts
before the request overflows Ollama. Keep it scoped to the shell or session:
set in `~/.claude/settings.json` it would also cap DeepSeek, which is also an
unrecognized id.

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` and
`modelSettings.<model>.autoCompactWindow` cannot help here — they have a
100k minimum.

## Optional: add to the model picker

`~/.claude/settings.json` → `modelPicker.options[]`:

```json
{ "model": "qwen3-4b-instruct-2507", "label": "Qwen3 4B (local)", "description": "Ollama local - 80k context" }
```

Do not use `modelSettings.<model>.contextWindow` — it is not a Claude Code
setting. The supported per-model fields are `effortLevel`, `maxEffortLevel`
and `autoCompactWindow`.

## Notes

- **Ollama must be running** before LiteLLM can reach it.
- No API key needed for local Ollama — LiteLLM connects to `127.0.0.1:11434`.
- `drop_params: true` does **not** drop `thinking`: LiteLLM maps it to
  `reasoning_effort` → Ollama `think`, which non-thinking models reject with
  `400 "... does not support thinking"`. The `think: false` line prevents it.
- `num_ctx` in `config.yaml` is per request and overrides
  `OLLAMA_CONTEXT_LENGTH`; that is why the 7B stays at 32k while the 4B gets 80k.
- `OLLAMA_CONTEXT_LENGTH` is global to the server. Without it, Ollama picks a
  default from VRAM (4096 here) and truncates longer prompts.
- WSL2 sees only what `.wslconfig` allows (`memory=10GB` here, ~9.7 GiB). The
  4B at 80k uses 6.3 GiB of VRAM and a small host footprint.
- **35B MoE does not fit.** Ornith-1.5-35B-A3B and Qwen3.5-35B-A3B are ~35B
  total / ~3B active. Active parameters reduce compute, not memory: the
  weights are ~20–23 GB (the Ollama tag is 23 GB) and must be resident. With
  8 GiB VRAM plus ~10 GiB WSL RAM it will thrash on mmap. The "runs on 8 GB"
  reports mean 8 GB VRAM plus 32–64 GB system RAM. The only plausible Ornith
  here is `ornith-1.5:9b` (6.6 GB), and Claude Code's ~35k baseline plus KV
  still makes it tight. The 4B is the right local pick.
- If you change the Ollama port, update `api_base` in the config.
- Stop/restart: `systemctl --user restart ollama`.
