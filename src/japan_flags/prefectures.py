from __future__ import annotations

import json
import os
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from shapely import from_geojson, to_geojson
from shapely.ops import unary_union

from .bulk_svg import download_svg_file, fetch_basic_file_details
from .database import _upsert_geometry
from .wikidata import fetch_flag_filenames_for_jawiki_titles

PREFECTURE_FLAG_CATEGORY = "Category:SVG flags of prefectures of Japan"


def _prefecture_rows(
    connection: sqlite3.Connection,
    snapshot_date: str,
) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT DISTINCT prefecture_code, prefecture_name
        FROM territory_versions
        WHERE snapshot_date = ?
        ORDER BY prefecture_code
        """,
        (snapshot_date,),
    ).fetchall()


def _acquire_prefecture_flags(
    *,
    prefectures: list[sqlite3.Row],
    raw_directory: Path,
    asset_directory: Path,
    snapshot_date: str,
    refresh: bool,
) -> dict[str, Any]:
    raw_directory.mkdir(parents=True, exist_ok=True)
    asset_directory.mkdir(parents=True, exist_ok=True)
    cache_path = raw_directory / f"prefecture-flags-{snapshot_date}.json"

    if cache_path.exists() and not refresh:
        acquisition = json.loads(cache_path.read_text())
    else:
        names = {str(row["prefecture_name"]) for row in prefectures}
        filenames = fetch_flag_filenames_for_jawiki_titles(names)
        missing_names = sorted(names - filenames.keys())
        if missing_names:
            raise ValueError(
                "Wikidata P41 is missing prefecture flags: " + ", ".join(missing_names)
            )
        members = [
            {
                "title": f"File:{filenames[str(row['prefecture_name'])]}",
                "categories": [PREFECTURE_FLAG_CATEGORY],
                "prefecture_code": str(row["prefecture_code"]),
                "prefecture_name": str(row["prefecture_name"]),
            }
            for row in prefectures
        ]
        details = fetch_basic_file_details(members)
        acquired_at = datetime.now(UTC).isoformat()
        acquisition = {
            "snapshot_date": snapshot_date,
            "acquired_at": acquired_at,
            "files": details,
        }
        cache_path.write_text(
            json.dumps(acquisition, ensure_ascii=False, indent=2) + "\n"
        )

    for file in acquisition["files"]:
        download_svg_file(file, asset_directory, refresh)
    return acquisition


def ingest_current_prefectures(
    connection: sqlite3.Connection,
    *,
    database_path: Path,
    data_directory: Path,
    snapshot_date: str,
    refresh: bool = False,
) -> dict[str, Any]:
    prefectures = _prefecture_rows(connection, snapshot_date)
    if len(prefectures) != 47:
        raise ValueError(
            f"Expected 47 prefectures for {snapshot_date}, got {len(prefectures)}"
        )

    asset_directory = data_directory / "assets" / "commons"
    acquisition = _acquire_prefecture_flags(
        prefectures=prefectures,
        raw_directory=data_directory / "raw" / "commons",
        asset_directory=asset_directory,
        snapshot_date=snapshot_date,
        refresh=refresh,
    )
    file_by_code = {str(file["prefecture_code"]): file for file in acquisition["files"]}
    now = datetime.now(UTC).isoformat()

    with connection:
        for file in acquisition["files"]:
            page_id = int(file["page_id"])
            local_path = asset_directory / f"{page_id}.svg"
            connection.execute(
                """
                INSERT INTO flag_assets(
                  page_id, commons_title, original_url, description_url, mime,
                  width, height, byte_size, sha1, commons_timestamp, local_path,
                  inventory_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(page_id) DO UPDATE SET
                  commons_title=excluded.commons_title,
                  original_url=excluded.original_url,
                  description_url=excluded.description_url,
                  mime=excluded.mime,
                  width=excluded.width,
                  height=excluded.height,
                  byte_size=excluded.byte_size,
                  sha1=excluded.sha1,
                  commons_timestamp=excluded.commons_timestamp,
                  local_path=excluded.local_path,
                  inventory_at=excluded.inventory_at
                """,
                (
                    page_id,
                    file["title"],
                    file["url"],
                    file["description_url"],
                    file["mime"],
                    file["width"],
                    file["height"],
                    file["size"],
                    file["sha1"],
                    file["timestamp"],
                    os.path.relpath(local_path, database_path.parent),
                    acquisition["acquired_at"],
                ),
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO flag_asset_categories(page_id, category)
                VALUES (?, ?)
                """,
                (page_id, PREFECTURE_FLAG_CATEGORY),
            )

        for prefecture in prefectures:
            code = str(prefecture["prefecture_code"])
            name = str(prefecture["prefecture_name"])
            geometry_rows = connection.execute(
                """
                SELECT g.geometry_json
                FROM territory_versions t
                JOIN geometries g ON g.id = t.geometry_id
                WHERE t.snapshot_date = ? AND t.prefecture_code = ?
                """,
                (snapshot_date, code),
            ).fetchall()
            geometry = unary_union(
                [from_geojson(row["geometry_json"]) for row in geometry_rows]
            )
            geometry_json = json.loads(to_geojson(geometry))
            source_url = f"derived:n03-union:{snapshot_date}:{code}"
            geometry_id = _upsert_geometry(
                connection,
                geometry=geometry_json,
                bbox=list(geometry.bounds),
                source_url=source_url,
                source_kind="derived_n03_prefecture_union",
            )
            connection.execute(
                """
                INSERT INTO prefecture_versions(
                  snapshot_date, prefecture_code, prefecture_name, geometry_id,
                  source_kind, source_url, created_at
                ) VALUES (?, ?, ?, ?, 'derived_n03_prefecture_union', ?, ?)
                ON CONFLICT(snapshot_date, prefecture_code) DO UPDATE SET
                  prefecture_name=excluded.prefecture_name,
                  geometry_id=excluded.geometry_id,
                  source_kind=excluded.source_kind,
                  source_url=excluded.source_url
                """,
                (
                    snapshot_date,
                    code,
                    name,
                    geometry_id,
                    source_url,
                    now,
                ),
            )
            version = connection.execute(
                """
                SELECT id FROM prefecture_versions
                WHERE snapshot_date = ? AND prefecture_code = ?
                """,
                (snapshot_date, code),
            ).fetchone()
            assert version is not None
            file = file_by_code[code]
            connection.execute(
                """
                UPDATE prefecture_version_flags
                SET role = 'alternate'
                WHERE prefecture_version_id = ? AND role = 'primary'
                """,
                (version["id"],),
            )
            connection.execute(
                """
                INSERT INTO prefecture_version_flags(
                  prefecture_version_id, page_id, role, match_method,
                  confidence, assigned_at
                ) VALUES (?, ?, 'primary', 'wikidata_p41', 1.0, ?)
                ON CONFLICT(prefecture_version_id, page_id) DO UPDATE SET
                  role=excluded.role,
                  match_method=excluded.match_method,
                  confidence=excluded.confidence,
                  assigned_at=excluded.assigned_at
                """,
                (version["id"], int(file["page_id"]), now),
            )

    return {
        "snapshot_date": snapshot_date,
        "prefectures": len(prefectures),
        "flag_assets": len(acquisition["files"]),
        "cache_path": str(
            data_directory
            / "raw"
            / "commons"
            / f"prefecture-flags-{snapshot_date}.json"
        ),
    }
