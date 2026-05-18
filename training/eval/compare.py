"""Compare base-model vs fine-tuned-LoRA outputs on a folder of test images.

Runs both models against http://localhost:11434/api/chat (your existing
Ollama instance) and writes a side-by-side report. Useful even when
ground truth doesn't exist — we measure schema discipline (does it parse?
how many features? any duplicates?) rather than coordinate accuracy.

Workflow:
  1. Train a LoRA via notebooks/phase1_finetune.py.
  2. Convert the LoRA → GGUF and install as a new Ollama model, e.g.
     `aidflow-camp:e4b-lora-v01`. See README.md → "Deploying back to Ollama".
  3. Drop test images into ./test_images/ (or pass --images).
  4. Run:  python eval/compare.py --base gemma4:e4b --lora aidflow-camp:e4b-lora-v01

The script doesn't need labels — it's a qualitative compare. For true
metric evaluation we'll add a labeled-test-set harness in Phase 2.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

import requests

OLLAMA_URL = "http://localhost:11434/api/chat"

SYSTEM_PROMPT = """You are a humanitarian field analyst reviewing a top-down aerial image of a displaced-persons settlement, refugee camp, or temporary shelter site.

Identify visible features. Return STRICT JSON with this schema:
{
  "features": [
    {"type": "tent", "x": 0..1, "y": 0..1, "confidence": "high"|"medium"|"low"}
  ],
  "notes": ["short observation 1", "short observation 2"]
}

