# `training/` — Drone Camp Planner fine-tune workspace

Companion training pipeline for the AidFlow Pro **Drone Camp Planner** feature.
This folder is **not** part of the deployed app — it lives alongside it so
the fine-tuned LoRA adapter that eventually lands in Ollama has a documented,
reproducible path.

> **Status:** Phase 1 — proof-of-concept. Synthetic data only, tents-only,
> ~50–200 training pairs, single Kaggle training run. Goal is to validate
> the end-to-end pipeline, *not* to beat the base model yet.

## Phase plan

| Phase | Goal | Dataset | Compute | Time |
|---|---|---|---|---|
| **1 — PoC** *(this folder)* | Validate the whole pipeline end-to-end | 50–200 synthetic pairs from OSM footprints + Esri imagery, tents only | Kaggle free notebooks (T4×2 or P100) | 1–2 weekends |
| **2 — v1.0** | Measurable accuracy lift over the base model | 500–2000 pairs from HOTOSM camp mappings + real drone imagery, all 7 feature types | Kaggle Pro or rented A100 | 2–3 weeks |
| **3 — Production** | Ship as an Ollama-pullable model | Curated, evaluated, donor-auditable dataset | Same as Phase 2 | TBD |

## Layout

```
training/
├── README.md                ← this file
├── PLAN.md                  ← detailed architectural plan + risks
├── requirements.txt         ← Python deps (CPU-side data prep)
├── data_synth/
│   ├── README.md            ← data-generation workflow
│   ├── sources.py           ← catalogue of camp areas + footprint sources
│   ├── generate.py          ← main generator: imagery + footprints → pairs
│   └── (outputs to ./dataset/)
├── notebooks/
│   └── phase1_finetune.py   ← Kaggle-runnable training script (paste into cells)
├── deploy/
│   ├── README.md            ← deploy workflow
│   └── convert_and_deploy.py← merged HF → GGUF → Ollama, one command
└── eval/
    └── compare.py           ← base-model vs LoRA quality comparison
```

## Quickstart — Phase 1

```powershell
# 1. Install local Python deps (CPU-only — no PyTorch needed here)
cd training
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# 2. Smoke-test on a single small area first
python data_synth\generate.py --n 20 --areas zaatari --out .\dataset_smoke

# 3. Generate the Phase 1 dataset (~100 patches across 8 camps)
python data_synth\generate.py --n 100 --out .\dataset

# 4. Upload ./dataset/ as a Kaggle Dataset (zip + UI upload, or kaggle CLI)
#    See data_synth/README.md for the full workflow.

# 5. Open notebooks/phase1_finetune.py on Kaggle as a notebook, attach
#    your Dataset, and run all cells.

# 6. Download the merged_hf/ directory the notebook produced (CELL 10),
#    then run the one-command deploy locally:
python deploy\convert_and_deploy.py --merged path\to\merged_hf

# 7. A/B against the base model:
python eval\compare.py --base gemma4:e4b --lora aidflow-camp:e4b-lora-v01
```

## Privacy + license posture

- **No proprietary imagery.** Only sources with explicit open licenses
  (Esri World Imagery non-commercial, Microsoft Building Footprints ODbL,
  OpenAerialMap CC-BY for Phase 2, OSM ODbL).
- **No personal data.** Footprints and aerial tiles only — no family
  rosters, no GPS pins of individuals.
- **MIT license** for any code in this folder. Adapters published to
  Hugging Face will note their training-data licenses inline.

## What this is *not*

- Not a research-quality pipeline. Treat numbers from Phase 1 as
  smoke-test signal, not benchmarks.
- Not a replacement for the Edit mode in the app. Even a great fine-tune
  will get aerial-image features wrong sometimes; Edit mode stays in
  v1.0 as the principled correction path.
