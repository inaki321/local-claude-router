# Wiring It into LiteLLM

What each knob in a LiteLLM model entry does, and how to decide the values for a
new model.

Assumes [03-running.md](03-running.md) — the server must already be running.

---

## The chain

```
Claude Code  ──Anthropic Messages API──▶  LiteLLM  ──OpenAI chat format──▶  Ollama
             (messages, tools, thinking)         (translation)           (/api/chat)
```

Three different dialects. Claude Code speaks Anthropic's. Ollama speaks its own.
LiteLLM translates between them.

**Every parameter that doesn't survive translation is a config line you write.**
That's the entire reason `drop_params` and `think` exist.

---

## A complete entry

```yaml
- model_name: qwen3-4b-instruct-2507          # ① what you ask for
  litellm_params:
    model: ollama_chat/qwen3:4b-instruct-2507-q4_K_M   # ② where it goes
    api_base: http://127.0.0.1:11434         # ③ the server
    num_ctx: 81920                           # ④ capacity
    drop_params: true                        # ⑤ tolerance
    think: false                             # ⑥ capability
```

| Line | Category | Decides |
|---|---|---|
| `model_name` | routing | the alias you type — `/model qwen4b` resolves here |
| `model:` | routing | `provider/real-model-id`, the actual backend |
| `api_base` | routing | which server; needed because this isn't a hosted provider |
| `num_ctx` | **capacity** | context window → drives KV cache size |
| `drop_params` | **tolerance** | what to do with params the backend can't accept |
| `think` | **capability** | reasoning mode on/off for this model |

Three are plumbing you copy verbatim. Only `num_ctx` and `think` require thinking
about the specific model.

---

## ① `model_name` — the alias

What you reference from the client. Two things to keep straight:

- Use the **alias**, not the Ollama tag, when selecting a model in Claude Code.
- Never write the tag as the alias (e.g. `model_name: ollama_chat/qwen3:...`).
  LiteLLM treats an unknown `provider/model` string as a direct route, bypassing
  every `litellm_params` on the entry — so `think: false` and `drop_params` never
  apply, and you get unexplained 400s.

---

## ② `model:` — why `ollama_chat/` and not `ollama/`

Two different Ollama endpoints:

| Prefix | Endpoint | Handles |
|---|---|---|
| `ollama/` | `/api/generate` | plain prompt-in, text-out |
| `ollama_chat/` | `/api/chat` | **messages array, chat template, tool calls** |

An agent client sends structured messages and tool definitions. Only `/api/chat`
understands those. With `ollama/` your tools silently vanish and the chat template
is never applied — the model sees a flat string and behaves accordingly.

**In an agent context, always `ollama_chat/`.**

---

## ④ `num_ctx` — capacity

Set from the memory math in [02-sizing.md](02-sizing.md). It overrides the
server-wide `OLLAMA_CONTEXT_LENGTH` for this one model.

```
OLLAMA_CONTEXT_LENGTH=81920     server default, every model
num_ctx: 81920                  this model only, per request
```

Two rules:

1. **Must match the client's assumption.** If the client thinks the window is
   200k and the server is configured for 80k, the client never compacts and
   requests eventually overflow.
2. **It costs VRAM quadratically in usefulness, linearly in memory.** Doubling
   the window roughly doubles KV. See the sizing formulas.

---

## ⑤ `drop_params: true` — tolerance

The client sends Anthropic-shaped fields (`thinking`, `metadata`, `top_k`,
`stop_sequences`…). Some backends reject unknown fields with a 400.

```
drop_params: false  →  any unsupported param → hard error, request fails
drop_params: true   →  LiteLLM silently deletes what the backend rejects
```

- **`true` for daily use** — keeps things running across mixed providers.
- **`false` when debugging** — the seatbelt also hides mistakes. If a model
  behaves oddly, flipping this to `false` usually surfaces the offending
  parameter in the error message.

### The catch that bites everyone

