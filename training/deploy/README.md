# `deploy/` — LoRA → GGUF → Ollama

Local-side automation that takes the merged HF model directory you
downloaded from Kaggle and turns it into a Modelfile-registered Ollama
model that AidFlow Pro can use as a drop-in replacement for
`gemma4:e4b`.

## Prerequisites

- Python 3.10+ on `PATH`
- `git` on `PATH` (for cloning llama.cpp on first run)
- `ollama` on `PATH` (https://ollama.com/download)
- The merged HF model from Kaggle (the `merged_hf/` directory that
  CELL 10 of `notebooks/phase1_finetune.py` produces — NOT the
  `adapter/` directory)

## Usage

```powershell
# From training/
python deploy\convert_and_deploy.py `
  --merged C:\downloads\merged_hf `
  --name aidflow-camp `
  --tag e4b-lora-v01
```

What this does, in order:

1. Clones llama.cpp into `deploy/.llamacpp/` (shallow, ~50 MB; cached
   for re-runs).
2. Pip-installs the small set of packages `convert_hf_to_gguf.py`
   needs (`numpy`, `torch`, `transformers`, `sentencepiece`,
   `protobuf`, `safetensors`, `gguf`).
3. Converts your merged HF model to GGUF — `deploy/out/aidflow-camp-e4b-lora-v01.gguf`.
4. Writes a Modelfile at `deploy/out/Modelfile.e4b-lora-v01` that
   embeds the same SYSTEM_PROMPT the app uses.
5. Runs `ollama create aidflow-camp:e4b-lora-v01 -f <Modelfile>`.

After it finishes, the new model shows up in `ollama list` and is
ready to use.

## Switching AidFlow Pro to the fine-tuned model

Edit `src/services/ollama.ts` (or wherever the model name constant
lives) and change `'gemma4:e4b'` to `'aidflow-camp:e4b-lora-v01'`.
Restart the dev server. The Drone Camp Planner will route to your
fine-tuned model on the next upload.

A/B against the base model with the eval harness:

```powershell
python eval\compare.py --base gemma4:e4b --lora aidflow-camp:e4b-lora-v01
```

## Useful flags

| Flag | Default | Purpose |
|---|---|---|
| `--merged` | (required) | Path to the merged_hf/ directory from Kaggle. |
| `--name` | `aidflow-camp` | Ollama model name. |
| `--tag` | `e4b-lora-v01` | Bump this for each new training run (v02, v03, …). |
| `--quant` | `auto` | HF→GGUF output dtype. `auto`, `f16`, `bf16`, `f32`. |
| `--llamacpp-dir` | `deploy/.llamacpp/` | Reuse an existing llama.cpp clone if you have one. |
| `--out-dir` | `deploy/out/` | Where the GGUF + Modelfile land. |
| `--skip-deps` | off | Skip pip-install (if you've already done it). |
| `--skip-ollama-create` | off | Stop after writing the Modelfile — useful for inspection. |

## Smaller GGUFs (manual quantization)

`convert_hf_to_gguf.py` produces an unquantized model. Ollama can
ingest it directly and quantize internally if needed, but for a
smaller on-disk footprint you can run llama.cpp's `quantize` binary
against the unquantized GGUF:

```powershell
# Once you've built llama.cpp's C++ binaries (see llama.cpp README)
.\deploy\.llamacpp\build\bin\Release\quantize.exe `
  .\deploy\out\aidflow-camp-e4b-lora-v01.gguf `
  .\deploy\out\aidflow-camp-e4b-lora-v01.Q4_K_M.gguf `
  Q4_K_M
```

Then point the Modelfile at the quantized file and re-run
`ollama create`.

## Troubleshooting

- **`convert_hf_to_gguf.py` errors on Gemma vision**: llama.cpp's
  multimodal support has evolved. If conversion fails, check the
  llama.cpp issue tracker for `gemma` + `vision` and pin to a
  release that supports the architecture you trained on.
- **Ollama complains about unsupported model architecture**:
  same root cause — Ollama tracks llama.cpp releases. Make sure
  you're on a recent Ollama (`ollama --version` ≥ 0.5).
- **Adapter directive instead of merged**: if you have a small
  `adapter.gguf` and Ollama's `ADAPTER` directive works for your
  base model, you can skip the merge entirely. The merge path is
  the more reliable default; the adapter path is left as a manual
  exercise for now.
