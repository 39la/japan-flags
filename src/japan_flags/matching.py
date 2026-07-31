from __future__ import annotations

import re
import unicodedata
from typing import Any
from urllib.parse import unquote


def choose_primary_flags(matches: list[dict[str, Any]]) -> None:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for match in matches:
        grouped.setdefault(match["jis5"], []).append(match)
    for group in grouped.values():
        preferred = min(
            group,
            key=lambda match: (
                match["method"] == "parent_city_flag_inheritance",
                "(" in match["title"],
                match["title"].lower(),
                match["page_id"],
            ),
        )
        for match in group:
            match["is_primary"] = match is preferred


def _normalize_article_title(title: str) -> str:
    return unicodedata.normalize("NFKC", unquote(title).replace("_", " ")).strip()


def _without_disambiguation(title: str) -> str:
    return re.sub(r"\s*\([^()]+\)\s*$", "", title)


def _normalize_english_name(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(
        character for character in value if not unicodedata.combining(character)
    )
    value = re.sub(r"\b(city|town|village|ward)\b", "", value, flags=re.I)
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _filename_english_hint(title: str) -> str:
    value = title.removeprefix("File:").removesuffix(".svg")
    value = re.sub(r"^\d+(?:st|nd|rd|th) flag of ", "", value, flags=re.I)
    value = re.sub(r"^Flag of ", "", value, flags=re.I)
    value = re.sub(r"\s*\([^()]*\)\s*$", "", value)
    return value.split(",", 1)[0].strip()


def _ward_codes_for_parent(
    parent_code: str,
    municipalities: list[dict[str, Any]],
) -> set[str]:
    if (
        len(parent_code) != 5
        or not parent_code.isdigit()
        or not parent_code.endswith("0")
    ):
        return set()
    lower = int(parent_code)
    upper = lower + (29 if parent_code.endswith("00") else 9)
    numeric_ward_codes = {
        municipality["jis5"]
        for municipality in municipalities
        if municipality.get("ward_name") and lower < int(municipality["jis5"]) <= upper
    }
    city_names = {
        municipality["municipality_name"]
        for municipality in municipalities
        if municipality["jis5"] in numeric_ward_codes
    }
    return {
        municipality["jis5"]
        for municipality in municipalities
        if municipality.get("ward_name")
        and (
            municipality["jis5"] in numeric_ward_codes
            or municipality["municipality_name"] in city_names
        )
    }


def match_commons_files_to_municipalities(
    files: list[dict[str, Any]],
    municipalities: list[dict[str, Any]],
    *,
    enwiki_codes: dict[str, str] | None = None,
    wikidata_item_codes: dict[str, str] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    codes_by_name: dict[str, set[str]] = {}
    for municipality in municipalities:
        for name in (
            municipality["display_name"],
            municipality["municipality_name"],
            municipality["ward_name"],
        ):
            if name:
                normalized = unicodedata.normalize("NFKC", name)
                codes_by_name.setdefault(normalized, set()).add(municipality["jis5"])

    matches: list[dict[str, Any]] = []
    unmatched: list[dict[str, Any]] = []
    valid_codes = {municipality["jis5"] for municipality in municipalities}
    for file in files:
        prefecture_code = str(file.get("prefecture_code") or "")
        allowed_codes = (
            {code for code in valid_codes if code.startswith(prefecture_code)}
            if prefecture_code
            else valid_codes
        )
        ja_candidates = {
            code
            for usage in file.get("global_usage", [])
            if usage["wiki"] == "ja.wikipedia.org"
            and int(usage["ns"]) == 0
            and (
                title := _without_disambiguation(
                    _normalize_article_title(usage["title"])
                )
            )
            in codes_by_name
            for code in codes_by_name[title]
            if code in allowed_codes
        }
        wikidata_candidates: set[str] = set()
        wikidata_parent_codes: set[str] = set()
        if wikidata_item_codes:
            for usage in file.get("global_usage", []):
                item_id = _normalize_article_title(usage["title"])
                if not re.fullmatch(r"Q\d+", item_id):
                    continue
                code = wikidata_item_codes.get(item_id)
                if code in valid_codes:
                    wikidata_candidates.add(code)
                elif code and code.endswith("0"):
                    wikidata_parent_codes.add(code)
        preferred_en_candidates: set[str] = set()
        preferred_parent_codes: set[str] = set()
        all_en_candidates: set[str] = set()
        if enwiki_codes:
            filename_hint = _normalize_english_name(
                _filename_english_hint(file["title"])
            )
            for usage in file.get("global_usage", []):
                if usage["wiki"] != "en.wikipedia.org" or int(usage["ns"]) != 0:
                    continue
                article_title = _normalize_article_title(usage["title"])
                code = enwiki_codes.get(article_title.replace(" ", "_"))
                article_subject = article_title.split(",", 1)[0]
                subject_matches = (
                    _normalize_english_name(article_subject) == filename_hint
                )
                if code in allowed_codes:
                    all_en_candidates.add(code)
                elif code and subject_matches and code.endswith("0"):
                    preferred_parent_codes.add(code)
                if code in valid_codes and subject_matches:
                    preferred_en_candidates.add(code)

        inherited_codes: set[str] = set()
        parent_candidates = preferred_parent_codes | wikidata_parent_codes
        if len(parent_candidates) == 1:
            inherited_codes = _ward_codes_for_parent(
                next(iter(parent_candidates)),
                municipalities,
            )

        if inherited_codes:
            for code in sorted(inherited_codes):
                matches.append(
                    {
                        "jis5": code,
                        "page_id": file["page_id"],
                        "method": "parent_city_flag_inheritance",
                        "confidence": 0.95,
                        "title": file["title"],
                    }
                )
            continue
        if len(wikidata_candidates) == 1:
            candidates = wikidata_candidates
            method = "wikidata_p429_item_usage"
        elif len(preferred_en_candidates) == 1:
            candidates = preferred_en_candidates
            method = "wikidata_p429_filename_enwiki_exact"
        elif len(ja_candidates) == 1:
            candidates = ja_candidates
            method = "jawiki_globalusage_exact"
        elif not ja_candidates and len(all_en_candidates) == 1:
            candidates = all_en_candidates
            method = "wikidata_p429_via_enwiki_usage"
        else:
            candidates = ja_candidates or all_en_candidates
            method = (
                "jawiki_globalusage_exact"
                if ja_candidates
                else "wikidata_p429_via_enwiki_usage"
            )

        if len(candidates) == 1:
            matches.append(
                {
                    "jis5": candidates.pop(),
                    "page_id": file["page_id"],
                    "method": method,
                    "confidence": 1.0,
                    "title": file["title"],
                }
            )
        else:
            unmatched.append(
                {
                    "page_id": file["page_id"],
                    "title": file["title"],
                    "candidate_codes": sorted(candidates),
                    "reason": (
                        "no_exact_usage_match"
                        if not candidates
                        else "ambiguous_usage_match"
                    ),
                }
            )

    file_by_page = {file["page_id"]: file for file in files}
    codes_by_filename_hint: dict[tuple[str, str], set[str]] = {}
    for match in matches:
        file = file_by_page[match["page_id"]]
        hint = _normalize_english_name(_filename_english_hint(match["title"]))
        key = (str(file.get("prefecture_code") or ""), hint)
        codes_by_filename_hint.setdefault(key, set()).add(match["jis5"])

    still_unmatched: list[dict[str, Any]] = []
    for item in unmatched:
        file = file_by_page[item["page_id"]]
        hint = _normalize_english_name(_filename_english_hint(file["title"]))
        key = (str(file.get("prefecture_code") or ""), hint)
        sibling_codes = codes_by_filename_hint.get(key, set())
        if len(sibling_codes) == 1:
            matches.append(
                {
                    "jis5": next(iter(sibling_codes)),
                    "page_id": file["page_id"],
                    "method": "filename_variant_sibling",
                    "confidence": 0.9,
                    "title": file["title"],
                }
            )
        else:
            still_unmatched.append(item)
    return {"matches": matches, "unmatched": still_unmatched}


def enwiki_titles(files: list[dict[str, Any]]) -> set[str]:
    return {
        _normalize_article_title(usage["title"]).replace(" ", "_")
        for file in files
        for usage in file.get("global_usage", [])
        if usage["wiki"] == "en.wikipedia.org" and int(usage["ns"]) == 0
    }


def wikidata_item_ids(files: list[dict[str, Any]]) -> set[str]:
    return {
        _normalize_article_title(usage["title"])
        for file in files
        for usage in file.get("global_usage", [])
        if int(usage["ns"]) == 0
        and re.fullmatch(
            r"Q\d+",
            _normalize_article_title(usage["title"]),
        )
    }
