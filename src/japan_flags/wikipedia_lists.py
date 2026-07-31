from __future__ import annotations

import json
import re
import sqlite3
from collections import defaultdict
from datetime import UTC, datetime
from hashlib import sha256
from typing import Any, Iterable
from urllib.parse import quote, urlencode

from .http import polite_delay, request_json

JAWIKI_API = "https://ja.wikipedia.org/w/api.php"

EMBLEM_CATEGORY = "Category:市町村章"
FLAG_CATEGORY = "Category:市町村旗"

LIST_PAGE_TITLE_RE = re.compile(r"^[^:]+の(市町村章|市町村旗)一覧$")

HEADING_RE = re.compile(r"^==\s*([^=].*?)\s*==\s*$", re.MULTILINE)

DATE_LINK_RE = re.compile(
    r"\[\[(?P<year>\d{1,4})年\]\]\s*"
    r"(?:\[\[(?P<month>\d{1,2})月(?P<day>\d{1,2})日\]\]|\[\[(?P<month_only>\d{1,2})月\]\])?"
)

APPROX_DATE_RE = re.compile(r"\[\[(\d{1,4})年\]\]頃")
YEAR_ONLY_RE = re.compile(r"\[\[(\d{1,4})年\]\]")

LINK_RE = re.compile(r"\[\[(?P<target>[^|\]]+)(?:\|(?P<text>[^\]]+))?\]\]")

FILE_RE = re.compile(r"\[\[(?:File|ファイル):(?P<name>[^|\]]+?)(?:\|[^\]]*)?\]\]")

