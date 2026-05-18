"""Synthetic-dataset generator for the Drone Camp Planner fine-tune.

Pipeline (per camp area):
    1. Query the Overpass API for ways/relations tagged `building=*`
       inside the area's bbox.
    2. Compute each footprint's centroid in lat/lon.
    3. For every web-mercator tile (z, x, y) at the configured zoom that
       contains at least MIN_TENTS centroids:
         a) Download the Esri World Imagery raster for (z, x, y).
         b) Project the centroids inside the tile into normalized
            (x_norm, y_norm) ∈ [0, 1]² space within the tile.
         c) Emit (image.jpg, label.json) under ./dataset/.

Notes:
    - Esri World Imagery is served via ArcGIS REST at zoom levels 0-19.
      Z18 ≈ 0.6 m/px globally — appropriate for individual tents.
    - We are polite to the tile server: ~8 req/s ceiling, single thread,
      User-Agent identifies us. If you push harder Esri may block.
    - Coordinates everywhere are normalized 0..1 so they match the schema
      in src/services/campMap.ts SYSTEM_PROMPT.

Run:
    python data_synth/generate.py --n 100 --out ./dataset
"""

from __future__ import annotations

import argparse
import io
import json
import math
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import requests
from PIL import Image
from tqdm import tqdm

# Local import: sources.py
sys.path.insert(0, str(Path(__file__).parent))
from sources import ALL_AREAS, CampArea, by_slug

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
# Esri World Imagery tile pattern. ArcGIS REST uses {z}/{y}/{x} (note y/x order).
ESRI_TILE_URL = (
    "https://server.arcgisonline.com/ArcGIS/rest/services/"
    "World_Imagery/MapServer/tile/{z}/{y}/{x}"
)
USER_AGENT = "AidFlow-Pro-Training/0.1 (https://github.com/Cyberman-HZ/Aidflow)"
TILE_PX = 256  # Web-mercator tile is 256×256 px


@dataclass(frozen=True)
class TileKey:
    z: int
    x: int
    y: int


