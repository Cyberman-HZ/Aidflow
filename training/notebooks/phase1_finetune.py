"""Phase 1 — Drone Camp Planner LoRA fine-tune on Kaggle.

This file is structured as Kaggle-notebook cells. Each `# ==== CELL N ====`
marker is where you create a new notebook cell. Don't run it as a single
Python script — Kaggle's GPU memory will appreciate the cell-by-cell flow,
and it's much easier to inspect intermediate state.

PREREQUISITES on Kaggle
-----------------------
1. Settings → Accelerator → "GPU T4 x2" (or P100, or whatever's free).
2. Settings → Internet → "ON" (needed for the first-run model + Unsloth pull).
3. Add Data → upload the `dataset/` folder produced by data_synth/generate.py
   as a private Kaggle Dataset; attach it to this notebook. The default
   `INPUT_DIR` below assumes the attached dataset slug is `aidflow-camp-phase1`.
4. Output: leave default. The LoRA adapter + tokenizer will land in
   `/kaggle/working/lora_out/` so you can download it after the run.
"""

# ============================================================
# ==== CELL 1: install Unsloth + the right Transformers ======
# ============================================================
# Unsloth pins a specific Transformers + torch matrix; trust their installer.
# This is ~3-5 minutes on first install.

# !pip install --no-deps "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"
# !pip install --no-deps "xformers<0.0.27" trl peft accelerate bitsandbytes datasets pillow

# In a notebook these would be magic-! shell calls. Uncomment when you paste them in.


# ============================================================
# ==== CELL 2: imports + paths ===============================
# ============================================================
import json
import random
from pathlib import Path

import torch
from PIL import Image
from datasets import Dataset

# Unsloth import — patches Transformers under the hood, must come first.
from unsloth import FastVisionModel, is_bf16_supported  # noqa: E402

# --- Paths you may want to change -----------------------------------------

# Where Kaggle mounts your attached Dataset. Change `aidflow-camp-phase1`
# to whatever slug your uploaded Dataset has.
INPUT_DIR = Path("/kaggle/input/aidflow-camp-phase1")
OUTPUT_DIR = Path("/kaggle/working/lora_out")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# --- Hyperparameters ------------------------------------------------------

# Base model. Swap to "unsloth/gemma-3-12b-it" for the 12B variant if you
# upgrade to Kaggle Pro. "gemma-3-4b-it" fits comfortably on a single T4.
BASE_MODEL = "unsloth/gemma-3-4b-it"

MAX_SEQ_LENGTH = 2048   # plenty for image + ~50 tents of JSON
LORA_R = 16             # adapter rank
LORA_ALPHA = 16
LORA_DROPOUT = 0.05
LEARNING_RATE = 2e-4
WEIGHT_DECAY = 0.01
NUM_EPOCHS = 2
BATCH_SIZE = 1
GRAD_ACCUM = 4
SEED = 42

# Reproducibility
random.seed(SEED)
torch.manual_seed(SEED)


# ============================================================
# ==== CELL 3: load the base vision model in 4-bit ==========
# ============================================================
# Unsloth's FastVisionModel patches the model in-place so training is
# 2-5x faster than vanilla HF on the same hardware.

model, tokenizer = FastVisionModel.from_pretrained(
    model_name=BASE_MODEL,
    load_in_4bit=True,         # QLoRA — cuts VRAM ~75%
    use_gradient_checkpointing="unsloth",
)

# Attach LoRA adapter targeting the language head + vision-language projector.
# Vision encoder stays frozen — we want to teach the model to *talk about*
# aerial images, not relearn how to see.
model = FastVisionModel.get_peft_model(
    model,
    finetune_vision_layers=False,
    finetune_language_layers=True,
    finetune_attention_modules=True,
    finetune_mlp_modules=True,
    r=LORA_R,
    lora_alpha=LORA_ALPHA,
    lora_dropout=LORA_DROPOUT,
    bias="none",
    random_state=SEED,
    use_rslora=False,
    loftq_config=None,
)


