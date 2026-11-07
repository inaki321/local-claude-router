# Inference, Explained

Five short documents about running local LLMs: what a model actually is, how its
memory works, whether it fits on your machine, how to run it, and how to wire it
into a router.

They're written to be read in order, but each stands alone.

| # | File | Answers |
|---|---|---|
| 1 | [What is a model?](01-what-is-a-model.md) | What's inside the file, what the numbers mean, what it can and can't do |
| 1b | [The KV cache](01b-the-kv-cache.md) | What the cache is, why it isn't trained, and what a small vs. large window costs |
| 2 | [Will it fit?](02-sizing.md) | The memory and speed arithmetic |
| 3 | [How to run it](03-running.md) | Server flags, pulling, verifying, troubleshooting |
| 4 | [Wiring it into LiteLLM](04-litellm-config.md) | What each config knob does and when to set it |

## The whole thing in five lines

```
weights   = params × bits_per_weight / 8
KV cache  = 2 × layers × kv_heads × head_dim × bytes × tokens
VRAM      = weights + KV cache + ~1 GB overhead
tok/s     ≈ memory_bandwidth / weights
fits?     ← compare VRAM against *usable* VRAM, not the spec sheet
```

Everything in these documents is elaboration on those five lines.

## Glossary

- **bpw** — bits per weight. The compression rate of a quantization format.
- **Chat template** — the Jinja text format (shipped in the model file) that
  wraps turns, and defines tool-call syntax if the model supports it. No tools
  branch = no native tool calling.
- **Decode** — the bandwidth-bound loop that generates one token at a time.
- **GGUF** — the file format llama.cpp (and therefore Ollama) loads. Carries
  weights + metadata + tokenizer + chat template in one file.
- **GQA** — Grouped Query Attention. Multiple query heads share one KV head,
  shrinking the KV cache several-fold. Ask about this first when a model claims
  a huge context window.
- **KV cache** — stored keys and values for every processed token, needed so the
  next token can attend to the past. Computed at runtime; not part of the model
  file. Grows linearly with context.
- **MoE** — Mixture of Experts. Sparse activation; saves compute, not memory.
- **Offload** — moving some layers from GPU to CPU. Shown as a percentage.
- **Prefill** — the compute-bound pass over the input that builds the KV cache
  and produces the first token.
- **Quantization** — storing weights in fewer bits. Trades size (and a little
  quality) for speed and fit.
- **Thrash** — model partly in swap/mmap; every token faults from disk. Order of
  magnitude slower than a proper offload.
- **Usable VRAM** — total VRAM minus driver, display, and compute buffers. Always
  less than the spec sheet says.
