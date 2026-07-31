from __future__ import annotations

import json
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from hashlib import sha256
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlencode

from .http import polite_delay, request_json

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
JAWIKI_SUMMARY = "https://ja.wikipedia.org/api/rest_v1/page/summary"
P429_QUERY = """
SELECT ?item ?code WHERE {
  ?item wdt:P429 ?code .
  FILTER(REGEX(STR(?code), "^[0-9]{6}$"))
}
ORDER BY ?item
""".strip()

AREA_UNIT_TO_KM2 = {
    "Q712226": Decimal("1"),
    "Q25343": Decimal("0.000001"),
    "Q35852": Decimal("0.01"),
}


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


def municipality_profile_targets(
    connection: sqlite3.Connection,
    snapshot_date: str,
) -> list[dict[str, str]]:
    rows = connection.execute(
        """
        SELECT jis5, prefecture_code, display_name, municipality_name,
               entity_type
        FROM territory_versions
        WHERE snapshot_date = ?
          AND jis5 IS NOT NULL
          AND entity_type != 'unassigned'
        ORDER BY jis5
        """,
        (snapshot_date,),
    ).fetchall()
    if not rows:
        raise ValueError(f"No territory versions found for snapshot {snapshot_date}")
    targets: dict[str, dict[str, str]] = {}
    wards_by_city: dict[tuple[str, str], list[sqlite3.Row]] = {}
    for row in rows:
        if row["entity_type"] == "ward":
            wards_by_city.setdefault(
                (
                    str(row["prefecture_code"]),
                    str(row["municipality_name"]),
                ),
                [],
            ).append(row)
            continue
        jis5 = str(row["jis5"])
        targets.setdefault(
            jis5,
            {
                "jis5": jis5,
                "prefecture_code": str(row["prefecture_code"]),
                "display_name": str(row["display_name"]),
            },
        )
    for (prefecture_code, municipality_name), ward_rows in wards_by_city.items():
        minimum_jis5 = min(str(row["jis5"]) for row in ward_rows)
        jis5 = f"{int(minimum_jis5) // 10 * 10:05d}"
        targets[jis5] = {
            "jis5": jis5,
            "prefecture_code": prefecture_code,
            "display_name": municipality_name,
        }
    return sorted(targets.values(), key=lambda target: target["jis5"])


def _existing_item_mapping(
    connection: sqlite3.Connection,
) -> dict[str, str]:
    rows = connection.execute(
        """
        SELECT source_key, jis5
        FROM external_code_resolutions
        WHERE source_type = 'wikidata_item' AND jis5 IS NOT NULL
        ORDER BY source_key
        """
    ).fetchall()
    candidates: dict[str, list[str]] = {}
    for row in rows:
        candidates.setdefault(str(row["jis5"]), []).append(str(row["source_key"]))
    return {
        jis5: min(
            item_ids,
            key=lambda item_id: int(item_id.removeprefix("Q")),
        )
        for jis5, item_ids in candidates.items()
    }


def _fetch_p429_index(
    connection: sqlite3.Connection,
    *,
    refresh: bool,
) -> dict[str, Any]:
    cached = _cache_get(connection, "wikidata-p429-index", "all")
    if cached is not None and not refresh:
        return cached
    response = request_json(
        _api_url(
            WIKIDATA_SPARQL,
            query=P429_QUERY,
            format="json",
        )
    )
    with connection:
        _cache_put(connection, "wikidata-p429-index", "all", response)
    return response


def _mapping_from_p429_response(
    response: dict[str, Any],
) -> dict[str, str]:
    candidates: dict[str, list[str]] = {}
    for binding in response.get("results", {}).get("bindings", []):
        item_url = binding.get("item", {}).get("value", "")
        code = binding.get("code", {}).get("value", "")
        item_match = re.search(r"/(Q\d+)$", item_url)
        if not item_match or not re.fullmatch(r"\d{6}", code):
            continue
        candidates.setdefault(code[:5], []).append(item_match.group(1))
    return {
        jis5: sorted(
            item_ids,
            key=lambda item_id: int(item_id[1:]),
        )[0]
        for jis5, item_ids in candidates.items()
    }


