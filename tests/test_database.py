from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from japan_flags.database import ingest_matches, ingest_n03, open_database


def sample_acquisition() -> dict:
    return {
        "url": "https://example.test/N03.zip",
        "areas": [
            {
                "jis5": "99999",
                "prefecture_code": "99",
                "prefecture_name": "試験県",
                "subprefecture_name": None,
                "district_name": "試験郡",
                "municipality_name": "試験町",
                "ward_name": None,
                "display_name": "試験町",
                "boundary_date": "20260101",
                "feature_count": 1,
                "bbox": [130.0, 30.0, 131.0, 31.0],
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [
                        [
                            [
                                [130.0, 30.0],
                                [130.0, 31.0],
                                [131.0, 31.0],
                                [131.0, 30.0],
                                [130.0, 30.0],
                            ]
                        ]
                    ],
                },
            }
        ],
    }


class TemporalDatabaseTest(unittest.TestCase):
    def test_n03_ingestion_creates_polygon_owned_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "test.sqlite"
            connection = open_database(database_path)
            ingest_n03(connection, sample_acquisition())
            row = connection.execute(
                """
                SELECT t.snapshot_date, t.jis5, t.display_name, t.entity_type,
                       g.geometry_type
                FROM territory_versions t
                JOIN geometries g ON g.id = t.geometry_id
                """
            ).fetchone()
            self.assertEqual(
                tuple(row),
                ("20260101", "99999", "試験町", "municipality", "MultiPolygon"),
            )
            duplicate_count = connection.execute(
                """
                SELECT COUNT(*) FROM (
                  SELECT snapshot_date, jis5
                  FROM territory_versions
                  GROUP BY snapshot_date, jis5
                  HAVING COUNT(*) > 1
                )
                """
            ).fetchone()[0]
            self.assertEqual(duplicate_count, 0)
            self.assertEqual(
                connection.execute("PRAGMA foreign_key_check").fetchall(),
                [],
            )
            connection.close()

    def test_new_inventory_flag_can_link_without_legacy_commons_row(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "test.sqlite"
            connection = open_database(database_path)
            ingest_n03(connection, sample_acquisition())
            connection.execute(
                """
                INSERT INTO flag_assets(
                  page_id, commons_title, original_url, description_url, mime,
                  width, height, byte_size, sha1, commons_timestamp, local_path,
                  inventory_at
                ) VALUES (
                  123, 'File:Flag of Example.svg', 'https://example.test/a.svg',
                  'https://example.test/file', 'image/svg+xml', 900, 600, 10,
                  'abc', '2026-01-01T00:00:00Z', 'assets/123.svg',
                  '2026-01-01T00:00:00Z'
                )
                """
            )
            connection.commit()
            ingest_matches(
                connection,
                [
                    {
                        "jis5": "99999",
                        "page_id": 123,
                        "method": "jawiki_globalusage_exact",
                        "confidence": 1.0,
                        "is_primary": True,
                    }
                ],
                snapshot_date="20260101",
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM territory_version_flags"
                ).fetchone()[0],
                1,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM municipality_flags"
                ).fetchone()[0],
                0,
            )
            connection.close()


if __name__ == "__main__":
    unittest.main()
