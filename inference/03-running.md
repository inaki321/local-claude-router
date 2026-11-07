# How to Run It

Sizing says whether a model *can* run. This covers actually running it: server
flags, pulling, verifying, and diagnosing when it's slower than predicted.

Assumes [02-sizing.md](02-sizing.md) for the numbers.

---

## Start the server

Ollama's defaults are chosen for a desktop chat app, not for agentic work. The
environment variables below are not optional if you want long-context sessions.

```bash
OLLAMA_FLASH_ATTENTION=1 \
OLLAMA_KV_CACHE_TYPE=q4_0 \
OLLAMA_CONTEXT_LENGTH=81920 \
ollama serve
```

| Variable | Why |
|---|---|
| `OLLAMA_FLASH_ATTENTION=1` | faster, and required for KV quantization in most builds |
| `OLLAMA_KV_CACHE_TYPE=q4_0` | cuts the cache to ~28 % of f16 — the only way long context fits |
| `OLLAMA_CONTEXT_LENGTH=81920` | without it, Ollama picks a small default (often 4096) from available VRAM and silently truncates your prompt |

That last one is the most common cause of "the model ignores my instructions": the
prompt was cut off. Always check the reported context with `ollama ps`.

The server listens on `http://127.0.0.1:11434`.

### Server default vs per-request

```
OLLAMA_CONTEXT_LENGTH   → global default for every model
num_ctx (per request)   → overrides it for one call
```

Per-request wins. That's how different models can use different windows on the
same server — see [04-litellm-config.md](04-litellm-config.md).

---

## Pull models

```bash
ollama pull <tag>
ollama list                  # confirm size on disk
```

Pull sizes are your first check on the weight math: if the download is bigger
than your VRAM, you already know it won't be fully on the GPU.

---

## Verify the placement

This is the command that matters most:

```bash
ollama ps
```

```
NAME                ID    SIZE     PROCESSOR    CONTEXT
some-model:tag      ...   6.3 GB   100% GPU     81920
```

| Column | What it tells you |
|---|---|
| **SIZE** | total resident: weights + KV + buffers. Your `VRAM needed`, measured |
| **PROCESSOR** | offload percentage. 100 % GPU or it's a different machine |
| **CONTEXT** | the window actually in use — if this is lower than you set, your setting didn't apply |

Anything below ~95 % GPU is a partial offload. Expect 3–10× slower generation and
a much worse experience, regardless of what the model is.

### Measure throughput

```bash
ollama run <tag> --verbose
```

Reports two rates that matter for different reasons:

- **`eval rate`** — decode tok/s. Should be near `bandwidth / weights`.
- **`prompt eval rate`** — prefill tok/s. Dominates latency in agentic loops,
  where every request carries a large system prompt.

---

## Watch it load

```bash
watch -n 0.5 nvidia-smi
```

A clean load climbs to a plateau. A partial offload shows VRAM pinned at the
ceiling while load time drags on — the model is being split layer by layer.

---

## Diagnosing a mis-size

| Symptom | Cause |
|---|---|
| `PROCESSOR` under 95 % GPU | weights + KV exceeded VRAM |
| First token takes >1 min | prefill is huge, or layers on CPU |
| Speed degrades over a session | KV cache growing, crossing the ceiling |
| `SIGKILL` / OOM | system RAM exhausted during load |
| Disk active during generation | mmap thrashing — worst case |
| Context lower than configured | runtime capped it to fit VRAM, or the setting didn't apply |
| Model ignores instructions | prompt was truncated to a smaller window |

---

## Tuning levers, in order of impact

1. **Lower `num_ctx`** — the KV cache is usually the largest avoidable cost.
2. **Quantize the KV cache** (`q8_0`, then `q4_0`) — often free quality-wise,
   large memory win.
3. **Drop a weight quant** (`Q4_K_M` → `Q3_K_M`) — visible quality cost, use last.
4. **Pick a smaller model** — usually better than a crushed bigger one.

Do them in that order. People tend to reach for #3 first because it's the obvious
number, and it's the worst trade.

---

## Laptop and WSL notes

- **WSL2 gets a slice of host RAM, not all of it.** Check `free -h`; if it's half
  what you expected, raise `memory=` in `.wslconfig` and restart WSL.
- **The GPU is shared with the Windows desktop.** A browser can eat 1 GB of VRAM.
  Measure with the desktop idle if you want comparable numbers.
- **`nvidia-smi` inside WSL reports host VRAM.** That's correct — the card is
  passed through, memory is not split.
- **Native Windows Ollama avoids WSLg overhead** but has the same RAM ceiling.

---

## Running as a service

```bash
systemctl --user enable --now ollama
```

If you use a unit file, put the environment variables in it — a service started
without them gets the small default context, and every long prompt silently
truncates. Verify afterwards with `ollama ps` that `CONTEXT` is what you expect.

Keep exactly one server running. Two `ollama serve` processes competing for VRAM
is a common and confusing failure.

---

## Client-side: tell the client the real window

The server's window and the client's assumption must match. Most clients assume a
large default (200k) for unknown model IDs, then never compact before the request
overflows a server configured for 80k.

The failure looks like: conversation grows, then requests start erroring or
truncating, with nothing obviously wrong in the logs.

So whenever you lower `num_ctx`, lower the client's assumption too.

---

Next: [Wiring it into LiteLLM](04-litellm-config.md).