def _fetch_entities(
    connection: sqlite3.Connection,
    item_ids: set[str],
    *,
    refresh: bool,
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    missing: list[str] = []
    for item_id in sorted(item_ids, key=lambda value: int(value[1:])):
        cached = _cache_get(connection, "wikidata-entity", item_id)
        if cached is not None and not refresh:
            result[item_id] = cached
        else:
            missing.append(item_id)
    for start in range(0, len(missing), 50):
        batch = missing[start : start + 50]
        response = request_json(
            _api_url(
                WIKIDATA_API,
                action="wbgetentities",
                format="json",
                formatversion="2",
                props="claims|sitelinks/urls",
                sitefilter="jawiki",
                ids="|".join(batch),
            )
        )
        entities = response.get("entities", {})
        with connection:
            for item_id in batch:
                entity = entities.get(item_id, {"id": item_id, "missing": True})
                _cache_put(
                    connection,
                    "wikidata-entity",
                    item_id,
                    entity,
                )
                result[item_id] = entity
        polite_delay(0.1)
    return result


def _claim_time(claim: dict[str, Any]) -> tuple[str | None, int | None]:
    qualifiers = claim.get("qualifiers", {}).get("P585", [])
    values: list[tuple[str, int]] = []
    for qualifier in qualifiers:
        value = qualifier.get("datavalue", {}).get("value")
        if not isinstance(value, dict) or not isinstance(value.get("time"), str):
            continue
        normalized = value["time"].removeprefix("+").split("T", 1)[0]
        values.append((normalized, int(value.get("precision", 0))))
    return max(values) if values else (None, None)


def _quantity_claim(
    entity: dict[str, Any],
    property_id: str,
) -> tuple[Decimal, str | None, int | None, str] | None:
    candidates = []
    for claim in entity.get("claims", {}).get(property_id, []):
        if claim.get("rank") == "deprecated":
            continue
        value = claim.get("mainsnak", {}).get("datavalue", {}).get("value")
        if not isinstance(value, dict) or "amount" not in value:
            continue
        try:
            amount = Decimal(str(value["amount"]))
        except InvalidOperation:
            continue
        date, precision = _claim_time(claim)
        rank_order = 0 if claim.get("rank") == "preferred" else 1
        date_order = (
            tuple(-int(part) for part in date.split("-")) if date else (0, 0, 0)
        )
        candidates.append(
            (
                rank_order,
                0 if date else 1,
                date_order,
                str(claim.get("id", "")),
                amount,
                date,
                precision,
                str(value.get("unit", "1")),
            )
        )
    if not candidates:
        return None
    selected = min(candidates)
    return selected[4], selected[5], selected[6], selected[7]


def profile_values_from_entity(
    entity: dict[str, Any],
) -> dict[str, Any]:
    population_claim = _quantity_claim(entity, "P1082")
    population = None
    population_as_of = None
    population_precision = None
    if population_claim and population_claim[0] >= 0:
        population = int(population_claim[0])
        population_as_of = population_claim[1]
        population_precision = population_claim[2]

    area_claim = _quantity_claim(entity, "P2046")
    area_km2 = None
    if area_claim and area_claim[0] >= 0:
        unit_id = area_claim[3].rsplit("/", 1)[-1]
        conversion = AREA_UNIT_TO_KM2.get(unit_id)
        if conversion is not None:
            area_km2 = float(area_claim[0] * conversion)

    sitelink = entity.get("sitelinks", {}).get("jawiki", {})
    return {
        "population": population,
        "population_as_of": population_as_of,
        "population_date_precision": population_precision,
        "area_km2": area_km2,
        "jawiki_title": sitelink.get("title"),
        "jawiki_url": sitelink.get("url"),
    }


def _request_jawiki_summary(title: str) -> dict[str, Any]:
    try:
        return request_json(f"{JAWIKI_SUMMARY}/{quote(title, safe='')}")
    except HTTPError as error:
        if error.code != 404:
            raise
        return {"title": title, "missing": True}


def _fetch_jawiki_summaries(
    connection: sqlite3.Connection,
    titles: set[str],
    *,
    refresh: bool,
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    missing: list[str] = []
    for title in sorted(titles):
        cached = _cache_get(connection, "jawiki-summary", title)
        if cached is not None and not refresh:
            result[title] = cached
        else:
            missing.append(title)
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(_request_jawiki_summary, title): title for title in missing
        }
        for future in as_completed(futures):
            title = futures[future]
            summary = future.result()
            with connection:
                _cache_put(
                    connection,
                    "jawiki-summary",
                    title,
                    summary,
                )
            result[title] = summary
    return result


def _summary_values(summary: dict[str, Any]) -> dict[str, str | None]:
    url = summary.get("content_urls", {}).get("desktop", {}).get("page")
    extract = summary.get("extract")
    return {
        "jawiki_title": summary.get("title"),
        "jawiki_url": url if isinstance(url, str) else None,
        "wikipedia_extract": (
            re.sub(r"\s+", " ", extract).strip() if isinstance(extract, str) else None
        ),
    }


def ingest_municipality_profiles(
    connection: sqlite3.Connection,
    *,
    snapshot_date: str,
    refresh: bool = False,
    jis5_filter: set[str] | None = None,
) -> dict[str, Any]:
    targets = municipality_profile_targets(connection, snapshot_date)
    if jis5_filter:
        unknown = jis5_filter - {target["jis5"] for target in targets}
        if unknown:
            raise ValueError(
                f"Unknown profile target codes: {', '.join(sorted(unknown))}"
            )
        targets = [target for target in targets if target["jis5"] in jis5_filter]

    mapping = _existing_item_mapping(connection)
    unresolved = {target["jis5"] for target in targets if target["jis5"] not in mapping}
    if unresolved:
        discovered = _mapping_from_p429_response(
            _fetch_p429_index(connection, refresh=refresh)
        )
        for jis5 in unresolved:
            item_id = discovered.get(jis5)
            if not item_id:
                continue
            mapping[jis5] = item_id
            with connection:
                connection.execute(
                    """
                    INSERT INTO external_code_resolutions(
                      source_type, source_key, jis5, fetched_at
                    ) VALUES ('wikidata_item', ?, ?, ?)
                    ON CONFLICT(source_type, source_key) DO UPDATE SET
                      jis5=excluded.jis5,
                      fetched_at=excluded.fetched_at
                    """,
                    (item_id, jis5, _now()),
                )

    item_ids = {
        mapping[target["jis5"]] for target in targets if target["jis5"] in mapping
    }
    entities = _fetch_entities(connection, item_ids, refresh=refresh)
    entity_values = {
        item_id: profile_values_from_entity(entity)
        for item_id, entity in entities.items()
        if not entity.get("missing")
    }
    summaries = _fetch_jawiki_summaries(
        connection,
        {
            str(values["jawiki_title"])
            for values in entity_values.values()
            if values["jawiki_title"]
        },
        refresh=refresh,
    )
    rows = []
    fetched_at = _now()
    for target in targets:
        item_id = mapping.get(target["jis5"])
        entity = entities.get(item_id) if item_id else None
        if not item_id or not entity or entity.get("missing"):
            rows.append(
                {
                    **target,
                    "resolution_status": "unresolved",
                    "wikidata_item_id": None,
                    "jawiki_title": None,
                    "jawiki_url": None,
                    "wikipedia_extract": None,
                    "population": None,
                    "population_as_of": None,
                    "population_date_precision": None,
                    "area_km2": None,
                    "wikidata_url": None,
                }
            )
            continue
        values = entity_values[item_id]
        title = values["jawiki_title"]
        if isinstance(title, str):
            summary = summaries[title]
            summary_values = _summary_values(summary)
            values.update(
                {
                    key: value
                    for key, value in summary_values.items()
                    if value is not None
                }
            )
        rows.append(
            {
                **target,
                **values,
                "resolution_status": "resolved",
                "wikidata_item_id": item_id,
                "wikidata_url": f"https://www.wikidata.org/wiki/{item_id}",
                "wikipedia_extract": values.get("wikipedia_extract"),
            }
        )

    with connection:
        if jis5_filter:
            connection.executemany(
                """
                DELETE FROM municipality_profiles
                WHERE snapshot_date = ? AND jis5 = ?
                """,
                [(snapshot_date, row["jis5"]) for row in rows],
            )
        else:
            connection.execute(
                "DELETE FROM municipality_profiles WHERE snapshot_date = ?",
                (snapshot_date,),
            )
        connection.executemany(
            """
            INSERT INTO municipality_profiles(
              snapshot_date, jis5, resolution_status, wikidata_item_id,
              jawiki_title, jawiki_url, wikipedia_extract, population,
              population_as_of, population_date_precision, area_km2,
              wikidata_url, fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    snapshot_date,
                    row["jis5"],
                    row["resolution_status"],
                    row["wikidata_item_id"],
                    row["jawiki_title"],
                    row["jawiki_url"],
                    row["wikipedia_extract"],
                    row["population"],
                    row["population_as_of"],
                    row["population_date_precision"],
                    row["area_km2"],
                    row["wikidata_url"],
                    fetched_at,
                )
                for row in rows
            ],
        )

    return {
        "snapshot_date": snapshot_date,
        "profiles": len(rows),
        "resolved": sum(row["resolution_status"] == "resolved" for row in rows),
        "population": sum(row["population"] is not None for row in rows),
        "area": sum(row["area_km2"] is not None for row in rows),
        "jawiki": sum(row["jawiki_url"] is not None for row in rows),
        "extract": sum(row["wikipedia_extract"] is not None for row in rows),
    }
