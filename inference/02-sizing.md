# Will It Fit?

The memory and speed arithmetic for local inference. Answer this before
downloading 20 GB.

New to the terms? Read [01-what-is-a-model.md](01-what-is-a-model.md) first.

---

## TL;DR — the whole thing in one formula

```
VRAM needed  =  weights  +  KV cache  +  overhead

weights   =  params × bits_per_weight / 8
KV cache  =  2 × layers × kv_heads × head_dim × (bytes per element) × tokens
overhead  =  ~0.5–1.0 GB   (compute buffers, CUDA context, display)
```

If `VRAM needed` is under your usable VRAM → fast. Slightly over → slow.
Way over → unusable.

---

## The reference machine

Examples below use this machine, because 8 GB is the tightest case people
actually try to run and it makes the constraints visible:

| Spec | Value |
|---|---|
| GPU | RTX 4060 Laptop, 8 GB VRAM |
| RAM | 10 GB (WSL2 cap) |
| Bandwidth | ~272 GB/s |
| Usable VRAM | ~7.3 GiB |

**Substitute your own numbers** — the arithmetic is identical. If you're on a
24 GB card or an Apple Silicon machine with unified memory, swap the figures and
the same five lines tell you what fits.

> Unified-memory machines (Apple Silicon, some APUs) collapse the VRAM/RAM
> distinction: there is one pool. Substitute total usable unified memory for
> "VRAM" and expect somewhat lower effective bandwidth than the spec sheet.

---

## The three memory pools

A model can live in three places. They are *not* interchangeable.

| Pool | Speed | What it's for |
|---|---|---|
| **VRAM** (GPU) | 200–3000 GB/s | the only place that matters |
| **System RAM** | 40–100 GB/s | spillover, kills throughput |
| **Swap / mmap on disk** | ~2 GB/s | never; this is the thrash state |

The rule that governs everything: **inference is memory-bandwidth-bound, not
compute-bound.** Generating one token means reading every active weight once. So
the *speed* of a model is essentially `bandwidth ÷ model size`. When part of the
model sits in RAM instead of VRAM, you pay the RAM bandwidth for those layers,
and speed collapses by 4–10×.

That is why "it fits in 8 GB VRAM + 16 GB RAM" models are marketed as running on
8 GB cards. They technically run. They generate at 3 tok/s.

### Why advertised VRAM is never usable VRAM

A card reporting 8188 MiB does not offer 8188 MiB to the model. Subtract:

- driver + CUDA context: ~200–400 MiB
- display compositor, browser, desktop: ~300–1200 MiB
- compute buffers for the model itself: ~300–800 MiB
- allocator fragmentation: a few hundred MiB

On a headless box you get ~90 % of nominal. On a desktop with a browser open,
assume 80 %. **Always plan against the smaller number.**

---

## Weights: the quantization math

A model's size is its parameter count times how many bits each parameter gets.
That's it.

| Format | Effective bpw | Notes |
|---|---|---|
| F16 / BF16 | 16.0 | the original |
| Q8_0 | 8.5 | visually lossless |
| Q6_K | 6.6 | near-lossless |
| Q5_K_M | 5.7 | very safe |
| **Q4_K_M** | **4.85** | **the default sweet spot** |
| Q4_0 | 4.5 | older, slightly worse than K-quants |
| Q3_K_M | 3.9 | acceptable on big models |
| Q2_K | 2.6 | noticeable damage |
| IQ2 / IQ1 | 1.6–2.2 | research curiosity |

```
weights_GB = params_in_billions × bpw / 8
```

Sanity checks against real GGUF files:

