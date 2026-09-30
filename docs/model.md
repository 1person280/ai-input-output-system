# Local model

## What we run

| | |
| --- | --- |
| Model | Qwen3-4B-Instruct |
| Quantization | **Q8_0** (INT8) |
| Context window | **65,536 tokens** |
| File name | `Qwen3-4B-Instruct-Q8_0.gguf` (~4.5 GB, placeholder figure) |
| Runtime | [llama.cpp](https://github.com/ggerganov/llama.cpp) `llama-server` |

## Where the file lives

`ModelManager.resolveModelPath()` uses, in order:

1. `aiio.localModelPath` when it is a non-empty string, resolved to an absolute path;
2. otherwise `<workspaceRoot>/models/Qwen3-4B-Instruct-Q8_0.gguf`.

## Downloading the weights

The repository ships **only the script** — no weights are downloaded, committed
or bundled. The default URL in `scripts/download-model.mjs` is a placeholder
(`https://huggingface.co/<org>/<repo>/...`); point it at a mirror you trust:

```bash
node scripts/download-model.mjs --url https://<mirror>/Qwen3-4B-Instruct-Q8_0.gguf \
                                --sha256 <expected-hex-digest>
```

Behaviour:

- streams the response with the built-in `fetch` (no extra dependency);
- writes to `<out>.part` and only renames it on success;
- computes SHA-256 while streaming; pass `--sha256 skip` to only print it;
- refuses to run while the URL still contains the `<org>` placeholder.

Run `node scripts/download-model.mjs --help` for all flags.

## Starting the server

The extension can do it for you via **AI I/O: Manage Local Model**, or manually:

```bash
llama-server -m models/Qwen3-4B-Instruct-Q8_0.gguf \
             --host 127.0.0.1 --port 8080 \
             --ctx-size 65536 -ngl 99
```

`--ctx-size 65536` matches `DEFAULT_MODEL.contextTokens` and the classifier's
context-pressure term; `-ngl 99` offloads every layer to the GPU (drop it or
lower it for CPU-only machines).

The extension probes `GET /health` on `aiio.localServerUrl` at startup. When the
server is unreachable, locally-routed prompts transparently fall back to the
cloud rather than failing.

## Endpoints used

| Endpoint | When |
| --- | --- |
| `POST /v1/chat/completions` | Default; OpenAI-compatible. |
| `POST /completion` | Legacy fallback (`LocalEndpoint = 'completion'`). |
| `GET /health` | Availability probe. |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Model not found at …` | Download the GGUF or set `aiio.localModelPath`. |
| `Failed to launch "llama-server"` | Install llama.cpp and put `llama-server` on `PATH`. |
| Everything routes to the cloud | Check `aiio.enableLocalRouting` and `aiio.routingThreshold`. |
| Slow first token | The model is being paged in; keep the server warm. |