from __future__ import annotations

import json
import os
import sqlite3
from hashlib import sha256
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS municipalities (
  jis5 TEXT PRIMARY KEY CHECK(length(jis5) = 5),
  prefecture_code TEXT NOT NULL,
  prefecture_name TEXT NOT NULL,
  subprefecture_name TEXT,
  district_name TEXT,
  municipality_name TEXT NOT NULL,
  ward_name TEXT,
  display_name TEXT NOT NULL,
  latest_boundary_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boundaries (
  jis5 TEXT NOT NULL REFERENCES municipalities(jis5),
  boundary_date TEXT NOT NULL,
  source_url TEXT NOT NULL,
  geometry_type TEXT NOT NULL,
  geometry_json TEXT NOT NULL,
  feature_count INTEGER NOT NULL,
  min_lng REAL NOT NULL,
  min_lat REAL NOT NULL,
  max_lng REAL NOT NULL,
  max_lat REAL NOT NULL,
  PRIMARY KEY (jis5, boundary_date)
);

CREATE TABLE IF NOT EXISTS commons_files (
  page_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  original_url TEXT NOT NULL,
  description_url TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  byte_size INTEGER,
  sha1 TEXT NOT NULL,
  commons_timestamp TEXT,
  fetched_at TEXT NOT NULL,
  local_path TEXT NOT NULL,
  svg_text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commons_categories (
  category TEXT NOT NULL,
  page_id INTEGER NOT NULL REFERENCES commons_files(page_id),
  PRIMARY KEY (category, page_id)
);

CREATE TABLE IF NOT EXISTS commons_global_usage (
  page_id INTEGER NOT NULL REFERENCES commons_files(page_id),
  wiki TEXT NOT NULL,
  page_title TEXT NOT NULL,
  page_url TEXT,
  namespace INTEGER,
  PRIMARY KEY (page_id, wiki, page_title)
);

CREATE TABLE IF NOT EXISTS municipality_flags (
  jis5 TEXT NOT NULL REFERENCES municipalities(jis5),
  page_id INTEGER NOT NULL REFERENCES commons_files(page_id),
  match_method TEXT NOT NULL,
  confidence REAL NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (jis5, page_id)
);

CREATE TABLE IF NOT EXISTS flag_assets (
  page_id INTEGER PRIMARY KEY,
  commons_title TEXT NOT NULL UNIQUE,
  original_url TEXT NOT NULL,
  description_url TEXT NOT NULL,
  mime TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  byte_size INTEGER NOT NULL,
  sha1 TEXT NOT NULL,
  commons_timestamp TEXT,
  local_path TEXT NOT NULL,
  inventory_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS flag_asset_categories (
  page_id INTEGER NOT NULL REFERENCES flag_assets(page_id),
  category TEXT NOT NULL,
  PRIMARY KEY (page_id, category)
);

CREATE TABLE IF NOT EXISTS flag_asset_assignments (
  page_id INTEGER NOT NULL REFERENCES flag_assets(page_id),
  field_name TEXT NOT NULL,
  value TEXT NOT NULL,
  method TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  is_primary INTEGER NOT NULL DEFAULT 1,
  evidence_json TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (page_id, field_name, method, value)
);

CREATE TABLE IF NOT EXISTS flag_asset_global_usage (
  page_id INTEGER NOT NULL REFERENCES flag_assets(page_id),
  wiki TEXT NOT NULL,
  page_title TEXT NOT NULL,
  page_url TEXT,
  namespace INTEGER NOT NULL,
  PRIMARY KEY (page_id, wiki, page_title)
);

CREATE TABLE IF NOT EXISTS flag_asset_usage_fetches (
  page_id INTEGER PRIMARY KEY REFERENCES flag_assets(page_id),
  fetched_at TEXT NOT NULL,
  usage_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS external_code_resolutions (
  source_type TEXT NOT NULL CHECK(
    source_type IN ('enwiki_title', 'wikidata_item')
  ),
  source_key TEXT NOT NULL,
  jis5 TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (source_type, source_key)
);

CREATE TABLE IF NOT EXISTS external_entity_cache (
  provider TEXT NOT NULL,
  source_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (provider, source_key)
);

CREATE TABLE IF NOT EXISTS municipality_profiles (
  snapshot_date TEXT NOT NULL,
  jis5 TEXT NOT NULL CHECK(length(jis5) = 5),
  resolution_status TEXT NOT NULL CHECK(
    resolution_status IN ('resolved', 'unresolved')
  ),
  wikidata_item_id TEXT,
  jawiki_title TEXT,
  jawiki_url TEXT,
  wikipedia_extract TEXT,
  population INTEGER CHECK(population IS NULL OR population >= 0),
  population_as_of TEXT,
  population_date_precision INTEGER,
  area_km2 REAL CHECK(area_km2 IS NULL OR area_km2 >= 0),
  wikidata_url TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (snapshot_date, jis5)
);

CREATE TABLE IF NOT EXISTS municipality_wiki_attributes (
  row_id INTEGER PRIMARY KEY,
  jis5 TEXT,
  prefecture_code TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('emblem', 'flag')),
  section_kind TEXT NOT NULL CHECK(section_kind IN ('city', 'town', 'abandoned')),
  prefecture_section TEXT,
  display_name TEXT NOT NULL,
  article_title TEXT,
  has_attribute INTEGER NOT NULL DEFAULT 1,
  enacted_on TEXT,
  enacted_year INTEGER,
  enacted_month INTEGER,
  enacted_day INTEGER,
  enacted_precision TEXT NOT NULL CHECK(
    enacted_precision IN (
      'day', 'month', 'year', 'approximate', 'unknown', 'inherited', 'empty'
    )
  ),
  abandoned_on TEXT,
  abandoned_year INTEGER,
  origin_text TEXT,
  flag_ground_color TEXT,
  flag_emblem_color TEXT,
  file_name TEXT,
  source_list_title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  resolution_status TEXT NOT NULL CHECK(
    resolution_status IN ('resolved', 'unresolved')
  ),
  resolution_note TEXT,
  fetched_at TEXT NOT NULL,
  UNIQUE(
    kind, source_list_title, section_kind, prefecture_section,
    display_name, article_title, enacted_on, abandoned_on
  )
);
CREATE INDEX IF NOT EXISTS municipality_wiki_attributes_jis5
  ON municipality_wiki_attributes(jis5, kind);
CREATE INDEX IF NOT EXISTS municipality_wiki_attributes_enacted
  ON municipality_wiki_attributes(enacted_year);

CREATE TABLE IF NOT EXISTS geometries (
  id INTEGER PRIMARY KEY,
  content_sha256 TEXT NOT NULL UNIQUE,
  source_kind TEXT NOT NULL,
  source_url TEXT NOT NULL,
  geometry_type TEXT NOT NULL,
  geometry_json TEXT NOT NULL,
  min_lng REAL NOT NULL,
  min_lat REAL NOT NULL,
  max_lng REAL NOT NULL,
  max_lat REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS territory_versions (
  id INTEGER PRIMARY KEY,
  snapshot_date TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  jis5 TEXT CHECK(jis5 IS NULL OR length(jis5) = 5),
  prefecture_code TEXT NOT NULL,
  prefecture_name TEXT NOT NULL,
  subprefecture_name TEXT,
  district_name TEXT,
  municipality_name TEXT NOT NULL,
  ward_name TEXT,
  display_name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(
    entity_type IN ('municipality', 'ward', 'special_ward', 'unassigned')
  ),
  parent_version_id INTEGER REFERENCES territory_versions(id),
  geometry_id INTEGER NOT NULL REFERENCES geometries(id),
  source_kind TEXT NOT NULL,
  source_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(snapshot_date, jis5)
);

CREATE INDEX IF NOT EXISTS territory_versions_snapshot_prefecture
ON territory_versions(snapshot_date, prefecture_code);

CREATE TABLE IF NOT EXISTS territory_version_flags (
  territory_version_id INTEGER NOT NULL REFERENCES territory_versions(id),
  page_id INTEGER NOT NULL REFERENCES flag_assets(page_id),
  role TEXT NOT NULL CHECK(role IN ('primary', 'alternate')),
  assignment_kind TEXT NOT NULL CHECK(
    assignment_kind IN ('direct', 'inherited')
  ),
  match_method TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (territory_version_id, page_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_primary_flag_per_territory_version
ON territory_version_flags(territory_version_id)
WHERE role = 'primary';

CREATE TABLE IF NOT EXISTS territory_relations (
  from_version_id INTEGER NOT NULL REFERENCES territory_versions(id),
  to_version_id INTEGER NOT NULL REFERENCES territory_versions(id),
  relation_type TEXT NOT NULL CHECK(
    relation_type IN (
      'predecessor', 'successor', 'rename', 'boundary_changed', 'merged', 'split'
    )
  ),
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_version_id, to_version_id, relation_type)
);

CREATE TABLE IF NOT EXISTS prefecture_versions (
  id INTEGER PRIMARY KEY,
  snapshot_date TEXT NOT NULL,
  prefecture_code TEXT NOT NULL CHECK(length(prefecture_code) = 2),
  prefecture_name TEXT NOT NULL,
  geometry_id INTEGER NOT NULL REFERENCES geometries(id),
  source_kind TEXT NOT NULL,
  source_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(snapshot_date, prefecture_code)
);

CREATE TABLE IF NOT EXISTS prefecture_version_flags (
  prefecture_version_id INTEGER NOT NULL REFERENCES prefecture_versions(id),
  page_id INTEGER NOT NULL REFERENCES flag_assets(page_id),
  role TEXT NOT NULL CHECK(role IN ('primary', 'alternate')),
  match_method TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (prefecture_version_id, page_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_primary_flag_per_prefecture_version
ON prefecture_version_flags(prefecture_version_id)
WHERE role = 'primary';

CREATE VIEW IF NOT EXISTS municipality_flag_inventory AS
SELECT
  m.jis5,
  m.prefecture_name,
  m.display_name,
  b.boundary_date,
  b.feature_count,
  c.page_id AS commons_page_id,
  c.title AS commons_title,
  c.original_url,
  f.match_method,
  f.confidence
FROM municipalities m
LEFT JOIN boundaries b
  ON b.jis5 = m.jis5
 AND b.boundary_date = m.latest_boundary_date
LEFT JOIN municipality_flags f ON f.jis5 = m.jis5 AND f.is_primary = 1
LEFT JOIN commons_files c ON c.page_id = f.page_id;

CREATE VIEW IF NOT EXISTS unmatched_commons_files AS
SELECT c.page_id, c.title, c.description_url
FROM commons_files c
LEFT JOIN municipality_flags f ON f.page_id = c.page_id
WHERE f.page_id IS NULL;

CREATE VIEW IF NOT EXISTS flag_asset_catalog AS
SELECT
  a.page_id,
  a.commons_title,
  a.local_path,
  MAX(CASE WHEN x.field_name = 'lifecycle_status' AND x.is_primary = 1
      THEN x.value END) AS lifecycle_status,
  MAX(CASE WHEN x.field_name = 'category_kind' AND x.is_primary = 1
      THEN x.value END) AS category_kind,
  MAX(CASE WHEN x.field_name = 'prefecture_code' AND x.is_primary = 1
      THEN x.value END) AS prefecture_code,
  MAX(CASE WHEN x.field_name = 'prefecture_name_ja' AND x.is_primary = 1
      THEN x.value END) AS prefecture_name_ja,
  MAX(CASE WHEN x.field_name = 'name_hint_en' AND x.is_primary = 1
      THEN x.value END) AS name_hint_en,
  MAX(CASE WHEN x.field_name = 'municipality_name_en_hint' AND x.is_primary = 1
      THEN x.value END) AS municipality_name_en_hint,
  MAX(CASE WHEN x.field_name = 'valid_from_year' AND x.is_primary = 1
      THEN x.value END) AS valid_from_year,
  MAX(CASE WHEN x.field_name = 'valid_to_year' AND x.is_primary = 1
      THEN x.value END) AS valid_to_year,
  MAX(CASE WHEN x.field_name = 'variant_ordinal' AND x.is_primary = 1
      THEN x.value END) AS variant_ordinal
FROM flag_assets a
LEFT JOIN flag_asset_assignments x ON x.page_id = a.page_id
GROUP BY a.page_id;
"""


def open_database(database_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode = WAL")
    connection.executescript(SCHEMA)
    migrate_current_to_temporal(connection)
    return connection


def _entity_type(area: dict[str, Any]) -> str:
    if area["municipality_name"] == "所属未定地":
        return "unassigned"
    if area.get("ward_name"):
        return "ward"
    if area["prefecture_code"] == "13" and area["municipality_name"].endswith("区"):
        return "special_ward"
    return "municipality"


def _upsert_geometry(
    connection: sqlite3.Connection,
    *,
    geometry: dict[str, Any],
    bbox: list[float] | tuple[float, float, float, float],
    source_url: str,
    source_kind: str = "mlit_n03",
) -> int:
    geometry_json = json.dumps(geometry, separators=(",", ":"))
    digest = sha256(geometry_json.encode()).hexdigest()
    connection.execute(
        """
        INSERT INTO geometries(
          content_sha256, source_kind, source_url, geometry_type, geometry_json,
          min_lng, min_lat, max_lng, max_lat, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_sha256) DO UPDATE SET
          source_url=excluded.source_url
        """,
        (
            digest,
            source_kind,
            source_url,
            geometry["type"],
            geometry_json,
            *bbox,
            datetime.now(UTC).isoformat(),
        ),
    )
    row = connection.execute(
        "SELECT id FROM geometries WHERE content_sha256 = ?",
        (digest,),
    ).fetchone()
    assert row is not None
    return int(row[0])


def _upsert_territory_version(
    connection: sqlite3.Connection,
    *,
    area: dict[str, Any],
    source_url: str,
    geometry_id: int,
) -> int:
    now = datetime.now(UTC).isoformat()
    connection.execute(
        """
        INSERT INTO territory_versions(
          snapshot_date, valid_from, valid_to, jis5, prefecture_code,
          prefecture_name, subprefecture_name, district_name,
          municipality_name, ward_name, display_name, entity_type,
          geometry_id, source_kind, source_url, created_at
        ) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mlit_n03', ?, ?)
        ON CONFLICT(snapshot_date, jis5) DO UPDATE SET
          prefecture_code=excluded.prefecture_code,
          prefecture_name=excluded.prefecture_name,
          subprefecture_name=excluded.subprefecture_name,
          district_name=excluded.district_name,
          municipality_name=excluded.municipality_name,
          ward_name=excluded.ward_name,
          display_name=excluded.display_name,
          entity_type=excluded.entity_type,
          geometry_id=excluded.geometry_id,
          source_url=excluded.source_url
        """,
        (
            area["boundary_date"],
            area["jis5"],
            area["prefecture_code"],
            area["prefecture_name"],
            area["subprefecture_name"],
            area["district_name"],
            area["municipality_name"],
            area["ward_name"],
            area["display_name"],
            _entity_type(area),
            geometry_id,
            source_url,
            now,
        ),
    )
    row = connection.execute(
        """
        SELECT id FROM territory_versions
        WHERE snapshot_date = ? AND jis5 = ?
        """,
        (area["boundary_date"], area["jis5"]),
    ).fetchone()
    assert row is not None
    return int(row[0])


def _ensure_flag_asset_from_commons(
    connection: sqlite3.Connection,
    page_id: int,
) -> bool:
    if connection.execute(
        "SELECT 1 FROM flag_assets WHERE page_id = ?",
        (page_id,),
    ).fetchone():
        return True
    row = connection.execute(
        """
        SELECT page_id, title, original_url, description_url, mime, width,
               height, byte_size, sha1, commons_timestamp, local_path, fetched_at
        FROM commons_files
        WHERE page_id = ?
        """,
        (page_id,),
    ).fetchone()
    if row is None:
        return False
    connection.execute(
        """
        INSERT OR IGNORE INTO flag_assets(
          page_id, commons_title, original_url, description_url, mime, width,
          height, byte_size, sha1, commons_timestamp, local_path, inventory_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        tuple(row),
    )
    return True


def migrate_current_to_temporal(connection: sqlite3.Connection) -> None:
    legacy_count = connection.execute("SELECT COUNT(*) FROM boundaries").fetchone()[0]
    temporal_count = connection.execute(
        "SELECT COUNT(*) FROM territory_versions"
    ).fetchone()[0]
    if legacy_count == 0 or temporal_count >= legacy_count:
        return
    boundary_rows = connection.execute(
        """
        SELECT m.*, b.boundary_date, b.source_url, b.geometry_json,
               b.min_lng, b.min_lat, b.max_lng, b.max_lat
        FROM municipalities m
        JOIN boundaries b ON b.jis5 = m.jis5
        ORDER BY b.boundary_date, m.jis5
        """
    ).fetchall()
    if not boundary_rows:
        return
    with connection:
        for row in boundary_rows:
            area = {
                key: row[key]
                for key in (
                    "jis5",
                    "prefecture_code",
                    "prefecture_name",
                    "subprefecture_name",
                    "district_name",
                    "municipality_name",
                    "ward_name",
                    "display_name",
                    "boundary_date",
                )
            }
            geometry = json.loads(row["geometry_json"])
            geometry_id = _upsert_geometry(
                connection,
                geometry=geometry,
                bbox=[
                    row["min_lng"],
                    row["min_lat"],
                    row["max_lng"],
                    row["max_lat"],
                ],
                source_url=row["source_url"],
            )
            territory_version_id = _upsert_territory_version(
                connection,
                area=area,
                source_url=row["source_url"],
                geometry_id=geometry_id,
            )
            flags = connection.execute(
                """
                SELECT page_id, match_method, confidence, is_primary
                FROM municipality_flags
                WHERE jis5 = ?
                """,
                (row["jis5"],),
            ).fetchall()
            for flag in flags:
                if not _ensure_flag_asset_from_commons(
                    connection,
                    int(flag["page_id"]),
                ):
                    continue
                connection.execute(
                    """
                    INSERT INTO territory_version_flags(
                      territory_version_id, page_id, role, assignment_kind,
                      match_method, confidence, assigned_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(territory_version_id, page_id) DO UPDATE SET
                      role=excluded.role,
                      assignment_kind=excluded.assignment_kind,
                      match_method=excluded.match_method,
                      confidence=excluded.confidence,
                      assigned_at=excluded.assigned_at
                    """,
                    (
                        territory_version_id,
                        flag["page_id"],
                        "primary" if flag["is_primary"] else "alternate",
                        (
                            "inherited"
                            if flag["match_method"] == "parent_city_flag_inheritance"
                            else "direct"
                        ),
                        flag["match_method"],
                        flag["confidence"],
                        datetime.now(UTC).isoformat(),
                    ),
                )


def start_run(connection: sqlite3.Connection, parameters: dict[str, Any]) -> int:
    now = datetime.now(UTC).isoformat()
    connection.execute(
        """
        UPDATE ingestion_runs
        SET finished_at = ?, status = 'interrupted'
        WHERE status = 'running'
        """,
        (now,),
    )
    cursor = connection.execute(
        """
        INSERT INTO ingestion_runs(started_at, status, parameters_json)
        VALUES (?, 'running', ?)
        """,
        (now, json.dumps(parameters, ensure_ascii=False)),
    )
    connection.commit()
    assert cursor.lastrowid is not None
    return cursor.lastrowid


def finish_run(
    connection: sqlite3.Connection,
    run_id: int,
    status: str,
    result: dict[str, Any],
) -> None:
    connection.execute(
        """
        UPDATE ingestion_runs
        SET finished_at = ?, status = ?, result_json = ?
        WHERE id = ?
        """,
        (
            datetime.now(UTC).isoformat(),
            status,
            json.dumps(result, ensure_ascii=False),
            run_id,
        ),
    )
    connection.commit()


def ingest_n03(connection: sqlite3.Connection, acquisition: dict[str, Any]) -> None:
    with connection:
        for area in acquisition["areas"]:
            connection.execute(
                """
                INSERT INTO municipalities(
                  jis5, prefecture_code, prefecture_name, subprefecture_name,
                  district_name, municipality_name, ward_name, display_name,
                  latest_boundary_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(jis5) DO UPDATE SET
                  prefecture_code=excluded.prefecture_code,
                  prefecture_name=excluded.prefecture_name,
                  subprefecture_name=excluded.subprefecture_name,
                  district_name=excluded.district_name,
                  municipality_name=excluded.municipality_name,
                  ward_name=excluded.ward_name,
                  display_name=excluded.display_name,
                  latest_boundary_date=excluded.latest_boundary_date
                """,
                (
                    area["jis5"],
                    area["prefecture_code"],
                    area["prefecture_name"],
                    area["subprefecture_name"],
                    area["district_name"],
                    area["municipality_name"],
                    area["ward_name"],
                    area["display_name"],
                    area["boundary_date"],
                ),
            )
            geometry_id = _upsert_geometry(
                connection,
                geometry=area["geometry"],
                bbox=area["bbox"],
                source_url=acquisition["url"],
            )
            _upsert_territory_version(
                connection,
                area=area,
                source_url=acquisition["url"],
                geometry_id=geometry_id,
            )
            connection.execute(
                """
                INSERT INTO boundaries(
                  jis5, boundary_date, source_url, geometry_type, geometry_json,
                  feature_count, min_lng, min_lat, max_lng, max_lat
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(jis5, boundary_date) DO UPDATE SET
                  source_url=excluded.source_url,
                  geometry_type=excluded.geometry_type,
                  geometry_json=excluded.geometry_json,
                  feature_count=excluded.feature_count,
                  min_lng=excluded.min_lng,
                  min_lat=excluded.min_lat,
                  max_lng=excluded.max_lng,
                  max_lat=excluded.max_lat
                """,
                (
                    area["jis5"],
                    area["boundary_date"],
                    acquisition["url"],
                    area["geometry"]["type"],
                    json.dumps(area["geometry"], separators=(",", ":")),
                    area["feature_count"],
                    *area["bbox"],
                ),
            )


def ingest_commons(
    connection: sqlite3.Connection,
    acquisition: dict[str, Any],
    database_path: Path,
) -> None:
    with connection:
        for file in acquisition["files"]:
            connection.execute(
                """
                INSERT INTO commons_files(
                  page_id, title, original_url, description_url, mime, width,
                  height, byte_size, sha1, commons_timestamp, fetched_at,
                  local_path, svg_text
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(page_id) DO UPDATE SET
                  title=excluded.title,
                  original_url=excluded.original_url,
                  description_url=excluded.description_url,
                  mime=excluded.mime,
                  width=excluded.width,
                  height=excluded.height,
                  byte_size=excluded.byte_size,
                  sha1=excluded.sha1,
                  commons_timestamp=excluded.commons_timestamp,
                  fetched_at=excluded.fetched_at,
                  local_path=excluded.local_path,
                  svg_text=excluded.svg_text
                """,
                (
                    file["page_id"],
                    file["title"],
                    file["url"],
                    file["description_url"],
                    file["mime"],
                    file["width"],
                    file["height"],
                    file["size"],
                    file["sha1"],
                    file["timestamp"],
                    acquisition["acquired_at"],
                    os.path.relpath(file["local_path"], database_path.parent),
                    file["svg_text"],
                ),
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO commons_categories(category, page_id)
                VALUES (?, ?)
                """,
                (acquisition["category"], file["page_id"]),
            )
            for usage in file.get("global_usage", []):
                connection.execute(
                    """
                    INSERT OR REPLACE INTO commons_global_usage(
                      page_id, wiki, page_title, page_url, namespace
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        file["page_id"],
                        usage["wiki"],
                        usage["title"],
                        usage.get("url"),
                        int(usage["ns"]),
                    ),
                )


def ingest_matches(
    connection: sqlite3.Connection,
    matches: list[dict[str, Any]],
    snapshot_date: str | None = None,
) -> None:
    with connection:
        affected_codes = sorted({match["jis5"] for match in matches})
        connection.executemany(
            """
            UPDATE municipality_flags
            SET is_primary = 0
            WHERE jis5 = ?
            """,
            ((code,) for code in affected_codes),
        )
        for match in matches:
            if connection.execute(
                "SELECT 1 FROM commons_files WHERE page_id = ?",
                (match["page_id"],),
            ).fetchone():
                connection.execute(
                    """
                    INSERT INTO municipality_flags(
                      jis5, page_id, match_method, confidence, is_primary
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(jis5, page_id) DO UPDATE SET
                      match_method=excluded.match_method,
                      confidence=excluded.confidence,
                      is_primary=excluded.is_primary
                    """,
                    (
                        match["jis5"],
                        match["page_id"],
                        match["method"],
                        match["confidence"],
                        int(match.get("is_primary", True)),
                    ),
                )
            if not _ensure_flag_asset_from_commons(
                connection,
                int(match["page_id"]),
            ):
                continue
            snapshot_filter = (
                "AND snapshot_date = ?"
                if snapshot_date is not None
                else """
                AND snapshot_date = (
                  SELECT MAX(snapshot_date)
                  FROM territory_versions latest
                  WHERE latest.jis5 = territory_versions.jis5
                )
                """
            )
            parameters: tuple[Any, ...] = (match["jis5"],)
            if snapshot_date is not None:
                parameters += (snapshot_date,)
            territory_rows = connection.execute(
                f"""
                SELECT id FROM territory_versions
                WHERE jis5 = ?
                {snapshot_filter}
                """,
                parameters,
            ).fetchall()
            for territory in territory_rows:
                if match.get("is_primary", True):
                    connection.execute(
                        """
                        UPDATE territory_version_flags
                        SET role = 'alternate'
                        WHERE territory_version_id = ? AND role = 'primary'
                        """,
                        (territory["id"],),
                    )
                connection.execute(
                    """
                    INSERT INTO territory_version_flags(
                      territory_version_id, page_id, role, assignment_kind,
                      match_method, confidence, assigned_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(territory_version_id, page_id) DO UPDATE SET
                      role=excluded.role,
                      assignment_kind=excluded.assignment_kind,
                      match_method=excluded.match_method,
                      confidence=excluded.confidence,
                      assigned_at=excluded.assigned_at
                    """,
                    (
                        territory["id"],
                        match["page_id"],
                        ("primary" if match.get("is_primary", True) else "alternate"),
                        (
                            "inherited"
                            if match["method"] == "parent_city_flag_inheritance"
                            else "direct"
                        ),
                        match["method"],
                        match["confidence"],
                        datetime.now(UTC).isoformat(),
                    ),
                )


def build_report(
    connection: sqlite3.Connection,
    prefecture_code: str | None = None,
) -> dict[str, Any]:
    filters = ["m.municipality_name <> '所属未定地'"]
    if prefecture_code:
        filters.append("m.prefecture_code = ?")
    where = f"WHERE {' AND '.join(filters)}"
    parameters = (prefecture_code,) if prefecture_code else ()
    summary = connection.execute(
        f"""
        SELECT
          COUNT(*) AS municipalities,
          SUM(CASE WHEN EXISTS (
            SELECT 1 FROM municipality_flags f WHERE f.jis5 = m.jis5
          ) THEN 1 ELSE 0 END) AS matched,
          SUM(CASE WHEN NOT EXISTS (
            SELECT 1 FROM municipality_flags f WHERE f.jis5 = m.jis5
          ) THEN 1 ELSE 0 END) AS missing_flags,
          SUM(b.feature_count) AS source_boundary_features
        FROM municipalities m
        LEFT JOIN boundaries b
          ON b.jis5 = m.jis5
         AND b.boundary_date = m.latest_boundary_date
        {where}
        """,
        parameters,
    ).fetchone()
    unmatched = connection.execute(
        "SELECT COUNT(*) FROM unmatched_commons_files"
    ).fetchone()[0]
    return {
        **dict(summary),
        "unmatched_commons_files": unmatched,
    }


def ingest_flag_asset_manifest(
    connection: sqlite3.Connection,
    manifest: dict[str, Any],
    asset_directory: Path,
    assignments_by_page: dict[int, list[dict[str, Any]]],
    database_path: Path,
) -> None:
    assigned_at = datetime.now(UTC).isoformat()
    with connection:
        for file in manifest["files"]:
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
                    manifest["inventory_at"],
                ),
            )
            for category in file["categories"]:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO flag_asset_categories(page_id, category)
                    VALUES (?, ?)
                    """,
                    (page_id, category),
                )
            for assignment in assignments_by_page[page_id]:
                has_correction = connection.execute(
                    """
                    SELECT 1
                    FROM flag_asset_assignments
                    WHERE page_id = ?
                      AND field_name = ?
                      AND method = 'wikidata_p429_match_correction'
                      AND is_primary = 1
                    """,
                    (page_id, assignment["field_name"]),
                ).fetchone()
                if not has_correction:
                    connection.execute(
                        """
                        UPDATE flag_asset_assignments
                        SET is_primary = 0
                        WHERE page_id = ? AND field_name = ?
                        """,
                        (page_id, assignment["field_name"]),
                    )
                connection.execute(
                    """
                    INSERT INTO flag_asset_assignments(
                      page_id, field_name, value, method, confidence, is_primary,
                      evidence_json, assigned_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(page_id, field_name, method, value) DO UPDATE SET
                      confidence=excluded.confidence,
                      is_primary=excluded.is_primary,
                      evidence_json=excluded.evidence_json,
                      assigned_at=excluded.assigned_at
                    """,
                    (
                        page_id,
                        assignment["field_name"],
                        assignment["value"],
                        assignment["method"],
                        assignment["confidence"],
                        int(assignment["is_primary"] and not has_correction),
                        json.dumps(assignment["evidence"], ensure_ascii=False),
                        assigned_at,
                    ),
                )