# ============================================================
# ==== CELL 4: load the synthetic dataset ===================
# ============================================================
# Reads the manifest produced by data_synth/generate.py and assembles
# Unsloth-style chat examples with one image + the system prompt + the
# expected JSON.

SYSTEM_PROMPT = """You are a humanitarian field analyst reviewing a top-down aerial image of a displaced-persons settlement, refugee camp, or temporary shelter site.

Identify visible features. Return STRICT JSON with this schema:
{
  "features": [
    {"type": "tent", "x": 0..1, "y": 0..1, "confidence": "high"|"medium"|"low"}
  ],
  "notes": ["short observation 1", "short observation 2"]
}

COORDINATE SYSTEM: (0,0) is the TOP-LEFT corner. x grows right, y grows down. Use 4-decimal floats.

RULES:
1. Tents include any small temporary shelter (tent, tarp, prefab cabin, makeshift dwelling).
2. Each tent is ONE entry — never lump a cluster into one point.
3. NEVER invent features you can't see.
4. NEVER list the same physical object twice.
5. Cap tents at 200.
6. Output ONLY the JSON. No markdown fences, no prose, no preamble."""

USER_PROMPT = "Analyze this aerial image of a settlement and return the JSON described in the system message."


def load_dataset_from_manifest(input_dir: Path) -> list[dict]:
    """Read metadata.json + image/label pairs into a flat list of dicts.

    Each item: {"image": PIL.Image, "label_json": str}.
    """
    meta = json.loads((input_dir / "metadata.json").read_text(encoding="utf-8"))
    items: list[dict] = []
    for entry in meta["items"]:
        img_path = input_dir / entry["image"]
        lbl_path = input_dir / entry["label"]
        if not img_path.exists() or not lbl_path.exists():
            continue
        img = Image.open(img_path).convert("RGB")
        label = lbl_path.read_text(encoding="utf-8")
        # Re-serialize compactly to match what we'll teach the model to emit.
        try:
            label_compact = json.dumps(json.loads(label), separators=(",", ":"))
        except json.JSONDecodeError:
            continue
        items.append({"image": img, "label_json": label_compact})
    return items


raw = load_dataset_from_manifest(INPUT_DIR)
print(f"Loaded {len(raw)} (image, label) pairs from {INPUT_DIR}")


# ============================================================
# ==== CELL 5: format into Unsloth's chat-with-image schema ==
# ============================================================

def format_one(row: dict) -> dict:
    """Return the Unsloth-style messages structure for one training example."""
    return {
        "messages": [
            {"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT}]},
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": row["image"]},
                    {"type": "text", "text": USER_PROMPT},
                ],
            },
            {
                "role": "assistant",
                "content": [{"type": "text", "text": row["label_json"]}],
            },
        ]
    }


formatted = [format_one(r) for r in raw]
random.shuffle(formatted)

# 90/10 split. With ~100 examples a held-out tenth is enough to eyeball
# overfit; quantitative eval lives in eval/compare.py.
split = max(1, int(len(formatted) * 0.9))
train_records = formatted[:split]
val_records = formatted[split:]
print(f"train = {len(train_records)}  val = {len(val_records)}")

train_ds = Dataset.from_list(train_records)
val_ds = Dataset.from_list(val_records) if val_records else None


# ============================================================
# ==== CELL 6: build the trainer =============================
# ============================================================
from trl import SFTTrainer, SFTConfig

