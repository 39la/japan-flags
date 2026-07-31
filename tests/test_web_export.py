from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from japan_flags.database import ingest_n03, open_database
from japan_flags.web_export import _visual_placement, export_web_data
from test_database import sample_acquisition


class WebExportTest(unittest.TestCase):
    def test_visual_placement_uses_full_multipolygon_bounds(self) -> None:
        geometry = {
            "type": "MultiPolygon",
            "coordinates": [
                [[[130, 30], [132, 30], [132, 32], [130, 32], [130, 30]]],
                [[[150, 30], [151, 30], [151, 31], [150, 31], [150, 30]]],
            ],
        }
        placement = _visual_placement(json.dumps(geometry))
        self.assertIsNotNone(placement)
        assert placement is not None
        self.assertLess(placement["anchor"][0], 0.1)
        self.assertLess(placement["centroidAnchor"][0], 0.1)
        self.assertLess(placement["optimizedAnchor"][0], 0.1)
        self.assertEqual(placement["componentBounds"][0], 0)
        self.assertLess(placement["componentBounds"][2], 0.1)

    def test_exports_a_valid_searchable_feature_collection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "test.sqlite"
            connection = open_database(database_path)
            acquisition = sample_acquisition()
            detail_marker = [130.5, 31.00001]
            acquisition["areas"][0]["geometry"]["coordinates"][0][0].insert(
                2,
                detail_marker,
            )
            ingest_n03(connection, acquisition)
            result = export_web_data(
                connection,
                database_path=database_path,
                snapshot_date="20260101",
                output_directory=root / "public",
                comparison_output_directory=root / "comparison",
            )
            connection.close()
            payload = json.loads((root / "comparison/territories.geojson").read_text())
            overview = json.loads(
                (root / "comparison/territories-overview-l0.geojson").read_text()
            )
            chunk = json.loads((root / "comparison/territories/99.geojson").read_text())
            overview_topology = json.loads(
                (root / "public/data/territories-overview-l0.topojson").read_text()
            )
            chunk_topology = json.loads(
                (root / "public/data/territories/99-l3.topojson").read_text()
            )
            self.assertFalse((root / "public/data/territories.geojson").exists())
            self.assertFalse((root / "public/data/territories/99.geojson").exists())
            self.assertEqual(
                result["comparison_geojson_path"],
                str(root / "comparison/territories.geojson"),
            )
            self.assertEqual(payload["type"], "FeatureCollection")
            self.assertEqual(payload["metadata"]["simplificationTolerance"], 0.0)
            self.assertNotIn(
                "simplificationToleranceUnit",
                payload["metadata"],
            )
            self.assertEqual(
                payload["metadata"]["simplification"]["algorithm"],
                "none",
            )
            self.assertEqual(result["territories"], 1)
            self.assertEqual(result["matched_flags"], 0)
            self.assertEqual(result["prefecture_chunks"], 3)
            for lod in ("l1", "l2", "l3"):
                self.assertTrue(
                    (root / f"public/data/territories/99-{lod}.topojson").exists()
                )
            self.assertEqual(overview["metadata"]["detailLevel"], "overview")
            self.assertEqual(
                overview["metadata"]["simplification"]["algorithm"],
                "visvalingam-whyatt-coverage",
            )
            self.assertEqual(len(overview["features"]), 1)
            self.assertEqual(chunk["metadata"]["prefectureCode"], "99")
            self.assertEqual(len(chunk["features"]), 1)
            self.assertEqual(overview_topology["type"], "Topology")
            self.assertIn("territories", overview_topology["objects"])
            self.assertTrue(overview_topology["arcs"])
            self.assertEqual(
                overview_topology["metadata"]["quantization"],
                32_768,
            )
            self.assertEqual(overview["metadata"]["geometryLod"], "l0")
            self.assertEqual(
                overview["metadata"]["simplification"]["targetScreenError"],
                0.25,
            )
            self.assertEqual(
                chunk_topology["metadata"]["prefectureCode"],
                "99",
            )
            self.assertNotIn("boundaryMeshes", overview_topology)
            self.assertNotIn("boundaryMeshes", chunk_topology)
            self.assertEqual(
                chunk_topology["objects"]["territories"]["geometries"][0]["bbox"],
                [130.0, 30.0, 131.0, 31.00001],
            )
            properties = payload["features"][0]["properties"]
            self.assertEqual(properties["jis5"], "99999")
            self.assertEqual(properties["displayName"], "試験町")
            self.assertIsNone(properties["flagPath"])
            self.assertEqual(len(properties["visualAnchor"]), 2)
            self.assertEqual(len(properties["visualCentroidAnchor"]), 2)
            self.assertEqual(len(properties["visualOptimizedAnchor"]), 2)
            self.assertEqual(len(properties["visualComponentBounds"]), 4)
            self.assertGreater(properties["visualSafeRadiusRatio"], 0)
            profile_chunk = json.loads(
                (root / "public/data/profiles/99.json").read_text()
            )
            self.assertEqual(profile_chunk["version"], 1)
            self.assertEqual(
                profile_chunk["profiles"]["99999"]["resolutionStatus"],
                "unresolved",
            )
            self.assertEqual(
                result["municipality_profiles"]["profiles"],
                1,
            )
            geometry = payload["features"][0]["geometry"]
            self.assertEqual(
                payload["features"][0]["bbox"],
                [130.0, 30.0, 131.0, 31.00001],
            )
            ring = (
                geometry["coordinates"][0]
                if geometry["type"] == "Polygon"
                else geometry["coordinates"][0][0]
            )
            self.assertIn(detail_marker, ring)
            signed_area = sum(
                x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:])
            )
            self.assertLess(signed_area, 0, "D3 outer rings must be clockwise")

    def test_designated_city_wards_are_unified_for_the_map(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "test.sqlite"
            connection = open_database(database_path)
            acquisition = sample_acquisition()
            acquisition["areas"] = [
                {
                    **acquisition["areas"][0],
                    "jis5": jis5,
                    "prefecture_code": "99",
                    "municipality_name": "試験市",
                    "ward_name": ward_name,
                    "display_name": ward_name,
                    "bbox": [x0, 30.0, x0 + 1.0, 31.0],
                    "geometry": {
                        "type": "MultiPolygon",
                        "coordinates": [
                            [
                                [
                                    [x0, 30.0],
                                    [x0, 31.0],
                                    [x0 + 1.0, 31.0],
                                    [x0 + 1.0, 30.0],
                                    [x0, 30.0],
                                ]
                            ]
                        ],
                    },
                }
                for jis5, ward_name, x0 in [
                    ("99101", "東区", 130.0),
                    ("99102", "西区", 131.0),
                    ("99111", "北区", 132.0),
                ]
            ]
            ingest_n03(connection, acquisition)
            export_web_data(
                connection,
                database_path=database_path,
                snapshot_date="20260101",
                output_directory=root / "public",
                comparison_output_directory=root / "comparison",
            )
            connection.close()

            payload = json.loads((root / "comparison/territories.geojson").read_text())
            self.assertEqual(payload["metadata"]["sourceTerritoryCount"], 3)
            self.assertEqual(payload["metadata"]["territoryCount"], 1)
            self.assertEqual(len(payload["features"]), 1)
            feature = payload["features"][0]
            properties = feature["properties"]
            self.assertEqual(properties["jis5"], "99100")
            self.assertEqual(properties["displayName"], "試験市")
            self.assertEqual(properties["entityType"], "designated_city")
            self.assertEqual(properties["aggregationKind"], "designated_city_wards")
            self.assertEqual(
                properties["memberJis5s"],
                ["99101", "99102", "99111"],
            )
            self.assertEqual(properties["wardNames"], ["北区", "東区", "西区"])
            self.assertEqual(properties["wardCount"], 3)
            profile_chunk = json.loads(
                (root / "public/data/profiles/99.json").read_text()
            )
            self.assertIn("99100", profile_chunk["profiles"])
            self.assertEqual(feature["geometry"]["type"], "Polygon")

    def test_detail_export_preserves_subpixel_islands(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_path = root / "test.sqlite"
            connection = open_database(database_path)
            acquisition = sample_acquisition()
            acquisition["areas"][0]["geometry"]["coordinates"].append(
                [
                    [
                        [132.0, 30.0],
                        [132.0, 30.00001],
                        [132.00001, 30.00001],
                        [132.00001, 30.0],
                        [132.0, 30.0],
                    ]
                ]
            )
            ingest_n03(connection, acquisition)
            export_web_data(
                connection,
                database_path=database_path,
                snapshot_date="20260101",
                output_directory=root / "public",
                comparison_output_directory=root / "comparison",
            )
            connection.close()

            payload = json.loads((root / "comparison/territories.geojson").read_text())
            self.assertEqual(payload["metadata"]["minPartArea"], 0.0)
            self.assertEqual(
                payload["metadata"]["simplification"]["algorithm"],
                "none",
            )
            self.assertEqual(
                payload["features"][0]["geometry"]["type"],
                "MultiPolygon",
            )


if __name__ == "__main__":
    unittest.main()
