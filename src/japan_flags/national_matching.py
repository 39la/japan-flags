from __future__ import annotations

import json
import sqlite3
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .commons import fetch_global_usage
from .database import ingest_matches
from .http import polite_delay
from .known_current_flags import known_current_flag_matches
from .matching import (
    enwiki_titles,
    match_commons_files_to_municipalities,
    wikidata_item_ids,
)
from .wikidata import (
    fetch_wikidata_codes_for_enwiki_titles,
    fetch_wikidata_codes_for_item_ids,
)


def _current_asset_rows(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT a.page_id, a.commons_title, c.prefecture_code
        FROM flag_assets a
        JOIN flag_asset_catalog c ON c.page_id = a.page_id
        WHERE c.lifecycle_status = 'current'
        ORDER BY a.page_id
        """
    ).fetchall()


def _usage_targets(
    connection: sqlite3.Connection,
    *,
    refresh: bool,
) -> list[dict[str, Any]]:
    rows = _current_asset_rows(connection)
    fetched = {
        int(row[0])
        for row in connection.execute(
            "SELECT page_id FROM flag_asset_usage_fetches"
        ).fetchall()
    }
    return [
        {
            "page_id": int(row["page_id"]),
            "title": row["commons_title"],
        }
        for row in rows
        if refresh or int(row["page_id"]) not in fetched
    ]


def _store_usage_batch(
    connection: sqlite3.Connection,
    usages_by_page: dict[int, list[dict[str, Any]]],
) -> None:
    fetched_at = datetime.now(UTC).isoformat()
    with connection:
        for page_id, usages in usages_by_page.items():
            connection.execute(
                "DELETE FROM flag_asset_global_usage WHERE page_id = ?",
                (page_id,),
            )
            connection.executemany(
                """
                INSERT INTO flag_asset_global_usage(
                  page_id, wiki, page_title, page_url, namespace
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    (
                        page_id,
                        usage["wiki"],
                        usage["title"],
                        usage.get("url"),
                        int(usage["ns"]),
                    )
                    for usage in usages
                ),
            )
            connection.execute(
                """
                INSERT INTO flag_asset_usage_fetches(
                  page_id, fetched_at, usage_count
                ) VALUES (?, ?, ?)
                ON CONFLICT(page_id) DO UPDATE SET
                  fetched_at=excluded.fetched_at,
                  usage_count=excluded.usage_count
                """,
                (page_id, fetched_at, len(usages)),
            )


def fetch_missing_current_usage(
    connection: sqlite3.Connection,
    *,
    refresh: bool = False,
) -> dict[str, int]:
    targets = _usage_targets(connection, refresh=refresh)
    batch_size = 40
    batch_count = (len(targets) + batch_size - 1) // batch_size
    usage_count = 0
    for batch_number, start in enumerate(range(0, len(targets), batch_size), 1):
        batch = targets[start : start + batch_size]
        usages = fetch_global_usage(batch)
        _store_usage_batch(connection, usages)
        usage_count += sum(len(items) for items in usages.values())
        if batch_number == 1 or batch_number % 10 == 0 or batch_number == batch_count:
            print(
                f"  Commons usage batches {batch_number}/{batch_count}",
                flush=True,
            )
        if batch_number < batch_count:
            polite_delay(0.1)
    return {
        "requested_assets": len(targets),
        "fetched_usages": usage_count,
    }


