# The KV Cache, Explained

The cache is the most misunderstood part of local inference, and almost all of
that comes from one wrong assumption: that it's something the model learned, or
something the runtime decides to save selectively.

Neither is true. This document covers what it actually is, why caching never
changes an answer, and what a small window versus a large one really costs you.

---

## The short answer

**The KV cache is a runtime data structure, not a trained artifact.** It is not
in the model file, the model has no awareness of it, and nothing decides what to
put in it.

It is not a recording of your prompts and answers. It is **your conversation
re-encoded into tensors** — specifically, one key vector and one value vector per
token, per layer. Practically it plays the role of "memory of the past", which is
why it's easy to think of it as saved prompts. Mechanically, it's closer to a
notebook of intermediate work than a transcript.

---

## What's actually in it

Inside each attention layer, processing a token looks like this:

```
new token  →  weights  →  query (q), key (k), value (v)

score_i   = q · k_i          for every past token i     ← "how relevant is token i?"
weights   = softmax(scores)                              ← relevance becomes a blend factor
output    = Σ weights_i × v_i                            ← mix the past information

then: append this token's k and v to the cache
```

So the cache holds the **keys and values of every token processed so far**. Not
the text, not the replies — the substrate that lets the next token look back at
everything that came before.

That's also why the API is stateless: your conversation text is re-sent with every
request, and the cache is that text re-encoded through the weights.

### Why it exists at all

Without a cache, generating token N would require re-processing all N-1 previous
tokens from scratch. The cache turns that into "compute the new token, then attend
over stored values". It's a pure speed optimization.

---

## Is it trained?

Three different things get conflated. Unpacked:

| Thing | Trained? | What it means |
|---|---|---|
| The **K/V projection weights** | **Yes** | learned in training, like every other weight |
| The **cache itself** | **No** | allocated at load time, filled at request time, discarded after |
| The **usable context length** | **Yes** | how far the model stays reliable, a training property |

The model has no representation of "I am being cached". Training never sees a
cache. Caching is an inference-time implementation detail.

### The one thing that *is* trained: how far context stays reliable

A model trained at 8k degrades past 8k even if you configure a 32k window — the
positional encoding extrapolates badly. A model trained at 262k is comfortable at
80k.

So "how much context can I actually use" is partly a property of training, and
it's stated on the model card. Setting a bigger window than the model was trained
for gives you tokens it can technically attend to and doesn't understand well.

---

## Who decides what gets cached?

**The runtime. Not the model. There is no decision being made.**

The policy in every standard runtime is simple and absolute:

```
every token in the window, in order, at every layer, always
```

No ranking of important tokens, no summarization, no dropping of boring ones. If
a token is in the window, its k/v is cached. If it's outside, it isn't.

You control exactly two knobs, and both are yours:

| Knob | Controls |
|---|---|
| `num_ctx` / `OLLAMA_CONTEXT_LENGTH` | **how many** tokens can be in the window |
| `OLLAMA_KV_CACHE_TYPE` | **how precisely** each cached value is stored |

> Research techniques exist (attention sinks, H2O, StreamingLLM) where the
> *algorithm* evicts low-importance tokens. That's still not "the model deciding"
> — it's a policy shipped by the runtime. Ollama doesn't do it by default.

---

## Cache precision vs. cache coverage

"90 %" can mean two completely different things, and they fail differently.

| | Precision (`KV_CACHE_TYPE`) | Coverage (`num_ctx` vs. conversation length) |
|---|---|---|
| Question | how exactly is each value stored? | how much of the conversation fits? |
| 90 % means | slightly lossy numbers | 10 % of the context is dropped |
| Failure | subtle numerical error | real information loss |
| Fix | use `q8_0` or `f16` | raise the window, or shorten the conversation |
| Cost | free to change, saves lots of VRAM | costs VRAM, and there's a hard ceiling |

Both matter. They are not the same knob.

---

## What a window that covers 90 % vs. 20 % actually means

Define **coverage** as:

```
coverage = context window ÷ tokens the conversation actually needs
```

Below 100 %, something has to be dropped — and the order matters, because
runtimes drop from the **front**, which is where the system prompt and tool
definitions live.

| Coverage | What's lost | Typical symptom |
|---|---|---|
| **100 %+** | nothing | correct answers |
| **90 %** | oldest 10 % | *if that's the system prompt:* the model forgets its rules, its role, its tool definitions — answers get formally correct but wrong in behaviour. *If it's old chit-chat:* usually harmless |
| **50 %** | half the conversation | forgets the original goal, repeats work already done, re-reads files it already read |
| **20 %** | nearly everything | contradicts earlier statements, hallucinates state, answers as if the session just started |
| **< baseline prompt** | the system prompt itself | catastrophic — the model doesn't know what it is or what tools it has |