REF_TAG_RE = re.compile(
    r"<ref(?:\s[^>]*)?\s*/>|<ref(?:\s[^>]*)?>.*?</ref>",
    re.DOTALL,
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _api_url(base: str, **parameters: str) -> str:
    return f"{base}?{urlencode(parameters)}"


def _cache_get(
    connection: sqlite3.Connection,
    provider: str,
    source_key: str,
) -> dict[str, Any] | None:
    row = connection.execute(
        """
        SELECT payload_json
        FROM external_entity_cache
        WHERE provider = ? AND source_key = ?
        """,
        (provider, source_key),
    ).fetchone()
    return json.loads(row[0]) if row else None


def _cache_put(
    connection: sqlite3.Connection,
    provider: str,
    source_key: str,
    payload: dict[str, Any],
) -> None:
    payload_json = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    connection.execute(
        """
        INSERT INTO external_entity_cache(
          provider, source_key, payload_json, content_sha256, fetched_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider, source_key) DO UPDATE SET
          payload_json=excluded.payload_json,
          content_sha256=excluded.content_sha256,
          fetched_at=excluded.fetched_at
        """,
        (
            provider,
            source_key,
            payload_json,
            sha256(payload_json.encode()).hexdigest(),
            _now(),
        ),
    )


def fetch_category_titles(
    connection: sqlite3.Connection,
    category: str,
    *,
    refresh: bool = False,
) -> list[str]:
    cached = _cache_get(connection, "jawiki-categorymembers", category)
    if cached is not None and not refresh:
        return [str(title) for title in cached.get("titles", [])]
    titles: list[str] = []
    for namespace in (0,):
        cmcontinue: str | None = None
        while True:
            parameters: dict[str, str] = {
                "action": "query",
                "format": "json",
                "formatversion": "2",
                "list": "categorymembers",
                "cmtitle": category,
                "cmnamespace": str(namespace),
                "cmlimit": "50",
            }
            if cmcontinue:
                parameters["cmcontinue"] = cmcontinue
            response = request_json(_api_url(JAWIKI_API, **parameters))
            for member in response.get("query", {}).get("categorymembers", []):
                title = str(member.get("title", ""))
                if LIST_PAGE_TITLE_RE.match(title):
                    titles.append(title)
            payload_continue = response.get("continue", {})
            cmcontinue = payload_continue.get("cmcontinue")
            if not cmcontinue:
                break
            polite_delay(0.1)
    with connection:
        _cache_put(
            connection,
            "jawiki-categorymembers",
            category,
            {"titles": sorted(set(titles))},
        )
    return sorted(set(titles))


def fetch_page_wikitext(
    connection: sqlite3.Connection,
    title: str,
    *,
    refresh: bool = False,
) -> str:
    cached = _cache_get(connection, "jawiki-parse", title)
    if cached is not None and not refresh:
        return str(cached.get("wikitext", ""))
    response = request_json(
        _api_url(
            JAWIKI_API,
            action="parse",
            format="json",
            formatversion="2",
            prop="wikitext",
            page=title,
        )
    )
    wikitext = str(response.get("parse", {}).get("wikitext", ""))
    with connection:
        _cache_put(
            connection,
            "jawiki-parse",
            title,
            {"wikitext": wikitext},
        )
    polite_delay(0.1)
    return wikitext


def _strip_wiki_markup(text: str) -> str:
    cleaned = REF_TAG_RE.sub("", text)
    cleaned = cleaned.replace("'''", "").replace("''", "")
    cleaned = cleaned.replace("&nbsp;", " ")
    cleaned = re.sub(r"<br\s*/?>", " ", cleaned)
    cleaned = LINK_RE.sub(lambda m: m.group("text") or m.group("target"), cleaned)
    cleaned = re.sub(r"\{\{[^{}]*\}\}", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def _first_link_target(cell: str) -> tuple[str | None, str | None]:
    for match in LINK_RE.finditer(cell):
        target = match.group("target")
        text = (match.group("text") or match.group("target")).strip()
        if not target.startswith("File:") and not target.startswith("ファイル:"):
            return target, text
    return None, None


def _first_file_name(cell: str) -> str | None:
    match = FILE_RE.search(cell)
    if not match:
        return None
    return match.group("name").strip()


def _parse_date_cell(cell: str) -> dict[str, Any]:
    cell = REF_TAG_RE.sub("", cell)
    cell = cell.strip()
    if not cell:
        return {
            "enacted_on": None,
            "enacted_year": None,
            "enacted_month": None,
            "enacted_day": None,
            "enacted_precision": "empty",
        }
    if cell == "不明":
        return {
            "enacted_on": None,
            "enacted_year": None,
            "enacted_month": None,
            "enacted_day": None,
            "enacted_precision": "unknown",
        }
    full = DATE_LINK_RE.search(cell)
    if full and full.group("day"):
        year = int(full.group("year"))
        month = int(full.group("month"))
        day = int(full.group("day"))
        return {
            "enacted_on": f"{year:04d}-{month:02d}-{day:02d}",
            "enacted_year": year,
            "enacted_month": month,
            "enacted_day": day,
            "enacted_precision": "day",
        }
    if full and full.group("month_only"):
        year = int(full.group("year"))
        month = int(full.group("month_only"))
        return {
            "enacted_on": f"{year:04d}-{month:02d}",
            "enacted_year": year,
            "enacted_month": month,
            "enacted_day": None,
            "enacted_precision": "month",
        }
    approx = APPROX_DATE_RE.search(cell)
    if approx:
        year = int(approx.group(1))
        return {
            "enacted_on": f"{year:04d}",
            "enacted_year": year,
            "enacted_month": None,
            "enacted_day": None,
            "enacted_precision": "approximate",
        }
    bare = YEAR_ONLY_RE.search(cell)
    if bare:
        year = int(bare.group(1))
        return {
            "enacted_on": f"{year:04d}",
            "enacted_year": year,
            "enacted_month": None,
            "enacted_day": None,
            "enacted_precision": "year",
        }
    return {
        "enacted_on": None,
        "enacted_year": None,
        "enacted_month": None,
        "enacted_day": None,
        "enacted_precision": "unknown",
    }


def _split_table_cells(row_body: str) -> list[str]:
    cells: list[str] = []
    current: list[str] = []
    bracket_depth = 0
    brace_depth = 0
    angle_depth = 0
    is_cell_start = True
    i = 0
    while i < len(row_body):
        ch = row_body[i]
        nxt = row_body[i + 1] if i + 1 < len(row_body) else ""
        nxt2 = row_body[i + 2] if i + 2 < len(row_body) else ""
        if ch == "[" and nxt == "[":
            bracket_depth += 1
            current.append("[[")
            i += 2
            is_cell_start = False
            continue
        if ch == "]" and nxt == "]":
            if bracket_depth > 0:
                bracket_depth -= 1
            current.append("]]")
            i += 2
            is_cell_start = False
            continue
        if ch == "{" and nxt == "{":
            brace_depth += 1
            current.append("{{")
            i += 2
            is_cell_start = False
            continue
        if ch == "}" and nxt == "}":
            if brace_depth > 0:
                brace_depth -= 1
            current.append("}}")
            i += 2
            is_cell_start = False
            continue
        if ch == "<" and nxt == "/" and nxt2.isalpha():
            if angle_depth > 0:
                angle_depth -= 1
            current.append("<")
            i += 1
            is_cell_start = False
            continue
        if ch == "<" and nxt != "/" and nxt != "!":
            angle_depth += 1
        if ch == "/" and nxt == ">":
            if angle_depth > 0:
                angle_depth -= 1
        if ch == "|" and bracket_depth == 0 and brace_depth == 0 and angle_depth == 0:
            if is_cell_start:
                is_cell_start = False
                i += 1
                continue
            cells.append("".join(current))
            current = []
            is_cell_start = True
            i += 1
            continue
        current.append(ch)
        is_cell_start = False
        i += 1
    cells.append("".join(current))
    return cells


HTML_ATTRIBUTE_RE = re.compile(
    r"^\s*(?:style|class|rowspan|colspan|align|valign|width|height|"
    r"bgcolor|scope|id)\s*=\s*['\"][^'\"]*['\"]\s*$"
)


def _filter_html_attributes(cells: list[str]) -> list[str]:
    return [cell for cell in cells if not HTML_ATTRIBUTE_RE.match(cell)]


def _iter_table_rows(wikitext: str) -> Iterable[list[str]]:
    for table in re.finditer(r"\{\|.*?\n\|\}", wikitext, re.DOTALL):
        body = table.group(0)
        for row_match in re.finditer(
            r"\|\-[^\n]*\n(.*?)(?=\n\|\-[^\n]*|\n\|\})", body, re.DOTALL
        ):
            row_text = row_match.group(1)
            if row_text.lstrip().startswith("!"):
                continue
            cells = _split_table_cells(row_text.strip())
            if cells and cells[0].startswith("|"):
                cells[0] = cells[0][1:]
            cells = [cell.strip() for cell in cells]
            cells = _filter_html_attributes(cells)
            if not any(cell for cell in cells):
                continue
            first_meaningful = next((c for c in cells if c), None)
            if first_meaningful in {None, "-", "|"}:
                continue
            yield cells


def _detect_section_kind(heading: str) -> str:
    if (
        heading.startswith("市部")
        or "市部" in heading
        or heading == "概要"
        or "概要" in heading
    ):
        if "市" in heading and ("市部" in heading or heading.endswith("市")):
            return "city"
    if heading.startswith("町村部") or heading.startswith("郡部"):
        return "town"
    if "廃止" in heading or "廃置" in heading:
        return "abandoned"
    return ""


def _detect_list_kind(title: str) -> str | None:
    if title.endswith("の市町村章一覧"):
        return "emblem"
    if title.endswith("の市町村旗一覧"):
        return "flag"
    if "の区市町村章一覧" in title:
        return "emblem"
    if "の区市町村旗一覧" in title:
        return "flag"
    return None


def _parse_flag_color(cell: str) -> tuple[str | None, str | None]:
    text = _strip_wiki_markup(cell)
    if not text:
        return None, None
    ground = None
    emblem = None
    ground_match = re.search(r"地色は?([^、。]+?)(?:であり|で|が|を|、|。|$)", text)
    if ground_match:
        ground = ground_match.group(1).strip() or None
    emblem_match = re.search(
        r"(?:紋章|紋)(?:は|が)?([^、。]+?)(?:が指定され|であり|で|が|を|、|。|$)",
        text,
    )
    if emblem_match:
        emblem = emblem_match.group(1).strip() or None
    return ground, emblem


def _row_origin_text(cell: str) -> str | None:
    text = _strip_wiki_markup(cell)
    return text or None


def parse_list_page(title: str, wikitext: str) -> list[dict[str, Any]]:
    kind = _detect_list_kind(title)
    if kind is None:
        return []
    prefecture_match = re.match(r"^(?:東京都)?(.+?)(?:の区)?の市町村[章旗]一覧$", title)
    prefecture_name = prefecture_match.group(1) if prefecture_match else None
    rows: list[dict[str, Any]] = []
    inherited_district: str | None = None
    for section_match in HEADING_RE.finditer(wikitext):
        heading = section_match.group(1).strip()
        section_kind = _detect_section_kind(heading)
        if section_kind not in {"city", "town", "abandoned"}:
            continue
        section_start = section_match.end()
        next_match = HEADING_RE.search(wikitext, section_start)
        section_end = next_match.start() if next_match else len(wikitext)
        section_text = wikitext[section_start:section_end]
        for cells in _iter_table_rows(section_text):
            if kind == "emblem":
                row = _parse_emblem_row(
                    cells, section_kind, heading, inherited_district
                )
            else:
                row = _parse_flag_row(cells, section_kind, heading, inherited_district)
            if row is None:
                continue
            row["prefecture_name"] = prefecture_name
            if row["prefecture_section"]:
                inherited_district = row["prefecture_section"]
            rows.append(row)
    return rows


def _district_aware_cells(
    cells: list[str], inherited_district: str | None
) -> tuple[str | None, list[str]]:
    """Return (district, rest_cells) where rest starts at the name cell."""
    if not cells:
        return inherited_district, cells
    if _looks_like_rowspan_only(cells[0]) and len(cells) >= 2:
        district_name, _ = _extract_district(cells[1])
        if district_name:
            return district_name, cells[2:]
    if _looks_like_district(cells[0]):
        district_name, _ = _extract_district(cells[0])
        return district_name or inherited_district, cells[1:]
    if len(cells) >= 2 and _looks_like_district(cells[1]):
        district_name, _ = _extract_district(cells[1])
        return district_name or inherited_district, [cells[0]] + cells[2:]
    return inherited_district, cells


def _looks_like_rowspan_only(cell: str) -> bool:
    if not re.match(r"^\s*\|?\s*rowspan", cell):
        return False
    return not _first_link_target(cell)[0]


def _looks_like_district(cell: str) -> bool:
    if "rowspan" in cell:
        return True
    text = _strip_wiki_markup(cell)
    return text.endswith("郡") or text.endswith("振興局") or text.endswith("支庁")


def _extract_district(cell: str) -> tuple[str | None, str | None]:
    target, text = _first_link_target(cell)
    if text is not None:
        if "rowspan" in cell:
            text = re.sub(r"\s*\|\s*rowspan=[^\|]*", "", text)
        return text or None, target
    if "rowspan" in cell:
        cleaned = re.sub(r"^\s*\|?\s*rowspan=\"?\d+\"?\s*", "", cell)
        target2, text2 = _first_link_target(cleaned)
        if text2 is not None:
            return text2, target2
    text = _strip_wiki_markup(cell)
    if "rowspan" in text:
        text = re.sub(r"rowspan=\d+", "", text).strip()
    return text or None, target


def _parse_emblem_row(
    cells: list[str],
    section_kind: str,
    heading: str,
    inherited_district: str | None,
) -> dict[str, Any] | None:
    if section_kind == "abandoned":
        if len(cells) < 5:
            return None
        district_name, rest = _district_aware_cells(cells, inherited_district)
        if len(rest) < 4:
            return None
        name_cell = rest[0]
        file_cell = rest[1]
        origin_cell = rest[2]
        date_cell = rest[3]
        abandoned_date_cell = rest[4] if len(rest) > 4 else ""
    elif section_kind == "town":
        district_name, rest = _district_aware_cells(cells, inherited_district)
        if len(rest) < 4:
            return None
        name_cell = rest[0]
        file_cell = rest[1]
        origin_cell = rest[2]
        date_cell = rest[3]
        abandoned_date_cell = ""
    else:
        if len(cells) < 4:
            return None
        district_name = None
        name_cell = cells[0]
        file_cell = cells[1]
        origin_cell = cells[2]
        date_cell = cells[3]
        abandoned_date_cell = ""
    article_title, display_name = _first_link_target(name_cell)
    if display_name is None:
        display_name = _strip_wiki_markup(name_cell)
    if not display_name:
        return None
    date = _parse_date_cell(date_cell)
    abandoned_date = _parse_date_cell(abandoned_date_cell)
    if abandoned_date["enacted_precision"] == "empty":
        abandoned_date = {**abandoned_date, "enacted_year": None, "enacted_on": None}
    return {
        "section_kind": section_kind,
        "prefecture_section": district_name,
        "display_name": display_name,
        "article_title": article_title,
        "file_name": _first_file_name(file_cell),
        "has_attribute": 1,
        "enacted_on": date["enacted_on"],
        "enacted_year": date["enacted_year"],
        "enacted_month": date["enacted_month"],
        "enacted_day": date["enacted_day"],
        "enacted_precision": date["enacted_precision"],
        "abandoned_on": abandoned_date["enacted_on"],
        "abandoned_year": abandoned_date["enacted_year"],
        "origin_text": _row_origin_text(origin_cell),
        "flag_ground_color": None,
        "flag_emblem_color": None,
        "source_section": heading,
    }


def _parse_flag_row(
    cells: list[str],
    section_kind: str,
    heading: str,
    inherited_district: str | None,
) -> dict[str, Any] | None:
    if section_kind == "town":
        district_name, rest = _district_aware_cells(cells, inherited_district)
        if len(rest) < 4:
            return None
        name_cell = rest[0]
        file_cell = rest[1]
        presence_cell = rest[2]
        date_cell = rest[3]
        color_cell = rest[4] if len(rest) > 4 else ""
    else:
        if len(cells) < 4:
            return None
        district_name = None
        name_cell = cells[0]
        file_cell = cells[1]
        presence_cell = cells[2]
        date_cell = cells[3]
        color_cell = cells[4] if len(cells) > 4 else ""
    article_title, display_name = _first_link_target(name_cell)
    if display_name is None:
        display_name = _strip_wiki_markup(name_cell)
    if not display_name:
        return None
    presence_text = _strip_wiki_markup(presence_cell)
    has_attribute = 0 if "なし" in presence_text else 1
    date = _parse_date_cell(date_cell)
    ground, emblem = _parse_flag_color(color_cell)
    return {
        "section_kind": section_kind,
        "prefecture_section": district_name,
        "display_name": display_name,
        "article_title": article_title,
        "file_name": _first_file_name(file_cell),
        "has_attribute": has_attribute,
        "enacted_on": date["enacted_on"],
        "enacted_year": date["enacted_year"],
        "enacted_month": date["enacted_month"],
        "enacted_day": date["enacted_day"],
        "enacted_precision": date["enacted_precision"],
        "abandoned_on": None,
        "abandoned_year": None,
        "origin_text": None,
        "flag_ground_color": ground,
        "flag_emblem_color": emblem,
        "source_section": heading,
    }


def _build_jis5_index(
    connection: sqlite3.Connection,
    snapshot_date: str,
) -> dict[tuple[str, str], list[tuple[str, str, str]]]:
    """Return {(prefecture_code, name): [(jis5, municipality_name, display_name), ...]}."""
    rows = connection.execute(
        """
        SELECT jis5, prefecture_code, prefecture_name, municipality_name,
               ward_name, display_name, entity_type
        FROM territory_versions
        WHERE snapshot_date = ? AND jis5 IS NOT NULL
        """,
        (snapshot_date,),
    ).fetchall()
    by_prefecture: dict[str, dict[str, list[tuple[str, str, str]]]] = defaultdict(
        lambda: defaultdict(list)
    )
    by_prefecture_name: dict[tuple[str, str], list[tuple[str, str, str]]] = {}
    for row in rows:
        jis5 = str(row["jis5"])
        prefecture_code = str(row["prefecture_code"])
        municipality_name = str(row["municipality_name"])
        ward_name = row["ward_name"]
        display_name = str(row["display_name"])
        entity_type = str(row["entity_type"])
        if entity_type == "municipality" and ward_name is None:
            by_prefecture[prefecture_code][municipality_name].append(
                (jis5, municipality_name, display_name)
            )
            by_prefecture_name[(prefecture_code, municipality_name)] = by_prefecture[
                prefecture_code
            ][municipality_name]
        if entity_type == "ward":
            by_prefecture[prefecture_code][municipality_name].append(
                (jis5, municipality_name, display_name)
            )
            by_prefecture_name[(prefecture_code, municipality_name)] = by_prefecture[
                prefecture_code
            ][municipality_name]
        if entity_type == "special_ward":
            by_prefecture[prefecture_code][display_name].append(
                (jis5, display_name, display_name)
            )
            by_prefecture_name[(prefecture_code, display_name)] = by_prefecture[
                prefecture_code
            ][display_name]
    return by_prefecture_name


def _resolve_jis5(
    index: dict[tuple[str, str], list[tuple[str, str, str]]],
    prefecture_code: str,
    name: str,
) -> tuple[str | None, str | None]:
    matches = index.get((prefecture_code, name))
    if not matches:
        return None, "no_match"
    if len(matches) == 1:
        return matches[0][0], None
    parent_municipality_names = {match[1] for match in matches}
    if len(parent_municipality_names) == 1:
        first_jis5 = matches[0][0]
        if first_jis5.endswith("0"):
            return first_jis5, None
        return first_jis5[:-1] + "0", None
    return None, "ambiguous"


def _prefecture_code_from_name(
    connection: sqlite3.Connection,
    prefecture_name: str,
) -> str | None:
    row = connection.execute(
        "SELECT prefecture_code FROM territory_versions WHERE prefecture_name = ? LIMIT 1",
        (prefecture_name,),
    ).fetchone()
    if row is None:
        return None
    return str(row["prefecture_code"])


def ingest_wikipedia_lists(
    connection: sqlite3.Connection,
    *,
    snapshot_date: str = "20260101",
    kinds: tuple[str, ...] = ("emblem", "flag"),
    refresh_titles: bool = False,
    refresh_pages: bool = False,
) -> dict[str, Any]:
    index = _build_jis5_index(connection, snapshot_date)
    fetched_at = _now()
    total_upserted = 0
    pages_processed = 0
    titles_processed: list[str] = []
    per_kind_stats: dict[str, dict[str, int]] = {}
    for kind in kinds:
        category = EMBLEM_CATEGORY if kind == "emblem" else FLAG_CATEGORY
        titles = fetch_category_titles(connection, category, refresh=refresh_titles)
        for title in titles:
            wikitext = fetch_page_wikitext(connection, title, refresh=refresh_pages)
            rows = parse_list_page(title, wikitext)
            if not rows:
                continue
            pages_processed += 1
            titles_processed.append(title)
            prefecture_name = rows[0].get("prefecture_name")
            prefecture_code = None
            if prefecture_name:
                prefecture_code = _prefecture_code_from_name(
                    connection, prefecture_name
                )
            if prefecture_code is None:
                prefecture_code = "00"
            upserted = _upsert_rows(
                connection,
                kind=kind,
                rows=rows,
                prefecture_code=prefecture_code,
                source_list_title=title,
                source_url=(
                    "https://ja.wikipedia.org/wiki/"
                    f"{quote(title.replace(' ', '_'), safe='()_')}"
                ),
                fetched_at=fetched_at,
                jis5_index=index,
            )
            total_upserted += upserted
            per_kind_stats.setdefault(
                kind, {"pages": 0, "rows": 0, "resolved": 0, "unresolved": 0}
            )
            per_kind_stats[kind]["pages"] += 1
            per_kind_stats[kind]["rows"] += upserted
        connection.commit()
    resolution_counts = {kind: _count_resolution(connection, kind) for kind in kinds}
    return {
        "snapshot_date": snapshot_date,
        "pages_processed": pages_processed,
        "titles": titles_processed,
        "rows_upserted": total_upserted,
        "per_kind": per_kind_stats,
        "resolution": resolution_counts,
        "fetched_at": fetched_at,
    }


def _count_resolution(connection: sqlite3.Connection, kind: str) -> dict[str, int]:
    rows = connection.execute(
        """
        SELECT resolution_status, COUNT(*) AS count
        FROM municipality_wiki_attributes
        WHERE kind = ?
        GROUP BY resolution_status
        """,
        (kind,),
    ).fetchall()
    return {str(row["resolution_status"]): int(row["count"]) for row in rows}


def _upsert_rows(
    connection: sqlite3.Connection,
    *,
    kind: str,
    rows: list[dict[str, Any]],
    prefecture_code: str,
    source_list_title: str,
    source_url: str,
    fetched_at: str,
    jis5_index: dict[tuple[str, str], list[tuple[str, str, str]]],
) -> int:
    with connection:
        connection.execute(
            """
            DELETE FROM municipality_wiki_attributes
            WHERE kind = ? AND source_list_title = ?
            """,
            (kind, source_list_title),
        )
        inserted = 0
        for row in rows:
            target_jis5: str | None = None
            note: str | None = None
            if row["section_kind"] != "abandoned":
                target_jis5, note = _resolve_jis5(
                    jis5_index, prefecture_code, row["display_name"]
                )
            status = "resolved" if target_jis5 else "unresolved"
            connection.execute(
                """
                INSERT INTO municipality_wiki_attributes(
                  jis5, prefecture_code, kind, section_kind,
                  prefecture_section, display_name, article_title,
                  has_attribute, enacted_on, enacted_year, enacted_month,
                  enacted_day, enacted_precision, abandoned_on, abandoned_year,
                  origin_text, flag_ground_color, flag_emblem_color,
                  file_name, source_list_title, source_url,
                  resolution_status, resolution_note, fetched_at
                ) VALUES (
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    target_jis5,
                    prefecture_code,
                    kind,
                    row["section_kind"],
                    row["prefecture_section"],
                    row["display_name"],
                    row["article_title"],
                    row["has_attribute"],
                    row["enacted_on"],
                    row["enacted_year"],
                    row["enacted_month"],
                    row["enacted_day"],
                    row["enacted_precision"],
                    row["abandoned_on"],
                    row["abandoned_year"],
                    row["origin_text"],
                    row["flag_ground_color"],
                    row["flag_emblem_color"],
                    row["file_name"],
                    source_list_title,
                    source_url,
                    status,
                    note,
                    fetched_at,
                ),
            )
            inserted += 1
    return inserted
