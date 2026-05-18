# Drone Camp Planner fine-tune — architectural plan

## Why fine-tune

The Drone Camp Planner ships as Beta because Gemma 4 E4B (~8 B) has a real
ceiling on small-object localization in aerial imagery. A 1600 px drone
shot of a dense camp gives the model ~10–30 pixels per tent — at the edge
of what a general-purpose VLM can reliably count and place. Two failure
modes:

1. **Visual perception**: missing tents that are visible, hallucinating
   tents where there are only shadows, double-counting one physical tent.
2. **Schema discipline**: returning malformed JSON, miscalibrated
   confidence, inventing coordinate conventions.

Fine-tuning helps #2 robustly and #1 modestly — the vision encoder stays
mostly frozen; we're really training the projection + LLM head to read
top-down camp imagery and adhere to our schema.

## The bet

> If we feed Gemma a few thousand image/JSON pairs where the JSON is
> *exactly* the schema we want, with calibrated confidences and no
> duplicates, the model learns the contract robustly enough that the
> Edit-mode safety net becomes optional rather than mandatory for v1.0.

## Approach

### Synthetic data from OSM building footprints + open aerial imagery

We don't have a labeled dataset, and labeling 2000 drone images by hand
is the bottleneck. Instead, we **generate** labeled pairs from two
sources of open data that align well:

- **OpenStreetMap building footprints** — humanitarian volunteers have
  mapped the rooftops of dozens of refugee camps (Cox's Bazar, Kakuma,
  Bidi Bidi, Dadaab, Zaatari, etc.). For "temporary shelter" camps
  these footprints *are* the tents.
- **Esri World Imagery** — free, no-API-key global aerial / satellite
  mosaic at zoom levels up to 19 (~0.3 m/px). High enough resolution
  to see individual tents.

For each camp area in our source registry:

1. Pull the building footprints (Overpass API → GeoJSON).
2. Pull a matching aerial tile at the same lat/lon (Esri REST API).
3. Tile the imagery into 512×512 patches.
4. For each patch, compute the normalized 0..1 centroid of every
   footprint that falls inside it. These become the
   `features: [{type:'tent', ...}]` array.
5. Emit `(image.jpg, label.json)` pairs.

Result: thousands of training pairs, zero hand-labeling.

### Tents only (Phase 1)

Other feature types (water_point, latrine, building, vehicle,
open_area, path) are deferred to Phase 2. Rationale:

- 90% of the Sphere math + population estimate depends on tent count.
- Building footprints from OSM are an excellent proxy for tent
  positions.
- Mapping `building → tent` is a one-line transformation; other classes
  would need separate data sources and tags.

### Unsloth QLoRA on Kaggle

- **Base model**: a Gemma vision variant (Gemma 3 4B or Gemma 4 E4B,
  whichever Unsloth supports at training time).
- **Adapter**: LoRA rank 16, dropout 0.05, targeting the language
  modelling head + projection layers. Vision encoder frozen.
- **Format**: chat template with one image per example, system prompt
  identical to `src/services/campMap.ts` SYSTEM_PROMPT, assistant turn
  is the JSON.
- **Training**: 2–3 epochs, batch size 1, gradient accumulation 4,
  cosine LR schedule.
- **Output**: a small LoRA file (~50–200 MB), exportable to GGUF via
  llama.cpp for Ollama.

### Deployment back to AidFlow Pro

1. Convert LoRA → GGUF via `llama.cpp` (`convert_lora_to_gguf.py`).
2. Merge into the base GGUF or serve as adapter overlay (Ollama 0.5+
   supports adapter loading via Modelfile `ADAPTER` directive).
3. Create a Modelfile naming the fine-tuned model
   `aidflow-camp:e4b-lora-v01`.
4. Switch the model name in AidFlow's `src/services/ollama.ts` config
   from `gemma4:e4b` to the fine-tuned variant — no code changes
   elsewhere.

## Phase 1 scope (this folder, this weekend)

- [ ] 8 seed camp areas in `sources.py` (Cox's Bazar, Kakuma, Bidi Bidi,
      Dadaab, Zaatari, Azraq, Nyarugusu, Palabek).
- [ ] Pull building footprints + imagery for each area.
- [ ] Generate 100–200 image/JSON pairs as a Kaggle Dataset.
- [ ] Run a tiny LoRA fine-tune on Kaggle (2 epochs, ~30 min on T4×2).
- [ ] Compare outputs of base vs LoRA on 5–10 held-out images.

**Success criteria for Phase 1** (deliberately loose):
- Pipeline runs end-to-end with no manual intervention beyond uploading
  the dataset to Kaggle.
- The LoRA adapter loads and the model produces valid JSON in our schema.
- Qualitative inspection on held-out images shows *some* sign of
  schema-discipline improvement (cleaner JSON, fewer duplicates).

Phase 1 will *not* measurably beat the base model on coordinate
accuracy — synthetic data from satellite tiles is the wrong distribution
for drone imagery, and 100 pairs is too few. That's fine. Phase 1 is
plumbing.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Satellite imagery is **not the same distribution** as drone imagery (resolution, angle, lighting). | Phase 1 accepts this; Phase 2 swaps to real drone imagery from OpenAerialMap. |
| Building footprints **miss many actual tents** (rapid camp growth outpaces mapping). | Acceptable for training a "find what's there" model; we're not measuring recall against ground truth in Phase 1. |
| Unsloth's Gemma-vision support **changes between releases**. | Pin a specific Unsloth commit in the notebook; document the version. |
| Kaggle free GPU **disconnects mid-run**. | Save checkpoint every epoch; resume-from-checkpoint logic in the notebook. |
| Fine-tuned model **overfits to satellite-tile artifacts**. | Add weight decay 0.01, low LoRA rank (16); small dataset is actually a feature here (less overfit surface). |
| Gemma 4 may not be in Unsloth at training time. | Notebook supports both Gemma 3 4B (vision) and Gemma 4 E4B; swap models if needed. |
