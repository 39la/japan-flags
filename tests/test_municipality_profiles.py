from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from japan_flags.database import ingest_n03, open_database
from japan_flags.municipality_profiles import (
    ingest_municipality_profiles,
    municipality_profile_targets,
    profile_values_from_entity,
)
from test_database import sample_acquisition


def quantity_claim(
    claim_id: str,
    amount: str,
    *,
    rank: str = "normal",
    unit: str = "1",
    date: str | None = None,
    precision: int = 11,
) -> dict:
    claim = {
        "id": claim_id,
        "rank": rank,
        "mainsnak": {
            "datavalue": {
                "value": {"amount": amount, "unit": unit},
            }
        },
    }
    if date:
        claim["qualifiers"] = {
            "P585": [
                {
                    "datavalue": {
                        "value": {
                            "time": f"+{date}T00:00:00Z",
                            "precision": precision,
                        }
                    }
                }
            ]
        }
    return claim


class MunicipalityProfileTest(unittest.TestCase):
    def test_claim_selection_prefers_rank_then_latest_date(self) -> None:
        entity = {
            "claims": {
                "P1082": [
                    quantity_claim(
                        "normal-new",
                        "+999",
                        date="2025-01-01",
                    ),
                    quantity_claim(
                        "preferred-old",
                        "+100",
                        rank="preferred",
                        date="2020-01-01",
                        precision=9,
                    ),
                    quantity_claim(
                        "preferred-new",
                        "+120",
                        rank="preferred",
                        date="2024-04-01",
                        precision=10,
                    ),
                ],
                "P2046": [
                    quantity_claim(
                        "area",
                        "+1500000",
                        unit="http://www.wikidata.org/entity/Q25343",
                    )
                ],
            },
            "sitelinks": {
                "jawiki": {
                    "title": "試験市",
                    "url": "https://ja.wikipedia.org/wiki/試験市",
                }
            },
        }

        values = profile_values_from_entity(entity)

        self.assertEqual(values["population"], 120)
        self.assertEqual(values["population_as_of"], "2024-04-01")
        self.assertEqual(values["population_date_precision"], 10)
        self.assertEqual(values["area_km2"], 1.5)
        self.assertEqual(values["jawiki_title"], "試験市")

    def test_failed_fetch_does_not_replace_snapshot_profiles(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            connection = open_database(Path(directory) / "test.sqlite")
            acquisition = sample_acquisition()
            ingest_n03(connection, acquisition)
            snapshot = acquisition["areas"][0]["boundary_date"]
            jis5 = acquisition["areas"][0]["jis5"]
            with connection:
                connection.execute(
                    """
                    INSERT INTO external_code_resolutions(
                      source_type, source_key, jis5, fetched_at
                    ) VALUES ('wikidata_item', 'Q1', ?, 'now')
                    """,
                    (jis5,),
                )
                connection.execute(
                    """
                    INSERT INTO municipality_profiles(
                      snapshot_date, jis5, resolution_status, fetched_at
                    ) VALUES (?, ?, 'unresolved', 'before')
                    """,
                    (snapshot, jis5),
                )

            with (
                patch(
                    "japan_flags.municipality_profiles._fetch_entities",
                    side_effect=RuntimeError("network"),
                ),
                self.assertRaises(RuntimeError),
            ):
                ingest_municipality_profiles(
                    connection,
                    snapshot_date=snapshot,
                )

            row = connection.execute(
                """
                SELECT fetched_at
                FROM municipality_profiles
                WHERE snapshot_date = ? AND jis5 = ?
                """,
                (snapshot, jis5),
            ).fetchone()
            self.assertEqual(row["fetched_at"], "before")
            connection.close()

    def test_designated_city_wards_create_one_parent_profile_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            connection = open_database(Path(directory) / "test.sqlite")
            acquisition = sample_acquisition()
            acquisition["areas"] = [
                {
                    **acquisition["areas"][0],
                    "jis5": jis5,
                    "prefecture_code": "27",
                    "municipality_name": "試験市",
                    "ward_name": ward_name,
                    "display_name": ward_name,
                }
                for jis5, ward_name in [
                    ("27102", "中央区"),
                    ("27111", "北区"),
                    ("27128", "南区"),
                ]
            ]
            ingest_n03(connection, acquisition)

            targets = municipality_profile_targets(connection, "20260101")

            self.assertEqual(
                targets,
                [
                    {
                        "jis5": "27100",
                        "prefecture_code": "27",
                        "display_name": "試験市",
                    }
                ],
            )
            connection.close()


if __name__ == "__main__":
    unittest.main()