| Model | Quant | Formula | Real file |
|---|---|---|---|
| 4B | Q4_K_M | 4 × 4.85/8 = 2.43 GB | ~2.5 GB |
| 7B | Q4_K_M | 7 × 4.85/8 = 4.24 GB | ~4.4 GB |
| 12B | Q4_K_M | 12 × 4.85/8 = 7.28 GB | ~7.3 GB |
| 27B | Q4_K_M | 27 × 4.85/8 = 16.4 GB | ~16.5 GB |
| 70B | Q4_K_M | 70 × 4.85/8 = 42.4 GB | ~42.5 GB |

**Rule of thumb:** at Q4_K_M, `weights_GB ≈ params_B × 0.61`.

**Gotcha:** download size ≈ VRAM size, but not exactly. Ollama's reported size
includes tokenizer and metadata (a few hundred MB). Use it as a first estimate,
then verify by loading the model and reading the resident size.

---

## KV cache: the term that breaks most plans

The KV cache is a runtime buffer, not part of the model file — see
[01-what-is-a-model.md](01-what-is-a-model.md#the-kv-cache). What matters here is
its size.

### The formula

```
KV_bytes_per_token = 2 × n_layers × n_kv_heads × head_dim × bytes_per_element
```

- `2` — one for Keys, one for Values
- `n_kv_heads` — after GQA, usually *far* smaller than `n_layers`
- `bytes_per_element` — 2 for f16, ~1 for q8_0, ~0.56 for q4_0

### Worked example: a 4B model

Config: 36 layers, 8 KV heads, head_dim 128.

```
2 × 36 × 8 × 128 × 2 = 147,456 bytes = 144 KiB per token   (f16)
```

At an 81,920-token window:

```
144 KiB × 81,920 = 11.8 GiB at f16    ← would not fit before adding weights
144 KiB × 81,920 × 0.28 ≈ 3.3 GiB at q4_0
```

Weights (2.4 GB) + KV (3.3 GiB) ≈ **5.7 GiB**, which with overhead lands at the
~6.3 GiB actually observed on the reference machine. The formula holds.

**This is why KV quantization is not optional at long context on an 8 GB card.**
f16 KV makes 80k windows impossible regardless of model size. `q8_0` roughly
halves the cache; `q4_0` cuts it to about 28 % with little observable quality cost.

### Why KV is often bigger than the weights

At long context, KV grows linearly while weights stay fixed. The crossover for a
4B is around 60k tokens. Anything with a large fixed prompt — agentic tools with
big system prompts and tool definitions — pays this on *every request*:

> An agentic coding tool's baseline prompt can be ~35k tokens (system prompt plus
> tool schemas) before the user has typed anything. That is ~1.4 GiB of q4_0 KV
> on the 4B above, per request, plus whatever the conversation adds.

### GQA, and why some models are cheap

Most modern models use **Grouped Query Attention**: a batch of query heads shares
one KV head. The 4B above has 32 query heads and only 8 KV heads → the cache is
**4× smaller** than naive attention would need.

Two other cache tricks you'll see named:

- **Sliding-window attention** (Mistral, Gemma): only the last N tokens are kept
  for most layers, so KV stops growing past the window. Gemma mixes local
  (sliding) and global layers.
- **MLA / latent attention** (DeepSeek): compresses K and V into a small latent
  vector, cutting the cache by 5–10×. Also why DeepSeek models have outsized
  context for their size.

### Per-1k-token KV cost for common architectures (f16)

| Model shape | Layers × KV heads × head_dim | KV per 1k tokens |
|---|---|---|
| 4B, 8 KV heads | 36 × 8 × 128 | 144 MiB |
| 8B, 8 KV heads | 32 × 8 × 128 | 128 MiB |
| 12B, wide heads | 48 × 8 × 256 | **384 MiB** |
| 27B, 8 KV heads | 64 × 8 × 128 | 256 MiB |

Divide by ~2.6 for q8_0, by ~1.8 for q4_0 (measured ratios, not exactly linear).

---

## Overhead

You don't get to use every byte.

| Item | Size |
|---|---|
| CUDA context + driver | 200–400 MiB |
| Compute / activation buffers | 300–800 MiB |
| Display / desktop environment | 300–1200 MiB |
| Fragmentation | a few hundred MiB |

