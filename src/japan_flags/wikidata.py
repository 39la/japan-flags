from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from .http import request_json

ENWIKI_API = "https://en.wikipedia.org/w/api.php"
JAWIKI_API = "https://ja.wikipedia.org/w/api.php"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"


def _api_url(base: str, **parameters: str) -> str:
    return f"{base}?{urlencode(parameters)}"


def fetch_wikidata_codes_for_enwiki_titles(titles: set[str]) -> dict[str, str]:
    """Resolve English Wikipedia titles to five-digit N03 codes via P429."""
    if not titles:
        return {}

    title_to_item: dict[str, str] = {}
    title_list = sorted(titles)
    for start in range(0, len(title_list), 40):
        batch = title_list[start : start + 40]
        response = request_json(
            _api_url(
                ENWIKI_API,
                action="query",
                format="json",
                formatversion="2",
                prop="pageprops",
                ppprop="wikibase_item",
                redirects="1",
                titles="|".join(batch),
            )
        )
        for page in response["query"]["pages"]:
            item_id = page.get("pageprops", {}).get("wikibase_item")
            if item_id:
                title_to_item[page["title"].replace(" ", "_")] = item_id

    item_to_code: dict[str, str] = {}
    item_ids = sorted(set(title_to_item.values()))
    for start in range(0, len(item_ids), 50):
        batch = item_ids[start : start + 50]
        response = request_json(
            _api_url(
                WIKIDATA_API,
                action="wbgetentities",
                format="json",
                props="claims",
                ids="|".join(batch),
            )
        )
        for item_id, entity in response["entities"].items():
            claims: list[dict[str, Any]] = entity.get("claims", {}).get("P429", [])
            for claim in claims:
                value = claim.get("mainsnak", {}).get("datavalue", {}).get("value")
                if isinstance(value, str) and len(value) == 6 and value.isdigit():
                    item_to_code[item_id] = value[:5]
                    break

    return {
        title: item_to_code[item_id]
        for title, item_id in title_to_item.items()
        if item_id in item_to_code
    }


def fetch_wikidata_codes_for_item_ids(item_ids: set[str]) -> dict[str, str]:
    if not item_ids:
        return {}

    item_to_code: dict[str, str] = {}
    sorted_ids = sorted(item_ids)
    for start in range(0, len(sorted_ids), 50):
        batch = sorted_ids[start : start + 50]
        response = request_json(
            _api_url(
                WIKIDATA_API,
                action="wbgetentities",
                format="json",
                props="claims",
                ids="|".join(batch),
            )
        )
        for item_id, entity in response["entities"].items():
            claims: list[dict[str, Any]] = entity.get("claims", {}).get("P429", [])
            for claim in claims:
                value = claim.get("mainsnak", {}).get("datavalue", {}).get("value")
                if isinstance(value, str) and len(value) == 6 and value.isdigit():
                    item_to_code[item_id] = value[:5]
                    break
    return item_to_code


def fetch_flag_filenames_for_jawiki_titles(
    titles: set[str],
) -> dict[str, str]:
    """Resolve Japanese Wikipedia titles to current Commons flag filenames."""
    if not titles:
        return {}

    title_to_item: dict[str, str] = {}
    title_list = sorted(titles)
    for start in range(0, len(title_list), 40):
        batch = title_list[start : start + 40]
        response = request_json(
            _api_url(
                JAWIKI_API,
                action="query",
                format="json",
                formatversion="2",
                prop="pageprops",
                ppprop="wikibase_item",
                redirects="1",
                titles="|".join(batch),
            )
        )
        for page in response["query"]["pages"]:
            item_id = page.get("pageprops", {}).get("wikibase_item")
            if item_id:
                title_to_item[page["title"]] = item_id

    item_to_filename: dict[str, str] = {}
    item_ids = sorted(set(title_to_item.values()))
    for start in range(0, len(item_ids), 50):
        batch = item_ids[start : start + 50]
        response = request_json(
            _api_url(
                WIKIDATA_API,
                action="wbgetentities",
                format="json",
                props="claims",
                ids="|".join(batch),
            )
        )
        for item_id, entity in response["entities"].items():
            claims: list[dict[str, Any]] = entity.get("claims", {}).get("P41", [])
            ordered_claims = sorted(
                claims,
                key=lambda claim: claim.get("rank") != "preferred",
            )
            for claim in ordered_claims:
                value = claim.get("mainsnak", {}).get("datavalue", {}).get("value")
                if isinstance(value, str) and value.lower().endswith(".svg"):
                    item_to_filename[item_id] = value
                    break

    return {
        title: item_to_filename[item_id]
        for title, item_id in title_to_item.items()
        if item_id in item_to_filename
    }