### The counter-intuitive part

**90 % coverage can be worse than 20 % coverage for a specific class of failure.**

At 20 %, the loss is so obvious that you notice the model flailing and restart.
At 90 %, everything *looks* fine — the model is coherent, the tools work — but
the rules it lost were exactly the ones enforcing format, safety, and procedure.
Silent degradation is more dangerous than visible degradation.

This is why an agent's baseline prompt (system message + tool schemas, often
~35k tokens) should be treated as a **floor**, not as part of your budget. If the
window is 80k and 35k is baseline, your real working room is 45k — coverage of the
conversation is measured against what's left, not against the window.

### What coverage costs in memory

Coverage is not free. Every retained token occupies VRAM. For a 4B model (36
layers, 8 KV heads, head_dim 128), at `q4_0`:

| Window | KV cache | Coverage of a 100k-token session | Verdict |
|---|---|---|---|
| 20k | 0.8 GiB | 20 % | most of the session invisible |
| 40k | 1.6 GiB | 40 % | workable for short tasks |
| 80k | 3.3 GiB | 80 % | the practical ceiling on 8 GB |
| 98k | 3.8 GiB | 98 % | card starts spilling — slower *and* marginal gain |

At `f16` those numbers are ~3.6× larger, which is why 80k is impossible without
quantizing the cache.

**The tradeoff is explicit:** coverage buys context, and context costs VRAM, and
VRAM has a hard ceiling. There is no setting that gives you both.

---

## Does caching ever make answers wrong?

Four distinct failure modes, only two of which are real:

### 1. No cache → slower, identical output

If the runtime recomputed everything, the output would be the same. Caching
changes speed, not correctness. It is exact.

### 2. Quantized cache → genuinely approximate

This is the honest version of "90 % accurate". Storing 4 bits instead of 16 is
lossy, in the same way weight quantization is lossy.

| Type | Bytes/token (4B example) | Quality |
|---|---|---|
| `f16` | 144 KiB | exact |
| `q8_0` | ~55 KiB | effectively exact |
| `q4_0` | ~40 KiB | small approximation |

The error is usually imperceptible, but it compounds over long contexts and shows
up first in exact tasks: numbers, identifiers, precise formatting.

### 3. Window overflow → real information loss

See the coverage table above. Dropped tokens are gone; the model cannot see them.

### 4. Attention dilution → quality drop with length

Even with a complete, exact cache, a model attends worse across 80k tokens than
across 2k. Signal spreads thin, and the middle of a long context is famously
under-weighted ("lost in the middle").

Nothing is wrong with the cache here. It's the model's capacity.

---

## Prefix caching (a different thing with a similar name)

Separate from cache *size* is cache *reuse* across requests. Servers keep the
computed k/v for a prompt prefix, so request 2 doesn't recompute an identical
35k-token system prompt.

The rule: **the prefix must match byte for byte.** Change one character in the
system prompt, or let a timestamp get injected, and the prefix hash changes —
cache miss, full recompute. Slow, never wrong.

The only way this produces wrong answers is an implementation bug: a stale cache
hitting on a changed prefix. It's rare, and it looks like answers referencing a
*different* conversation.

---

## Diagnosing which problem you have

| Symptom | Likely cause |
|---|---|
| Ignores something said earlier | window overflow — check `ollama ps` CONTEXT |
| Slow first token, correct answers | cache miss / long prefill — recompute, harmless |
| Subtly wrong numbers or IDs in long sessions | KV quantization — try `q8_0` |
| Degrades gradually as the conversation grows, at f16 | attention dilution — not fixable by config |
| References a different conversation entirely | stale prefix cache — restart the server |
| Formally correct but ignores its rules | system prompt truncated by coverage — raise the window |

---

## Short version

- The cache is **not trained**. It's allocated at load time and discarded per
  request.
- It stores **keys and values**, not prompts and answers — the conversation
  re-encoded, not a transcript.
- **Nothing decides** what to cache. Every token in the window is cached, in
  order, always.
- Caching is **exact**; *quantizing* the cache is approximate.
- **Coverage** (window ÷ conversation) is what loses information, and it drops
  from the front — where your rules live.
- Coverage costs VRAM. There is no config that gives you both.
