"""Registry of refugee / IDP camp areas with known building-footprint coverage.

Each entry has a stable slug, a bounding box (south, west, north, east) in
WGS84 degrees, and a brief note explaining where the footprints come from.

Bboxes are approximate and intentionally generous — we filter empty tiles
out downstream rather than carving precise polygons here. Coordinates are
copied from public sources (HOTOSM project pages, UNHCR camp factsheets);
none of these are operational secrets.

To add a new area:
  1. Find the camp on https://www.openstreetmap.org and note its bbox.
  2. Check that OSM has reasonable building coverage there.
  3. Append a CampArea entry below.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class CampArea:
    """A geographic area we'll mine for shelter footprints + imagery."""

    slug: str
    """Stable id used in filenames and metadata."""

    name: str
    """Human-readable name."""

    bbox: tuple[float, float, float, float]
    """south, west, north, east — WGS84 degrees."""

    note: str = ""
    """Free-text note: data quality, last-seen population, mapping campaign."""


# ---------------------------------------------------------------------------
# Phase 1 seed list — 8 areas with strong OSM coverage. Add to the list
# directly; downstream code iterates ALL_AREAS.
# ---------------------------------------------------------------------------

ALL_AREAS: tuple[CampArea, ...] = (
    CampArea(
        slug="cox_bazar",
        name="Kutupalong-Balukhali (Cox's Bazar, Bangladesh)",
        bbox=(21.10, 92.13, 21.25, 92.22),
        note="World's largest refugee settlement. Densely mapped by HOTOSM "
        "since 2017; ~700k Rohingya. Excellent footprint density.",
    ),
    CampArea(
        slug="kakuma",
        name="Kakuma (Turkana, Kenya)",
        bbox=(3.69, 34.84, 3.79, 34.92),
        note="~190k refugees. Well mapped by Mapping Africa + HOTOSM.",
    ),
    CampArea(
        slug="dadaab",
        name="Dadaab complex (Garissa, Kenya)",
        bbox=(0.00, 40.30, 0.13, 40.42),
        note="Three sub-camps (Dagahaley, Hagadera, Ifo). ~240k refugees.",
    ),
    CampArea(
        slug="bidi_bidi",
        name="Bidi Bidi (Yumbe, Uganda)",
        bbox=(3.40, 31.25, 3.55, 31.45),
        note="South Sudanese refugees. Mapped by HOTOSM 2017–2019.",
    ),
    CampArea(
        slug="zaatari",
        name="Zaatari (Mafraq, Jordan)",
        bbox=(32.28, 36.31, 32.32, 36.36),
        note="Syrian refugees. Highly regularized grid; great for early "
        "training because tents are uniformly spaced.",
    ),
    CampArea(
        slug="azraq",
        name="Azraq (Zarqa, Jordan)",
        bbox=(31.89, 36.55, 31.93, 36.61),
        note="Syrian refugees. Newer than Zaatari, prefab shelters.",
    ),
    CampArea(
        slug="nyarugusu",
        name="Nyarugusu (Kigoma, Tanzania)",
        bbox=(-4.30, 30.36, -4.18, 30.45),
        note="Burundian + Congolese refugees. ~150k.",
    ),
    CampArea(
        slug="palabek",
        name="Palabek (Lamwo, Uganda)",
        bbox=(3.55, 32.50, 3.65, 32.60),
        note="South Sudanese refugees. Smaller, ~50k; tests model on "
        "sparser densities.",
    ),
)


def by_slug(slug: str) -> CampArea | None:
    """Look up a single area by slug — returns None if not found."""
    for a in ALL_AREAS:
        if a.slug == slug:
            return a
    return None