**Plan with 1 GB of slack.** If your calculation lands within 500 MB of the
limit, the model will not run at 100 % GPU — it'll spill a few layers and slow
down.

---

## Putting it together: the three tiers

"Fits" is not binary. There are three states, and you need to know which one
you're in before downloading 15 GB.

| State | Condition | Experience |
|---|---|---|
| **Full GPU** | total ≤ usable VRAM | everything is fine, ~70 % of bandwidth ceiling |
| **Partial offload** | weights ≤ VRAM, but +KV doesn't | some layers on CPU; 3–10× slower |
| **Thrash** | weights > VRAM | majority on CPU/mmap; sub-1 tok/s, unusable |

Runtimes report this — Ollama's `ollama ps` shows it as a `PROCESSOR` percentage
(`100% GPU`, `86% GPU`, `100% CPU`), llama.cpp logs `offloaded N/M layers`.
Anything below ~95 % GPU should be treated as a different, much worse machine.

### Decision procedure

```
1. weights  = params × quant_bpw / 8
2. if weights > usable_VRAM:        → reject (tier 3, or drop a quant)
3. kv       = 2 × L × KVH × D × bytes × ctx
4. total    = weights + kv + 1.0 GB
5. if total ≤ usable_VRAM:          → tier 1, good
   else                             → tier 2, expect pain
```

---

## Speed: why tok/s is a division problem

Decoding generates one token at a time, and each token requires reading the
entire active weight set from memory once. Nothing is cached between tokens. So:

```
tokens_per_second ≈ memory_bandwidth / bytes_read_per_token
```

The GPU's FLOPs are almost irrelevant here — it spends its time waiting on
memory. This is called being **bandwidth-bound**, and it is why an old
high-bandwidth GPU beats a new low-bandwidth one for LLMs.

### Predicted vs. measured

Reference machine: 272 GB/s theoretical, 50–70 % realised.

| Model | Weights | Ceiling | Realistic (60 %) | Observed |
|---|---|---|---|---|
| 4B Q4 | 2.4 GB | 113 tok/s | ~68 tok/s | 100 % GPU ✓ |
| 7B Q4 | 4.4 GB | 62 tok/s | ~37 tok/s | 100 % GPU ✓ |
| 12B Q4 | 7.3 GB | 37 tok/s | ~22 tok/s | spills at 8k |
| 12B Q3 | 5.8 GB | 47 tok/s | ~28 tok/s | ~86 % GPU |

The formula predicts placement as well as speed: anything whose weights alone
approach usable VRAM loses its context headroom and drops off full-GPU.

### With partial offload

Split the model across pools and add the times:

```
time_per_token ≈ GPU_bytes / GPU_bandwidth + RAM_bytes / RAM_bandwidth
```

A 7.3 GB model with 5 GB in VRAM and 2.3 GB in RAM (~45 GB/s):

```
5.0 / 272 + 2.3 / 45  =  0.018 + 0.051  =  0.069 s  →  ~15 tok/s
```

Now make it a 16.5 GB 27B with 7 GB in VRAM and 9.5 GB in RAM:

```
7.0 / 272 + 9.5 / 45  =  0.026 + 0.211  =  0.237 s  →  ~4 tok/s
```

That 4 tok/s number is the honest answer to "can I run a 27B?" on this class of
machine — and it ignores that the KV cache still has to fit somewhere too.

---

## Prefill vs. decode

Two different phases with two different bottlenecks:

| Phase | What happens | Bound by |
|---|---|---|
| **Prefill** | read the whole prompt, build KV cache | **compute** (FLOPs) |
| **Decode** | generate one token at a time | **memory bandwidth** |

Prefill FLOPs ≈ `2 × active_params × prompt_tokens`. For a 4B model and a
35k-token prompt that's ~280 TFLOPs — on a mid-range laptop GPU, roughly 20–40
seconds before the first token appears, *every request*.