def _matching_files(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = _current_asset_rows(connection)
    usages_by_page: dict[int, list[dict[str, Any]]] = {}
    for usage in connection.execute(
        """
        SELECT page_id, wiki, page_title, page_url, namespace
        FROM flag_asset_global_usage
        ORDER BY page_id, wiki, page_title
        """
    ).fetchall():
        usages_by_page.setdefault(int(usage["page_id"]), []).append(
            {
                "wiki": usage["wiki"],
                "title": usage["page_title"],
                "url": usage["page_url"],
                "ns": int(usage["namespace"]),
            }
        )
    return [
        {
            "page_id": int(row["page_id"]),
            "title": row["commons_title"],
            "prefecture_code": row["prefecture_code"],
            "global_usage": usages_by_page.get(int(row["page_id"]), []),
        }
        for row in rows
    ]


def _municipalities(
    connection: sqlite3.Connection,
    snapshot_date: str,
) -> list[dict[str, Any]]:
    return [
        dict(row)
        for row in connection.execute(
            """
            SELECT jis5, prefecture_code, prefecture_name, display_name,
                   municipality_name, ward_name
            FROM territory_versions
            WHERE snapshot_date = ? AND entity_type <> 'unassigned'
            ORDER BY jis5
            """,
            (snapshot_date,),
        ).fetchall()
    ]


def _choose_primary_flags(matches: list[dict[str, Any]]) -> None:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for match in matches:
        grouped.setdefault(match["jis5"], []).append(match)
    for group in grouped.values():
        preferred = sorted(
            group,
            key=lambda match: (
                match["method"] == "parent_city_flag_inheritance",
                "(" in match["title"],
                match["title"].lower(),
                match["page_id"],
            ),
        )[0]
        for match in group:
            match["is_primary"] = match is preferred


def _cached_code_resolutions(
    connection: sqlite3.Connection,
    *,
    source_type: str,
    source_keys: set[str],
) -> tuple[dict[str, str], set[str]]:
    if not source_keys:
        return {}, set()
    cached: dict[str, str] = {}
    seen: set[str] = set()
    sorted_keys = sorted(source_keys)
    for start in range(0, len(sorted_keys), 500):
        batch = sorted_keys[start : start + 500]
        placeholders = ",".join("?" for _ in batch)
        rows = connection.execute(
            f"""
            SELECT source_key, jis5
            FROM external_code_resolutions
            WHERE source_type = ? AND source_key IN ({placeholders})
            """,
            (source_type, *batch),
        ).fetchall()
        for row in rows:
            seen.add(row["source_key"])
            if row["jis5"]:
                cached[row["source_key"]] = row["jis5"]
    return cached, source_keys - seen


def _resolve_codes(
    connection: sqlite3.Connection,
    *,
    source_type: str,
    source_keys: set[str],
) -> dict[str, str]:
    cached, missing = _cached_code_resolutions(
        connection,
        source_type=source_type,
        source_keys=source_keys,
    )
    if source_type == "enwiki_title":
        fetched = fetch_wikidata_codes_for_enwiki_titles(missing)
    elif source_type == "wikidata_item":
        fetched = fetch_wikidata_codes_for_item_ids(missing)
    else:
        raise ValueError(f"Unsupported source type: {source_type}")
    fetched_at = datetime.now(UTC).isoformat()
    with connection:
        connection.executemany(
            """
            INSERT INTO external_code_resolutions(
              source_type, source_key, jis5, fetched_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(source_type, source_key) DO UPDATE SET
              jis5=excluded.jis5,
              fetched_at=excluded.fetched_at
            """,
            ((source_type, key, fetched.get(key), fetched_at) for key in missing),
        )
    return {**cached, **fetched}


def _record_prefecture_corrections(
    connection: sqlite3.Connection,
    *,
    conflicts: list[dict[str, Any]],
    municipalities: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    prefecture_names = {
        municipality["prefecture_code"]: municipality["prefecture_name"]
        for municipality in municipalities
    }
    corrected_at = datetime.now(UTC).isoformat()
    corrections: list[dict[str, Any]] = []
    with connection:
        for conflict in conflicts:
            corrected_code = conflict["matched_jis5"][:2]
            corrected_name = prefecture_names[corrected_code]
            evidence = json.dumps(
                {
                    "matched_jis5": conflict["matched_jis5"],
                    "match_method": conflict["method"],
                    "previous_prefecture_code": conflict["classified_prefecture_code"],
                },
                ensure_ascii=False,
            )
            for field_name, value in (
                ("prefecture_code", corrected_code),
                ("prefecture_name_ja", corrected_name),
            ):
                connection.execute(
                    """
                    UPDATE flag_asset_assignments
                    SET is_primary = 0
                    WHERE page_id = ? AND field_name = ?
                    """,
                    (conflict["page_id"], field_name),
                )
                connection.execute(
                    """
                    INSERT INTO flag_asset_assignments(
                      page_id, field_name, value, method, confidence, is_primary,
                      evidence_json, assigned_at
                    ) VALUES (?, ?, ?, 'wikidata_p429_match_correction',
                              1.0, 1, ?, ?)
                    ON CONFLICT(page_id, field_name, method, value) DO UPDATE SET
                      confidence=excluded.confidence,
                      is_primary=excluded.is_primary,
                      evidence_json=excluded.evidence_json,
                      assigned_at=excluded.assigned_at
                    """,
                    (
                        conflict["page_id"],
                        field_name,
                        value,
                        evidence,
                        corrected_at,
                    ),
                )
            corrections.append(
                {
                    **conflict,
                    "corrected_prefecture_code": corrected_code,
                    "corrected_prefecture_name": corrected_name,
                }
            )
    return corrections


def match_current_flags_nationally(
    connection: sqlite3.Connection,
    *,
    snapshot_date: str,
    report_path: Path,
    refresh_usage: bool = False,
) -> dict[str, Any]:
    usage_result = fetch_missing_current_usage(
        connection,
        refresh=refresh_usage,
    )
    files = _matching_files(connection)
    municipalities = _municipalities(connection, snapshot_date)
    print(
        f"  resolving {len(files)} current flags against "
        f"{len(municipalities)} territories",
        flush=True,
    )

    enwiki_codes = _resolve_codes(
        connection,
        source_type="enwiki_title",
        source_keys=enwiki_titles(files),
    )
    item_codes = _resolve_codes(
        connection,
        source_type="wikidata_item",
        source_keys=wikidata_item_ids(files),
    )
    matching = match_commons_files_to_municipalities(
        files,
        municipalities,
        enwiki_codes=enwiki_codes,
        wikidata_item_codes=item_codes,
    )
    matches_by_edge = {
        (match["jis5"], match["page_id"]): match for match in matching["matches"]
    }
    curated_matches = known_current_flag_matches(files, municipalities)
    for match in curated_matches:
        matches_by_edge[(match["jis5"], match["page_id"])] = match
    matching["matches"] = list(matches_by_edge.values())
    curated_page_ids = {match["page_id"] for match in curated_matches}
    matching["unmatched"] = [
        item
        for item in matching["unmatched"]
        if item["page_id"] not in curated_page_ids
    ]
    _choose_primary_flags(matching["matches"])
    ingest_matches(
        connection,
        matching["matches"],
        snapshot_date=snapshot_date,
    )

    matched_codes = {match["jis5"] for match in matching["matches"]}
    linked_pages = {match["page_id"] for match in matching["matches"]}
    file_prefecture = {int(file["page_id"]): file["prefecture_code"] for file in files}
    classification_conflicts = [
        {
            "page_id": match["page_id"],
            "title": match["title"],
            "classified_prefecture_code": file_prefecture[match["page_id"]],
            "matched_jis5": match["jis5"],
            "method": match["method"],
        }
        for match in matching["matches"]
        if file_prefecture[match["page_id"]]
        and not match["jis5"].startswith(file_prefecture[match["page_id"]])
    ]
    classification_corrections = _record_prefecture_corrections(
        connection,
        conflicts=classification_conflicts,
        municipalities=municipalities,
    )
    by_prefecture = []
    for row in connection.execute(
        """
        SELECT
          t.prefecture_code,
          t.prefecture_name,
          COUNT(*) AS territories,
          SUM(CASE WHEN f.page_id IS NOT NULL THEN 1 ELSE 0 END) AS matched
        FROM territory_versions t
        LEFT JOIN territory_version_flags f
          ON f.territory_version_id = t.id AND f.role = 'primary'
        WHERE t.snapshot_date = ? AND t.entity_type <> 'unassigned'
        GROUP BY t.prefecture_code, t.prefecture_name
        ORDER BY t.prefecture_code
        """,
        (snapshot_date,),
    ).fetchall():
        by_prefecture.append(
            {
                **dict(row),
                "coverage_pct": round(100 * row["matched"] / row["territories"], 2),
            }
        )
    unmatched_territories = [
        dict(row)
        for row in connection.execute(
            """
            SELECT t.jis5, t.prefecture_name, t.display_name
            FROM territory_versions t
            LEFT JOIN territory_version_flags f
              ON f.territory_version_id = t.id AND f.role = 'primary'
            WHERE t.snapshot_date = ?
              AND t.entity_type <> 'unassigned'
              AND f.page_id IS NULL
            ORDER BY t.jis5
            """,
            (snapshot_date,),
        ).fetchall()
    ]

    report = {
        "snapshot_date": snapshot_date,
        "current_flag_assets": len(files),
        "target_territories": len(municipalities),
        "matched_territories": len(matched_codes),
        "polygon_coverage_pct": round(
            100 * len(matched_codes) / len(municipalities),
            2,
        ),
        "linked_flag_assets": len(linked_pages),
        "flag_asset_coverage_pct": round(
            100 * len(linked_pages) / len(files),
            2,
        ),
        "flag_polygon_edges": len(matching["matches"]),
        "match_methods": dict(
            Counter(match["method"] for match in matching["matches"])
        ),
        "curated_current_flag_edges": len(curated_matches),
        "curated_current_matches": curated_matches,
        "usage_fetch": usage_result,
        "wikidata": {
            "enwiki_codes": len(enwiki_codes),
            "item_codes": len(item_codes),
        },
        "classification_conflicts": classification_conflicts,
        "classification_corrections": classification_corrections,
        "by_prefecture": by_prefecture,
        "unmatched_territories": unmatched_territories,
        "unmatched_flag_assets": matching["unmatched"],
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return report