# ---------------------------------------------------------------------------
# Web-mercator math (no external mapping deps; see Wikipedia "Web Mercator")
# ---------------------------------------------------------------------------


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[float, float]:
    """Return fractional (x, y) tile coords for a given lon/lat at zoom z."""
    n = 2.0 ** z
    x = (lon + 180.0) / 360.0 * n
    lat_rad = math.radians(lat)
    y = (1.0 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2.0 * n
    return x, y


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Return (south, west, north, east) lon/lat bounds of tile (z, x, y)."""
    n = 2.0 ** z
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0
    north_rad = math.atan(math.sinh(math.pi * (1 - 2 * y / n)))
    south_rad = math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n)))
    return math.degrees(south_rad), west, math.degrees(north_rad), east


# ---------------------------------------------------------------------------
# Overpass query
# ---------------------------------------------------------------------------


def fetch_building_centroids(area: CampArea) -> list[tuple[float, float]]:
    """Return a list of (lon, lat) centroids for buildings in `area`'s bbox.

    Overpass returns ways/relations; we approximate centroids by averaging
    each element's node coordinates. Good enough for training labels —
    Sphere math doesn't care if a tent's centroid is off by 1-2 m.
    """
    south, west, north, east = area.bbox
    query = f"""
[out:json][timeout:120];
(
  way["building"]({south},{west},{north},{east});
  relation["building"]({south},{west},{north},{east});
);
out center;
"""
    r = requests.post(
        OVERPASS_URL,
        data={"data": query},
        headers={"User-Agent": USER_AGENT},
        timeout=180,
    )
    r.raise_for_status()
    data = r.json()
    out: list[tuple[float, float]] = []
    for el in data.get("elements", []):
        c = el.get("center")
        if not c:
            continue
        lat = c.get("lat")
        lon = c.get("lon")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            out.append((float(lon), float(lat)))
    return out


# ---------------------------------------------------------------------------
# Esri tile fetch (cached)
# ---------------------------------------------------------------------------


def fetch_tile(key: TileKey, cache_dir: Path) -> Image.Image:
    """Download (or load from cache) a single Esri World Imagery tile."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"z{key.z}_x{key.x}_y{key.y}.jpg"
    if cache_path.exists():
        return Image.open(cache_path).convert("RGB")
    url = ESRI_TILE_URL.format(z=key.z, x=key.x, y=key.y)
    r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
    r.raise_for_status()
    img = Image.open(io.BytesIO(r.content)).convert("RGB")
    img.save(cache_path, quality=88)
    # Polite delay — Esri tolerates ~10 req/s for non-commercial use.
    time.sleep(0.12)
    return img


def fetch_patch(
    key: TileKey,
    patch_px: int,
    cache_dir: Path,
) -> Image.Image | None:
    """Build a `patch_px`×`patch_px` image starting from tile `key`.

    A "patch" may need multiple base 256×256 tiles tiled together. For
    patch_px == 256 we just return the single tile. For patch_px == 512
    we stitch 2×2; for 768 we stitch 3×3, etc.
    """
    n = patch_px // TILE_PX
    if patch_px % TILE_PX != 0 or n < 1:
        raise ValueError(f"patch_px must be a positive multiple of {TILE_PX}")
    if n == 1:
        return fetch_tile(key, cache_dir)
    out = Image.new("RGB", (patch_px, patch_px))
    for dy in range(n):
        for dx in range(n):
            sub = TileKey(key.z, key.x + dx, key.y + dy)
            try:
                tile = fetch_tile(sub, cache_dir)
            except requests.HTTPError:
                # Edge tiles outside Esri coverage — skip the whole patch.
                return None
            out.paste(tile, (dx * TILE_PX, dy * TILE_PX))
    return out


# ---------------------------------------------------------------------------
# Patch bucketing — group centroids by which patch they fall into
# ---------------------------------------------------------------------------


def bucket_patches(
    centroids: list[tuple[float, float]],
    z: int,
    patch_px: int,
) -> dict[TileKey, list[tuple[float, float]]]:
    """Return a dict: patch_origin_tile_key → list of (x_norm, y_norm) in [0,1]².

    Each patch is `patch_px / TILE_PX` tiles wide, anchored on its
    top-left tile. A centroid belongs to the patch whose top-left tile
    is the one whose x is `floor(tilex / n) * n` and similar for y.
    """
    n = patch_px // TILE_PX
    out: dict[TileKey, list[tuple[float, float]]] = {}
    for lon, lat in centroids:
        fx, fy = lonlat_to_tile(lon, lat, z)
        # Origin tile of the patch this centroid belongs to.
        ox = int(fx // n) * n
        oy = int(fy // n) * n
        key = TileKey(z, ox, oy)
        # Normalized 0..1 within the patch.
        x_norm = (fx - ox) / n
        y_norm = (fy - oy) / n
        if 0 <= x_norm <= 1 and 0 <= y_norm <= 1:
            out.setdefault(key, []).append((x_norm, y_norm))
    return out


# ---------------------------------------------------------------------------
# Patch → (image, label) writer
# ---------------------------------------------------------------------------


def write_patch(
    area: CampArea,
    key: TileKey,
    norm_centroids: list[tuple[float, float]],
    img: Image.Image,
    out_root: Path,
) -> tuple[str, str]:
    """Persist one patch to disk; return (image_rel_path, label_rel_path)."""
    stem = f"{area.slug}_z{key.z}_x{key.x}_y{key.y}"
    img_path = out_root / "images" / f"{stem}.jpg"
    lbl_path = out_root / "labels" / f"{stem}.json"
    img_path.parent.mkdir(parents=True, exist_ok=True)
    lbl_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(img_path, quality=88)
    label = {
        "features": [
            {
                "type": "tent",
                "x": round(x, 4),
                "y": round(y, 4),
                "confidence": "high",
            }
            for (x, y) in norm_centroids
        ],
        "notes": [
            f"Auto-generated from OSM building footprints over Esri World "
            f"Imagery at z{key.z} ({area.slug})."
        ],
    }
    lbl_path.write_text(json.dumps(label), encoding="utf-8")
    return (
        str(img_path.relative_to(out_root)).replace("\\", "/"),
        str(lbl_path.relative_to(out_root)).replace("\\", "/"),
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Generate synthetic image/JSON pairs from OSM footprints + Esri imagery."
    )
    ap.add_argument("--n", type=int, default=100, help="Target number of patches.")
    ap.add_argument("--out", type=Path, default=Path("./dataset"), help="Output dir.")
    ap.add_argument("--min-tents", type=int, default=5)
    ap.add_argument("--max-tents", type=int, default=200)
    ap.add_argument(
        "--patch-px",
        type=int,
        default=512,
        help=f"Patch side in pixels (multiple of {TILE_PX}).",
    )
    ap.add_argument("--zoom", type=int, default=18)
    ap.add_argument(
        "--areas",
        type=str,
        default="",
        help="Comma-separated slugs to limit to (default: all).",
    )
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    random.seed(args.seed)
    out_root: Path = args.out
    cache_dir = out_root.parent / ".tile_cache"

    # Resolve area list.
    if args.areas.strip():
        wanted = [s.strip() for s in args.areas.split(",") if s.strip()]
        areas: list[CampArea] = []
        for slug in wanted:
            a = by_slug(slug)
            if not a:
                print(f"!! unknown area: {slug}", file=sys.stderr)
                sys.exit(1)
            areas.append(a)
    else:
        areas = list(ALL_AREAS)

    print(f"== Phase 1 synthetic data generation")
    print(f"   areas:    {[a.slug for a in areas]}")
    print(f"   target:   {args.n} patches")
    print(f"   patch:    {args.patch_px}×{args.patch_px} px at z{args.zoom}")
    print(f"   filter:   {args.min_tents} ≤ tents ≤ {args.max_tents}")
    print(f"   output:   {out_root.resolve()}")
    print()

    manifest: list[dict] = []
    per_area_counts: dict[str, int] = {a.slug: 0 for a in areas}
    written = 0

    candidates_by_area: dict[str, list[tuple[TileKey, list]]] = {}
    for area in areas:
        print(f"-- {area.slug}: fetching Overpass footprints...", flush=True)
        try:
            centroids = fetch_building_centroids(area)
        except requests.HTTPError as e:
            print(f"!! Overpass HTTP error for {area.slug}: {e}", file=sys.stderr)
            continue
        except requests.RequestException as e:
            print(f"!! Overpass request error for {area.slug}: {e}", file=sys.stderr)
            continue
        print(f"   {len(centroids)} building centroids", flush=True)
        if not centroids:
            continue
        buckets = bucket_patches(centroids, args.zoom, args.patch_px)
        ok = [
            (k, v)
            for k, v in buckets.items()
            if args.min_tents <= len(v) <= args.max_tents
        ]
        random.shuffle(ok)
        candidates_by_area[area.slug] = ok
        print(f"   {len(ok)} qualifying patches", flush=True)

    # Round-robin draw until we hit args.n or every area is exhausted.
    progress = tqdm(total=args.n, desc="writing patches")
    while written < args.n:
        drew_one = False
        for area in areas:
            if written >= args.n:
                break
            pool = candidates_by_area.get(area.slug)
            if not pool:
                continue
            key, norms = pool.pop()
            try:
                img = fetch_patch(key, args.patch_px, cache_dir)
            except requests.HTTPError as e:
                print(f"!! tile fetch HTTP error: {e}", file=sys.stderr)
                continue
            except requests.RequestException as e:
                print(f"!! tile fetch error: {e}", file=sys.stderr)
                continue
            if img is None:
                continue
            img_rel, lbl_rel = write_patch(area, key, norms, img, out_root)
            manifest.append(
                {
                    "image": img_rel,
                    "label": lbl_rel,
                    "area": area.slug,
                    "tile": {"z": key.z, "x": key.x, "y": key.y},
                    "tent_count": len(norms),
                }
            )
            per_area_counts[area.slug] += 1
            written += 1
            drew_one = True
            progress.update(1)
        if not drew_one:
            # Every area's pool is empty — stop early.
            break
    progress.close()

    # Metadata sidecar.
    metadata = {
        "version": 1,
        "seed": args.seed,
        "patches_written": written,
        "target": args.n,
        "patch_px": args.patch_px,
        "zoom": args.zoom,
        "min_tents": args.min_tents,
        "max_tents": args.max_tents,
        "per_area_counts": per_area_counts,
        "schema": "see src/services/campMap.ts SYSTEM_PROMPT",
        "sources": "OSM (ODbL) + Esri World Imagery (non-commercial)",
        "items": manifest,
    }
    (out_root / "metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )

    print()
    print(f"== done: wrote {written}/{args.n} patches to {out_root.resolve()}")
    for slug, n in per_area_counts.items():
        print(f"   {slug:<14} {n} patches")


if __name__ == "__main__":
    main()