This is why **prompt caching** matters so much for agentic work, and why small
models feel worse in an agentic loop than in a chat window: you pay a large
prefill on every turn because the system prompt and tool definitions are enormous.

It's also why the interesting number for local agents is not tokens/sec but
**prefill speed**, usually reported separately as `prompt eval rate`.

---

## Reverse-engineering any model (checklist)

Given an unfamiliar model, do this before pulling 20 GB:

1. **Parameter count.** From the name, the model card, or Ollama's tag size.
2. **Layers `L`, KV heads `KVH`, head dim `D`.** In HF `config.json` as
   `num_hidden_layers`, `num_key_value_heads`, `head_dim`. If `head_dim` is
   missing, it's `hidden_size / num_attention_heads`.
3. **Weights.** `params_B × 4.85 / 8` for Q4_K_M.
4. **KV.** `2 × L × KVH × D × bytes × ctx`, with `bytes = 0.56` for q4_0 KV.
5. **Total.** Weights + KV + 1 GB. Compare to **usable VRAM**.
6. **Speed.** `bandwidth / weights_GB`, then halve it.

If step 5 fails, the model does not fit. Trying a lower quant is legitimate only
down to about Q3_K_M; below that you lose more quality than the extra size buys.

If you can't get the config, the empirical shortcut is:

```bash
ollama pull <tag> && ollama run <tag> --verbose
```

Then read the reported size, offload percentage, and eval rates. It costs the
download, but it answers every question at once.

### Worked examples

**A 12B model with wide heads (48 layers × 8 KV heads × 256 head_dim)**

```
weights Q4_K_M  = 12 × 4.85/8  = 7.3 GB   → over an 8 GB budget before KV
weights Q3_K_M  = 12 × 3.9/8   = 5.8 GB
KV  @ 8k, q4_0  = 2 × 48 × 8 × 256 × 0.56 × 8192 ≈ 0.9 GB
total           = 5.8 + 0.9 + 1.0 = 7.7 GB  → tier 2, ~86 % GPU
```

Verdict: runs only at Q3, with no headroom, and an 8k window that cannot hold a
35k baseline prompt. Not a quality tradeoff — an arithmetically impossible
configuration for agentic work.

**A 27B dense model**

```
weights even at Q2_K = 27 × 2.6/8  = 8.8 GB   → exceeds an 8 GB card on its own
KV  @ 34.7k, q4_0    = 2 × 64 × 8 × 128 × 0.56 × 34700 ≈ 5.7 GB
total                = 8.8 + 5.7 + 1.0 = 15.5 GB
```

Verdict: needs ~16 GB. Not "slow" — outside the machine.

---

## What you need for what

Map of use case → model class → hardware. VRAM figures assume Q4_K_M, f16 KV,
and a context window large enough to be useful.

| Use case | Model size | Weights | VRAM needed | On 8 GB |
|---|---|---|---|---|
| Autocomplete / inline edit | 1–2B | 0.6–1.2 GB | 3 GB | ✓ easy |
| Fast chat, summarization | 4B | 2.4 GB | 5 GB | ✓ |
| General assistant | 7–8B | 4.3–4.9 GB | 7–8 GB | ✓ tight |
| Coding assistant, short ctx | 7–8B | 4.3–4.9 GB | 8 GB | ✓ tight |
| Agentic coding, long ctx | 4B @ 80k | 2.4 GB | 8 GB | ✓ exactly this |
| Agentic coding, better quality | 12B | 7.3 GB | 14 GB | ✗ |
| Local reasoning / research | 14–32B | 8.5–19.4 GB | 16–24 GB | ✗ |
| Local frontier | 70B | 42.5 GB | 48 GB+ | ✗ |

### What each tier of hardware unlocks

