from __future__ import annotations

from typing import Any


# These current flags exist on Commons but are not consistently reachable from
# Category:SVG flags of municipalities in Japan. Keep the supplement explicit so
# the inventory remains reproducible and each polygon assignment is auditable.
KNOWN_CURRENT_FLAGS: tuple[dict[str, Any], ...] = (
    {
        "title": "File:Flag of Sakai, Osaka.svg",
        "category": "Category:SVG flags of municipalities in Ōsaka Prefecture",
        "jis5": (
            "27141",
            "27142",
            "27143",
            "27144",
            "27145",
            "27146",
            "27147",
        ),
        "assignment_kind": "inherited",
    },
    {
        "title": "File:Flag of Haga, Tochigi.svg",
        "category": "Category:SVG flags of municipalities in Tochigi Prefecture",
        "jis5": ("09345",),
        "assignment_kind": "direct",
    },
    {
        "title": "File:Flag of Yamanakako Yamanashi.svg",
        "category": "Category:SVG flags of municipalities in Yamanashi Prefecture",
        "jis5": ("19425",),
        "assignment_kind": "direct",
    },
    {
        "title": "File:Flag of Koumi, Nagano.svg",
        "category": "Category:SVG flags of municipalities in Nagano Prefecture",
        "jis5": ("20303",),
        "assignment_kind": "direct",
    },
    {
        "title": "File:Flag of Suita, Osaka.svg",
        "category": "Category:SVG flags of municipalities in Ōsaka Prefecture",
        "jis5": ("27205",),
        "assignment_kind": "direct",
    },
    {
        "title": "File:Flag of Yuasa Wakayama.svg",
        "category": "Category:SVG flags of municipalities in Wakayama Prefecture",
        "jis5": ("30361",),
        "assignment_kind": "direct",
    },
    {
        "title": "File:Flag of Higashihiroshima, Hiroshima.svg",
        "category": "Category:SVG flags of municipalities in Hiroshima Prefecture",
        "jis5": ("34212",),
        "assignment_kind": "direct",
    },
    {
        "title": "File:Flag of Oguni, Kumamoto.svg",
        "category": "Category:SVG flags of municipalities in Kumamoto Prefecture",
        "jis5": ("43424",),
        "assignment_kind": "direct",
    },
    {
        "title": "File:Flag of Nishihara Kumamoto.svg",
        "category": "Category:SVG flags of municipalities in Kumamoto Prefecture",
        "jis5": ("43432",),
        "assignment_kind": "direct",
    },
    {
        "title": "File:Flag of Miyakojima, Okinawa.svg",
        "category": "Category:SVG flags of municipalities in Okinawa Prefecture",
        "jis5": ("47214",),
        "assignment_kind": "direct",
    },
)


def add_known_current_flags(inventory: dict[str, Any]) -> int:
    files_by_title = {file["title"]: file for file in inventory["files"]}
    added = 0
    for known in KNOWN_CURRENT_FLAGS:
        file = files_by_title.get(known["title"])
        if file is None:
            file = {
                "title": known["title"],
                "categories": [known["category"]],
                "inventory_source": "known_current_flag_supplement",
            }
            inventory["files"].append(file)
            files_by_title[known["title"]] = file
            added += 1
        elif known["category"] not in file["categories"]:
            file["categories"].append(known["category"])
    return added


def known_current_flag_matches(
    files: list[dict[str, Any]],
    municipalities: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    page_by_title = {file["title"]: int(file["page_id"]) for file in files}
    valid_codes = {municipality["jis5"] for municipality in municipalities}
    matches: list[dict[str, Any]] = []
    for known in KNOWN_CURRENT_FLAGS:
        page_id = page_by_title.get(known["title"])
        if page_id is None:
            continue
        for jis5 in known["jis5"]:
            if jis5 not in valid_codes:
                continue
            matches.append(
                {
                    "jis5": jis5,
                    "page_id": page_id,
                    "method": (
                        "parent_city_flag_inheritance"
                        if known["assignment_kind"] == "inherited"
                        else "curated_commons_title_match"
                    ),
                    "confidence": 1.0,
                    "title": known["title"],
                }
            )
    return matches