FastVisionModel.for_training(model)  # enable gradient tracking

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=train_ds,
    eval_dataset=val_ds,
    args=SFTConfig(
        output_dir=str(OUTPUT_DIR / "checkpoints"),
        per_device_train_batch_size=BATCH_SIZE,
        gradient_accumulation_steps=GRAD_ACCUM,
        num_train_epochs=NUM_EPOCHS,
        learning_rate=LEARNING_RATE,
        weight_decay=WEIGHT_DECAY,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        logging_steps=2,
        save_strategy="epoch",
        eval_strategy="epoch" if val_ds else "no",
        bf16=is_bf16_supported(),
        fp16=not is_bf16_supported(),
        optim="adamw_8bit",
        max_grad_norm=1.0,
        seed=SEED,
        report_to="none",
        remove_unused_columns=False,
        dataset_text_field=None,         # vision template handles formatting
        dataset_kwargs={"skip_prepare_dataset": True},
    ),
)


# ============================================================
# ==== CELL 7: train =========================================
# ============================================================
# On Kaggle T4 with ~100 examples + 2 epochs this lands in ~15-30 minutes.
# If it disconnects, re-run from CELL 3 — the trainer will resume from the
# latest checkpoint in OUTPUT_DIR/checkpoints automatically.

stats = trainer.train(resume_from_checkpoint=False)
print(stats)


# ============================================================
# ==== CELL 8: save the LoRA adapter + tokenizer ============
# ============================================================
# This is what we'll download. Adapter ~50-200 MB; tokenizer ~5 MB.

adapter_dir = OUTPUT_DIR / "adapter"
model.save_pretrained(adapter_dir)
tokenizer.save_pretrained(adapter_dir)
print(f"Adapter + tokenizer saved to {adapter_dir}")


# ============================================================
# ==== CELL 9: quick smoke test on a val example ============
# ============================================================
# Sanity check: does the LoRA produce JSON in our schema on an unseen image?

FastVisionModel.for_inference(model)

if val_records:
    sample = val_records[0]
    expected = sample["messages"][2]["content"][0]["text"]
    image = sample["messages"][1]["content"][0]["image"]

    inputs = tokenizer.apply_chat_template(
        [
            sample["messages"][0],
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": USER_PROMPT},
                ],
            },
        ],
        add_generation_prompt=True,
        return_tensors="pt",
        tokenize=True,
    ).to("cuda")
    outputs = model.generate(
        **inputs,
        max_new_tokens=1024,
        temperature=0.0,
        do_sample=False,
    )
    generated = tokenizer.decode(outputs[0], skip_special_tokens=True)
    print("---- expected ----")
    print(expected[:1000])
    print("---- generated ----")
    print(generated[-1500:])  # tail so we skip the prompt echo


# ============================================================
# ==== CELL 10: merge LoRA into base + save full HF model ====
# ============================================================
# Doing the merge on Kaggle (where the GPU + 4-bit base weights already
# live) is faster than re-doing it on your laptop, and it produces a
# self-contained HF directory that local llama.cpp can convert directly
# to GGUF — so the laptop side only needs llama.cpp + Ollama, no torch
# or peft installed.

print("Merging LoRA into base...")
merged_dir = OUTPUT_DIR / "merged_hf"

# `save_pretrained_merged` is Unsloth's one-call helper that:
#   1. de-quantizes the 4-bit base
#   2. merges the LoRA delta into the dense weights
#   3. writes a full HF-format model to disk (config, weights, tokenizer)
# Output is fp16 by default — about 8 GB for Gemma 3 4B, fits comfortably
# in /kaggle/working/ for download.
model.save_pretrained_merged(
    str(merged_dir),
    tokenizer,
    save_method="merged_16bit",
)
print(f"Merged model saved to {merged_dir}")
print("Download this whole folder; pass --merged path/to/merged_hf to deploy/convert_and_deploy.py locally.")


# ============================================================
# ==== CELL 11: (optional) push to Hugging Face =============
# ============================================================
# Skip on Phase 1 — publish from Phase 2 once we have a real eval.
#
# from huggingface_hub import HfApi
# api = HfApi(token="hf_...")  # use a Kaggle secret
# api.upload_folder(
#     folder_path=str(adapter_dir),
#     repo_id="your-username/aidflow-camp-phase1",
#     repo_type="model",
#     private=True,
# )