**`drop_params` does not drop `thinking`.** LiteLLM *translates* it into
`reasoning_effort`, which Ollama maps to `think`. By the time it reaches the
backend it's a supported parameter name — so it is never dropped, and a
non-thinking model rejects it:

```
400 - "... does not support thinking"
```

That is exactly why the next line exists.

---

## ⑥ `think: false` — capability negotiation

Some models emit a reasoning block before their answer ("thinking" models), some
answer directly ("instruct" models). Sending thinking to a non-thinking model is
a hard 400.

Two reasons to care:

1. **It fails outright** on non-thinking models.
2. **Even on models that do think**, reasoning blocks inside an agentic loop
   break tool-call parsing and burn context on tokens the harness can't see.

### Choosing the value

| Model type | Setting |
|---|---|
| Instruct / non-thinking | `think: false` (required) |
| Reasoning model, chat use | `think: true` or omit |
| Reasoning model, tool-calling loop | usually `false` — check the template |

Confirm which type a model is:

```bash
ollama show <tag> | head -20    # Capabilities: tools, thinking, vision
```

No `thinking` in that list → set `false`, or you'll hit the 400.

---

## Deciding the values for a new model

You don't guess. Two commands answer everything:

```bash
ollama show <tag>                   # capabilities, architecture, parameters
ollama show <tag> --template        # tool format, reasoning blocks
```

Then fill the template:

```
1. thinking?      capabilities list "thinking"  → think: true/false
                  not listed                    → think: false (avoid the 400)
2. window?        from the memory math          → num_ctx
3. chat or tools? agent context                 → ollama_chat/
4. strict?        drop_params: true; false to debug
5. quirks?        reasoning tags, odd stop tokens, baked-in system prompt
```

**The shortcut:** most of these lines are identical for every local model. Only
`num_ctx` (memory math) and `think` (does it reason) change. Everything else is
boilerplate for "local Ollama via /api/chat".

So when adding a model, the real questions are exactly two:

> How much context does this model's memory budget allow?
> Does it have a thinking mode, and do I want it here?

---

## Worked examples

### A 4B instruct model at long context

```yaml
- model_name: qwen3-4b-instruct-2507
  litellm_params:
    model: ollama_chat/qwen3:4b-instruct-2507-q4_K_M
    api_base: http://127.0.0.1:11434
    num_ctx: 81920
    drop_params: true
    think: false
```

- `81920` because the weights are only ~2.4 GB on an 8 GB card, leaving room for a
  large KV cache — and the client's baseline prompt is ~35k, so anything smaller
  leaves no working room.
- `think: false` because it's the `instruct` (non-thinking) variant. Sending
  `true` is a 400.

### A 7B coder model at moderate context

```yaml
- model_name: qwen2.5-coder-7b
  litellm_params:
    model: ollama_chat/qwen2.5-coder:7b-instruct-q4_K_M
    api_base: http://127.0.0.1:11434
    num_ctx: 32768
    drop_params: true
    think: false
```

- `32768`, not `81920`, because the weights are ~4.4 GB — nearly twice the 4B's.
  On the same card that leaves far less room for KV, so the window shrinks.
- `think: false` is defensive: Qwen2.5-Coder is non-thinking, and the flag keeps
  a translated `reasoning_effort` from ever reaching it.

The only difference between these two entries is `num_ctx`. That's the point —
the rest is the same boilerplate.

---

## Checking it works

```bash
curl -X POST http://127.0.0.1:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -d '{"model": "qwen3-4b-instruct-2507",
       "messages": [{"role": "user", "content": "Hello"}],
       "stream": false}'
```

Then confirm on the Ollama side that it actually loaded with the window you asked
for:

```bash
ollama ps        # CONTEXT column must match num_ctx
```

If `CONTEXT` is smaller than your `num_ctx`, the request was capped — usually
because the KV cache didn't fit, which sends you back to
[02-sizing.md](02-sizing.md).
