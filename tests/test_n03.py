from __future__ import annotations

import unittest

from japan_flags.n03 import aggregate_n03


class AggregateN03Test(unittest.TestCase):
    def test_groups_fragmented_polygons_by_five_digit_code(self) -> None:
        properties = {
            "N03_001": "試験県",
            "N03_002": None,
            "N03_003": "試験郡",
            "N03_004": "試験町",
            "N03_005": None,
            "N03_007": "99999",
        }
        geojson = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": properties,
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [[130, 30], [131, 30], [131, 31], [130, 31], [130, 30]]
                        ],
                    },
                },
                {
                    "type": "Feature",
                    "properties": properties,
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [[132, 32], [133, 32], [133, 33], [132, 33], [132, 32]]
                        ],
                    },
                },
            ],
        }

        areas = aggregate_n03(geojson, "20260101")
        self.assertEqual(len(areas), 1)
        self.assertEqual(areas[0]["feature_count"], 2)
        self.assertEqual(areas[0]["geometry"]["type"], "MultiPolygon")
        self.assertEqual(len(areas[0]["geometry"]["coordinates"]), 2)
        self.assertEqual(areas[0]["bbox"], [130, 30, 133, 33])


if __name__ == "__main__":
    unittest.main()