COORDINATE SYSTEM: (0,0) is the TOP-LEFT corner. x grows right, y grows down. Use 4-decimal floats.
RULES: Each tent is ONE entry. NEVER invent features. NEVER duplicate. Cap tents at 200. Output ONLY the JSON."""

USER_PROMPT = "Analyze this aerial image and return the JSON described in the system message."


def b64_image(path: Path) -> str:
    """Return raw base64 (no data: prefix) — what Ollama expects."""
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def call_ollama(model: str, image_b64: str) -> dict:
    """Send one image to one model via Ollama, return parsed result + meta."""
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": USER_PROMPT, "images": [image_b64]},
        ],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0, "num_predict": 4096},
    }
    r = requests.post(OLLAMA_URL, json=payload, timeout=300)
    r.raise_for_status()
    body = r.json()
    raw = body.get("message", {}).get("content", "")
    return {
        "raw": raw,
        "eval_duration_ms": int(body.get("eval_duration", 0) / 1_000_000),
        "total_duration_ms": int(body.get("total_duration", 0) / 1_000_000),
    }


def analyze(raw: str) -> dict:
    """Schema-discipline stats: did it parse? counts? duplicates?"""
    out = {
        "parsed": False,
        "n_features": 0,
        "n_tents": 0,
        "duplicate_pairs": 0,
        "out_of_bounds": 0,
        "low_confidence": 0,
        "error": None,
    }
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as e:
        out["error"] = f"JSON: {e.msg}"
        return out
    if not isinstance(obj, dict) or not isinstance(obj.get("features"), list):
        out["error"] = "no features array"
        return out
    out["parsed"] = True
    feats = obj["features"]
    out["n_features"] = len(feats)
    tents = [f for f in feats if isinstance(f, dict) and f.get("type") == "tent"]
    out["n_tents"] = len(tents)
    # Coordinate validation
    coords: list[tuple[float, float]] = []
    for f in tents:
        x = f.get("x")
        y = f.get("y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        if x < 0 or x > 1 or y < 0 or y > 1:
            out["out_of_bounds"] += 1
            continue
        coords.append((float(x), float(y)))
        if f.get("confidence") == "low":
            out["low_confidence"] += 1
    # Approximate duplicate detection — same threshold the prod parser uses.
    for i in range(len(coords)):
        for j in range(i + 1, len(coords)):
            dx = coords[i][0] - coords[j][0]
            dy = coords[i][1] - coords[j][1]
            if (dx * dx + dy * dy) ** 0.5 < 0.012:
                out["duplicate_pairs"] += 1
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Compare base vs LoRA on a folder of images.")
    ap.add_argument("--base", required=True, help="Base Ollama model name.")
    ap.add_argument("--lora", required=True, help="Fine-tuned Ollama model name.")
    ap.add_argument(
        "--images",
        type=Path,
        default=Path(__file__).parent / "test_images",
        help="Folder of test images.",
    )
    ap.add_argument("--out", type=Path, default=Path(__file__).parent / "report.md")
    args = ap.parse_args()

    if not args.images.exists():
        print(f"!! image folder not found: {args.images}", file=sys.stderr)
        print(f"   create it and drop in 5-20 aerial images you trust as a test set")
        sys.exit(1)

    imgs = sorted(
        list(args.images.glob("*.jpg"))
        + list(args.images.glob("*.jpeg"))
        + list(args.images.glob("*.png"))
    )
    if not imgs:
        print(f"!! no images found in {args.images}", file=sys.stderr)
        sys.exit(1)

    rows: list[dict] = []
    print(f"== Comparing on {len(imgs)} images")
    print(f"   base = {args.base}")
    print(f"   lora = {args.lora}")
    print()

    for path in imgs:
        print(f"-- {path.name}")
        b64 = b64_image(path)
        try:
            base_r = call_ollama(args.base, b64)
            base_stats = analyze(base_r["raw"])
        except requests.RequestException as e:
            print(f"   base failed: {e}")
            continue
        try:
            lora_r = call_ollama(args.lora, b64)
            lora_stats = analyze(lora_r["raw"])
        except requests.RequestException as e:
            print(f"   lora failed: {e}")
            continue
        rows.append(
            {
                "name": path.name,
                "base": {**base_stats, **{k: base_r[k] for k in ["eval_duration_ms"]}},
                "lora": {**lora_stats, **{k: lora_r[k] for k in ["eval_duration_ms"]}},
            }
        )
        print(
            f"   base tents={base_stats['n_tents']:>3} dup={base_stats['duplicate_pairs']:>2} "
            f"oob={base_stats['out_of_bounds']:>2} parsed={base_stats['parsed']}  "
            f"|  lora tents={lora_stats['n_tents']:>3} dup={lora_stats['duplicate_pairs']:>2} "
            f"oob={lora_stats['out_of_bounds']:>2} parsed={lora_stats['parsed']}"
        )

    # Aggregate
    def agg(side: str, key: str) -> float:
        vals = [r[side][key] for r in rows if r[side]["parsed"]]
        return sum(vals) / len(vals) if vals else 0.0

    md = ["# Base vs LoRA — Phase 1 qualitative compare", ""]
    md.append(f"- **Images compared:** {len(rows)}")
    md.append(f"- **Base model:** `{args.base}`")
    md.append(f"- **LoRA model:** `{args.lora}`")
    md.append("")
    md.append("## Aggregate")
    md.append("")
    md.append("| Metric | Base | LoRA |")
    md.append("|---|---:|---:|")
    md.append(
        f"| Parse rate | {sum(1 for r in rows if r['base']['parsed']) / max(1, len(rows)):.0%} "
        f"| {sum(1 for r in rows if r['lora']['parsed']) / max(1, len(rows)):.0%} |"
    )
    md.append(f"| Avg tents detected | {agg('base', 'n_tents'):.1f} | {agg('lora', 'n_tents'):.1f} |")
    md.append(
        f"| Avg duplicate pairs | {agg('base', 'duplicate_pairs'):.2f} | {agg('lora', 'duplicate_pairs'):.2f} |"
    )
    md.append(
        f"| Avg out-of-bounds | {agg('base', 'out_of_bounds'):.2f} | {agg('lora', 'out_of_bounds'):.2f} |"
    )
    md.append(f"| Avg eval time (ms) | {agg('base', 'eval_duration_ms'):.0f} | {agg('lora', 'eval_duration_ms'):.0f} |")
    md.append("")
    md.append("## Per-image breakdown")
    md.append("")
    md.append("| Image | base tents | base dup | base oob | lora tents | lora dup | lora oob |")
    md.append("|---|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        b = r["base"]
        l = r["lora"]
        md.append(
            f"| {r['name']} | {b['n_tents']} | {b['duplicate_pairs']} | {b['out_of_bounds']} "
            f"| {l['n_tents']} | {l['duplicate_pairs']} | {l['out_of_bounds']} |"
        )

    args.out.write_text("\n".join(md), encoding="utf-8")
    print()
    print(f"== report written to {args.out.resolve()}")


if __name__ == "__main__":
    main()
