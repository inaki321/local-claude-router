# What Is a Model?

Before asking whether a model fits, it helps to know what the thing on disk
actually is. A model is not a program. It's a large table of numbers plus a small
amount of glue that tells a runtime how to use them.

---

## A model file is four things

A `.gguf` (or `.safetensors`, or Ollama's blob) contains:

| Part | Size | What it does |
|---|---|---|
| **Weights** | 99 % of the file | the learned numbers — the "intelligence" |
| **Tokenizer** | ~1–10 MB | turns text into token IDs and back |
| **Chat template** | a few KB | the exact text format for turns, and for tool calls |
| **Metadata** | a few KB | architecture config: layers, heads, head_dim, rope, context limit |

Everything that matters for behaviour is in the weights. Everything that matters
for *interfacing* is in the template. The metadata is what you need for the
memory math.

Nothing in the file changes when you use it. It is read-only data.

---

## Parameters

A model's headline number is its parameter count — `4B`, `12B`, `70B`. Parameters
are the individual learned values inside the weight tensors. That count is fixed
at training time and is the single best predictor of both quality and size.

**Total vs active.** Dense models use every parameter for every token. Mixture
of Experts models use a subset — see [below](#dense-vs-mixture-of-experts). For
memory purposes, total is what counts.

**Parameters are not tokens.** Roughly, one parameter ≈ 2 bytes at full
precision, and a 4B model at Q4 occupies ~2.4 GB — that's it. Parameters don't
correspond to words or facts one-to-one; they're distributed representations.

---

## Quantization

Weights are trained in 16-bit floats. Storing all of them that way is expensive,
so they're compressed — quantized — into fewer bits. This is the largest single
lever you have on model size.

| Format | Effective bits per weight | Size vs F16 |
|---|---|---|
| F16 / BF16 | 16.0 | 100 % |
| Q8_0 | 8.5 | 53 % |
| Q6_K | 6.6 | 41 % |
| Q5_K_M | 5.7 | 36 % |
| **Q4_K_M** | **4.85** | **30 %** |
| Q3_K_M | 3.9 | 24 % |
| Q2_K | 2.6 | 16 % |

```
size_GB = params_in_billions × bpw / 8
```

The `_K_M` suffix means "K-quant, medium" — a block-wise scheme that stores
groups of weights with a shared scale, which is why effective bpw exceeds the
nominal number.

Quality falls non-linearly. Q4_K_M is the widely accepted sweet spot; below
Q3_K_M the damage becomes obvious, and small models suffer far more than large
ones. Full tradeoff table in [02-sizing.md](02-sizing.md#quant-quality-where-to-spend-and-where-not).

---

## Context window

The maximum number of tokens the model can consider at once — prompt plus
generated output plus every tool result. It's a limit of the architecture, not a
setting, though runtimes let you *lower* it.

Two consequences that surprise people:

1. **The window is not free.** Every token in it occupies memory (see below).
2. **A big advertised window is often impractical.** A model claiming 256k
   context doesn't mean you can *run* 256k on your hardware. The architecture
   permits it; your memory budget decides.

---

## The KV cache

This is the concept that trips up almost everyone, so it's worth being precise.

**The KV cache is not stored in the model.** It doesn't ship with the file and it
isn't a learned artifact. It's a working buffer the runtime allocates when the
model loads and fills as it processes your text.

```
your text → token IDs → [weights] → per-layer Keys and Values → KV cache
                                          ↑
                              this is what gets stored, and
                              what the next token reads
```

The model file determines **how big the cache is per token** — the shape comes
from `layers × kv_heads × head_dim`. The **contents** come entirely from your
prompt, computed on the fly.

### Lifecycle

| Moment | KV cache state |
|---|---|
| Model on disk | does not exist |
| Model loaded, no prompt | allocated, empty, sized to max context |
| Processing the prompt (prefill) | filled, token by token |
| Generating a reply (decode) | grows by one token per generated token |
| Reply finished | **discarded** |

After each response it's gone. The model has no memory between requests — which
is why the whole conversation is re-sent with every message. That's a property of
the protocol, not a limitation of the model.

### The exception: prompt caching

There *is* a reuse mechanism, but it's server-side, not model-side:

```
request 1: [35k system prompt + "hi"]        → compute 35k tokens of KV (slow)
request 2: [35k system prompt + "hi" + ...]  → identical prefix
           → server reuses the stored KV, computes only the new part
```

The server keeps a copy of the KV cache for a prefix, keyed by its hash.
llama.cpp has `--prompt-cache`, vLLM does automatic prefix caching, hosted APIs
do it transparently and bill "cache reads" cheaper than fresh input. This saves
**compute**, not memory — the cache still occupies VRAM while in use.

### Why it matters

KV grows linearly with context while weights stay fixed. At long context the
cache can exceed the weights themselves. Quantizing the KV cache (`q8_0`, `q4_0`)
is a separate knob from quantizing the weights, and it's often the only reason a
long context fits at all. Math in [02-sizing.md](02-sizing.md#kv-cache-the-term-that-breaks-most-plans);
full conceptual treatment in [01b-the-kv-cache.md](01b-the-kv-cache.md).

---

## Dense vs Mixture of Experts

| | Dense | MoE |
|---|---|---|
| Params | all active | e.g. 35B total, 3B active |
| Memory needed | all params | **all params** |
| Compute per token | all params | only active params |
| Speed | bandwidth ÷ all weights | bandwidth ÷ **all weights** |

Sparsity saves compute, not memory. The weights still have to be resident. Since
decoding is bandwidth-bound, a 35B-A3B model runs at the speed of a 35B model,
not a 3B one — unless the weights fit comfortably in memory. This is the most
common misunderstanding in "runs on 8 GB" claims, which usually mean 8 GB VRAM
*plus* 32–64 GB of system RAM.

---

## Can it actually do tool calls?

Fitting in memory says nothing about whether a model can drive an agent. Tool use
is a **trained behaviour plus a format contract**, and both are inspectable.

### Check 1 — the chat template (decisive, free, instant)

The chat template ships inside the model file.

```bash
ollama show <model> --template            # local, instant
```

On Hugging Face: model page → **Files and versions** → `tokenizer_config.json`
→ the `"chat_template"` field.

| Marker in the template | Meaning |
|---|---|
| `{%- if tools %}` | has a tools branch — good |
| `<tool_call>`, `<function=`, `"tool_calls"` | a recognised tool-call format |
| `<|python_tag|>` | Llama-style tool format |
| `thinking` / `reasoning` block | may need to be disabled for clean tool calls |

**No tools branch → the model was not trained for tool calls.** You can prompt-
engineer it into emitting JSON, but you're fighting the training distribution and
it fails under pressure. This check alone eliminates most candidates in seconds.

### Check 2 — was it trained for it, and how well

Simplest first:

```bash
ollama show <model> | head -20     # prints "Capabilities: tools, thinking, vision, ..."
```

| Question | Where to check | What to look for |
|---|---|---|
| Does the runtime think it supports tools? | `ollama show <model>` | `tools` in the Capabilities line |
| Is it built for this? | Hugging Face model card | "Function calling", "Agentic", "Tool use" sections; tags |
| How good is it? | BFCL leaderboard | the **multi-turn** score, not just single-turn |
| Real agent behaviour? | τ-bench / τ²-bench | multi-turn tool use under environment rules |
| Coding agents specifically? | SWE-bench Verified, Terminal-bench | |
| Am I allowed to use it? | model card → Licence | Apache-2.0 / MIT vs Llama community vs non-commercial |
| What is it actually for? | model card intro + "Intended use" + base model link | chat vs coding vs reasoning vs fine-tune of X |

**Caveat:** a `tools` capability means the runtime will *pass* tool definitions
to the model. It does not mean the model uses them well. Capability is not
competence.

### Two-minute sanity test

Give it 3–5 tools and a task that requires two chained calls. Then watch for:

| Failure | What it looks like |
|---|---|
| Malformed JSON | trailing commas, invented parameter names, wrong nesting |
| No chain awareness | calls tool A, never uses the result in call B |
| Over-calling | invents a call for something answerable directly |
| Under-calling | answers from memory instead of using the tool |
| Looping | same tool, same arguments, repeatedly |

The last two are where small models die in agentic loops, and no leaderboard
table prepares you for them.

### Short version

```
1. ollama show <model>              → is `tools` listed?
2. ollama show <model> --template   → is there a tools branch?
3. model card                       → trained for it? what for? licence OK?
4. chained-call test                → does it survive two calls?
```

---

## Inspecting any model

```bash
ollama show <tag>                   # architecture, parameters, capabilities
ollama show <tag> --template        # the chat template, including tool format
ollama show <tag> --modelfile       # the exact parameters it was built with
ollama list                         # what you have, with sizes
```

The `parameters` block in `--modelfile` tells you defaults the model author
chose: `num_ctx`, `temperature`, `stop` tokens, and whether a system prompt is
baked in.

---

Next: [Will it fit?](02-sizing.md) — the arithmetic that turns these specifications
into a yes/no answer for your hardware.