| VRAM | Bandwidth | Highest comfortable local model |
|---|---|---|
| 8 GB | ~270 GB/s | 7–8B at Q4, 4B at long context |
| 12 GB | ~360 GB/s | 12B at Q4, 8B at 32k |
| 16 GB | ~450 GB/s | 14B at Q4, 12B at 32k |
| 24 GB | ~1000 GB/s | 32B at Q4, 27B at Q5 |
| 48 GB | ~1300 GB/s | 70B at Q4 |

Note the jump at 24 GB: that's where the high-bandwidth memory variants live, and
the bandwidth jump matters as much as the capacity.

---

## Quant quality: where to spend and where not

Sizes scale linearly with bpw; quality does not. Rough loss relative to F16:

| Quant | Size vs F16 | Quality loss | Use when |
|---|---|---|---|
| Q8_0 | 53 % | ~none perceivable | you have room to spare |
| Q6_K | 41 % | negligible | small models where quality matters |
| Q5_K_M | 36 % | very small | safe default if it fits |
| **Q4_K_M** | **30 %** | **small, well-understood** | **default** |
| Q3_K_M | 24 % | noticeable on small models | big models, tight VRAM |
| Q2_K | 16 % | significant | last resort |
| IQ2/IQ1 | 10–14 % | severe | novelty |

Two things that override the table:

1. **Small models degrade faster.** A 4B at Q3 is much worse than a 27B at Q3.
   Big models have redundancy to lose; small ones don't. Never go below Q4_K_M
   for anything under ~8B.
2. **Fine-tunes degrade faster than base models.** An abliterated / roleplay /
   domain fine-tune has already moved the weights off the well-studied
   distribution. Squeeze it further and the damage compounds — and for
   *tool-calling*, which is a precise structured-output skill, this shows up as
   malformed calls long before it shows up in chat.

That second point matters when comparing candidates: a decensored derivative
squeezed to Q3 is a bad bet against a clean base model at Q4, on any task that
rewards exactness.

---

## The agentic-coding constraint

Local models are usually evaluated in chat, where a 4k context is plenty. Agentic
coding inverts the priorities:

| Requirement | Consequence |
|---|---|
| Very large baseline prompt (~35k tokens) | context window must be ≥ ~80k for working room |
| 80k context on 8 GB VRAM | KV must be quantized — f16 doesn't fit |
| Large prompt every request | prefill dominates latency; prompt caching is essential |
| Tool calls must be exact | small models fail here first |

The window requirement is what eliminates most candidates. A 12B at Q4 leaves
under 1 GB for KV — roughly 2k tokens of context after the baseline prompt. It is
not a quality tradeoff, it's an arithmetically impossible configuration.

This is why long-context local agentic use on an 8 GB card lands on a 4B at ~80k
rather than a bigger model at a small window.

---

## Cheat sheet

```
weights_GB (Q4_K_M)  = params_B × 0.61
weights_GB (Q3_K_M)  = params_B × 0.49
weights_GB (Q2_K)    = params_B × 0.33

kv_GiB/token (f16)   = 2 × layers × kv_heads × head_dim × 2 / 2^30
kv_GiB (q4_0)        ≈ f16 / 1.8
kv_GiB (q8_0)        ≈ f16 / 2.6

vram_needed_GiB      = weights_GB + kv_GiB + 1.0

tok/s_ceiling        = bandwidth_GB/s / weights_GB
tok/s_realistic      ≈ 0.6 × ceiling
```

| Params | Q4_K_M weights | Usable context on an 8 GB card? |
|---|---|---|
| 1B | 0.6 GB | yes, very long |
| 4B | 2.4 GB | yes, 80k with q4_0 KV |
| 7–8B | 4.3–4.9 GB | yes, 32k |
| 12B | 7.3 GB | no — weights alone |
| 27B | 16.4 GB | no |
| 32B | 19.4 GB | no |

---

Next: [How to run it](03-running.md).
