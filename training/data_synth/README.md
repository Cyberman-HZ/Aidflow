# `data_synth/` — synthetic dataset generation

Generates labeled `(image, JSON)` training pairs by pairing **open building
footprints** (refugee-camp shelters mapped by humanitarian volunteers)
with **open aerial / satellite imagery** at the same geography. No
hand-labeling.

## How it works

1. `sources.py` defines a registry of well-mapped refugee/IDP camp areas
   (Cox's Bazar, Kakuma, Bidi Bidi, Dadaab, Zaatari, etc.) with their
   bounding boxes.
2. `generate.py` for each area:
   - Pulls building footprints from the **Overpass API** (OSM live).
   - Pulls a matching aerial tile from **Esri World Imagery** (free, no
     API key, high-resolution global mosaic).
   - Tiles the imagery into 512×512 patches.
   - Projects each footprint's centroid into each patch's normalized
     `(x, y) ∈ [0,1]²` space.
   - Emits one `(image.jpg, label.json)` pair per patch with at least
     `MIN_TENTS_PER_PATCH` tents inside.
3. The output directory is a Kaggle-uploadable dataset.

## Running it

```powershell
# From training/
python data_synth/generate.py --n 100 --out ./dataset

# Options
python data_synth/generate.py `
  --n 100                  ` # target number of patches
  --out ./dataset          ` # output directory
  --min-tents 5            ` # skip patches with fewer than this many tents
  --max-tents 200          ` # skip patches with more (matches schema cap)
  --patch-px 512           ` # patch side in pixels
  --zoom 18                ` # web-mercator zoom level (18 ≈ 0.6 m/px)
  --areas cox_bazar,kakuma ` # subset of areas; omit for all
```

## Output format

```
dataset/
├── metadata.json              # summary: counts per area, version, seed
├── images/
│   ├── cox_bazar_z18_x12345_y67890.jpg
│   └── ...
└── labels/
    ├── cox_bazar_z18_x12345_y67890.json
    └── ...
```

Each label JSON matches `src/services/campMap.ts` SYSTEM_PROMPT exactly:

```json
{
  "features": [
    {"type": "tent", "x": 0.18, "y": 0.22, "confidence": "high"},
    {"type": "tent", "x": 0.27, "y": 0.31, "confidence": "high"}
  ],
  "notes": ["Auto-generated from OSM building footprints over Esri World Imagery."]
}
```

Confidence is always `"high"` for synthetic data — the footprint is
ground truth by construction.

## Uploading to Kaggle

```powershell
# Option A — UI: zip up dataset/ and use kaggle.com/datasets → New Dataset
# Option B — CLI (one-time setup with `pip install kaggle` + API token):
kaggle datasets init -p ./dataset
# Edit ./dataset/dataset-metadata.json to set a slug (e.g. aidflow-camp-phase1)
kaggle datasets create -p ./dataset
```

## Sources + licenses

| Source | What we use | License |
|---|---|---|
| OpenStreetMap (Overpass) | Building footprints in mapped camp areas | ODbL — attribute "© OpenStreetMap contributors" |
| Esri World Imagery | Aerial / satellite raster tiles | Free for non-commercial training; attribute Esri + content providers |

For Phase 1 we **only** use OSM + Esri. No API keys, no rate limits
beyond polite throttling.

## Caveats

- Esri tiles change over time; the same `(z, x, y)` tile may show a
  different image six months later. We snapshot tiles into the dataset
  so the trained model sees a fixed view.
- OSM footprints are crowdsourced — accuracy varies wildly by area.
  Cox's Bazar is well-mapped; smaller camps may have only partial
  coverage. The generator skips patches with too few footprints.
- This is **satellite imagery, not drone imagery**. The trained adapter
  will be biased toward overhead 90° views. Phase 2 swaps to
  OpenAerialMap drone scenes for distribution-shift robustness.
