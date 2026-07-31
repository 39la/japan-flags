from __future__ import annotations

import unittest

from japan_flags.matching import match_commons_files_to_municipalities
from japan_flags.national_matching import _choose_primary_flags


class MatchingTest(unittest.TestCase):
    def test_exact_japanese_wikipedia_usage(self) -> None:
        files = [
            {
                "page_id": 1,
                "title": "File:Flag of Example.svg",
                "global_usage": [
                    {
                        "wiki": "en.wikipedia.org",
                        "ns": "0",
                        "title": "Example,_Miyazaki",
                    },
                    {
                        "wiki": "ja.wikipedia.org",
                        "ns": "0",
                        "title": "試験町",
                    },
                ],
            }
        ]
        municipalities = [
            {
                "jis5": "99999",
                "display_name": "試験町",
                "municipality_name": "試験町",
                "ward_name": None,
            }
        ]
        result = match_commons_files_to_municipalities(files, municipalities)
        self.assertEqual(
            result["matches"],
            [
                {
                    "jis5": "99999",
                    "page_id": 1,
                    "method": "jawiki_globalusage_exact",
                    "confidence": 1.0,
                    "title": "File:Flag of Example.svg",
                }
            ],
        )
        self.assertEqual(result["unmatched"], [])

    def test_wikidata_code_fallback_via_enwiki_usage(self) -> None:
        files = [
            {
                "page_id": 2,
                "title": "File:Flag of Example.svg",
                "global_usage": [
                    {
                        "wiki": "en.wikipedia.org",
                        "ns": "0",
                        "title": "Example,_Miyazaki",
                    }
                ],
            }
        ]
        municipalities = [
            {
                "jis5": "99999",
                "display_name": "試験町",
                "municipality_name": "試験町",
                "ward_name": None,
            }
        ]
        result = match_commons_files_to_municipalities(
            files,
            municipalities,
            enwiki_codes={"Example,_Miyazaki": "99999"},
        )
        self.assertEqual(result["matches"][0]["jis5"], "99999")
        self.assertEqual(
            result["matches"][0]["method"],
            "wikidata_p429_filename_enwiki_exact",
        )

    def test_filename_matching_resolves_ambiguous_global_usage(self) -> None:
        files = [
            {
                "page_id": 3,
                "title": "File:Flag of Chofu, Tokyo.svg",
                "global_usage": [
                    {
                        "wiki": "ja.wikipedia.org",
                        "ns": "0",
                        "title": "調布市",
                    },
                    {
                        "wiki": "ja.wikipedia.org",
                        "ns": "0",
                        "title": "狛江市",
                    },
                    {
                        "wiki": "en.wikipedia.org",
                        "ns": "0",
                        "title": "Chofu,_Tokyo",
                    },
                ],
            }
        ]
        municipalities = [
            {
                "jis5": "13208",
                "display_name": "調布市",
                "municipality_name": "調布市",
                "ward_name": None,
            },
            {
                "jis5": "13219",
                "display_name": "狛江市",
                "municipality_name": "狛江市",
                "ward_name": None,
            },
        ]
        result = match_commons_files_to_municipalities(
            files,
            municipalities,
            enwiki_codes={"Chofu,_Tokyo": "13208"},
        )
        self.assertEqual(result["matches"][0]["jis5"], "13208")
        self.assertEqual(
            result["matches"][0]["method"],
            "wikidata_p429_filename_enwiki_exact",
        )

    def test_unreferenced_variant_uses_matched_sibling(self) -> None:
        files = [
            {
                "page_id": 4,
                "title": "File:Flag of Mikurajima, Tokyo (no text).svg",
                "global_usage": [
                    {
                        "wiki": "ja.wikipedia.org",
                        "ns": "0",
                        "title": "御蔵島村",
                    }
                ],
            },
            {
                "page_id": 5,
                "title": "File:Flag of Mikurajima, Tokyo.svg",
                "global_usage": [],
            },
        ]
        municipalities = [
            {
                "jis5": "13382",
                "display_name": "御蔵島村",
                "municipality_name": "御蔵島村",
                "ward_name": None,
            }
        ]
        result = match_commons_files_to_municipalities(files, municipalities)
        self.assertEqual(len(result["matches"]), 2)
        sibling = next(match for match in result["matches"] if match["page_id"] == 5)
        self.assertEqual(sibling["jis5"], "13382")
        self.assertEqual(sibling["method"], "filename_variant_sibling")
        self.assertEqual(result["unmatched"], [])

    def test_parent_city_flag_is_inherited_by_ward_polygons(self) -> None:
        files = [
            {
                "page_id": 6,
                "title": "File:Flag of Osaka, Osaka.svg",
                "global_usage": [
                    {
                        "wiki": "en.wikipedia.org",
                        "ns": "0",
                        "title": "Osaka",
                    }
                ],
            }
        ]
        municipalities = [
            {
                "jis5": "27102",
                "display_name": "都島区",
                "municipality_name": "大阪市",
                "ward_name": "都島区",
            },
            {
                "jis5": "27103",
                "display_name": "福島区",
                "municipality_name": "大阪市",
                "ward_name": "福島区",
            },
            {
                "jis5": "27205",
                "display_name": "吹田市",
                "municipality_name": "吹田市",
                "ward_name": None,
            },
        ]
        result = match_commons_files_to_municipalities(
            files,
            municipalities,
            enwiki_codes={"Osaka": "27100"},
        )
        self.assertEqual(
            {match["jis5"] for match in result["matches"]},
            {"27102", "27103"},
        )
        self.assertTrue(
            all(
                match["method"] == "parent_city_flag_inheritance"
                for match in result["matches"]
            )
        )
        self.assertEqual(result["unmatched"], [])

    def test_prefecture_hint_disambiguates_duplicate_japanese_names(self) -> None:
        files = [
            {
                "page_id": 7,
                "title": "File:Flag of Chuo, Tokyo.svg",
                "prefecture_code": "13",
                "global_usage": [
                    {
                        "wiki": "ja.wikipedia.org",
                        "ns": "0",
                        "title": "中央区",
                    }
                ],
            }
        ]
        municipalities = [
            {
                "jis5": "13102",
                "display_name": "中央区",
                "municipality_name": "中央区",
                "ward_name": None,
            },
            {
                "jis5": "27128",
                "display_name": "中央区",
                "municipality_name": "大阪市",
                "ward_name": "中央区",
            },
        ]
        result = match_commons_files_to_municipalities(files, municipalities)
        self.assertEqual(result["matches"][0]["jis5"], "13102")

    def test_wikidata_item_usage_matches_p429_code(self) -> None:
        files = [
            {
                "page_id": 8,
                "title": "File:Flag of Example.svg",
                "prefecture_code": "99",
                "global_usage": [
                    {
                        "wiki": "www.wikidata.org",
                        "ns": "0",
                        "title": "Q12345",
                    }
                ],
            }
        ]
        municipalities = [
            {
                "jis5": "99999",
                "display_name": "試験町",
                "municipality_name": "試験町",
                "ward_name": None,
            }
        ]
        result = match_commons_files_to_municipalities(
            files,
            municipalities,
            wikidata_item_codes={"Q12345": "99999"},
        )
        self.assertEqual(result["matches"][0]["jis5"], "99999")
        self.assertEqual(
            result["matches"][0]["method"],
            "wikidata_p429_item_usage",
        )

    def test_wikidata_code_overrides_incorrect_category_prefecture(self) -> None:
        files = [
            {
                "page_id": 9,
                "title": "File:Flag of Test, Correct Prefecture.svg",
                "prefecture_code": "98",
                "global_usage": [
                    {
                        "wiki": "www.wikidata.org",
                        "ns": "0",
                        "title": "Q99999",
                    }
                ],
            }
        ]
        municipalities = [
            {
                "jis5": "99999",
                "display_name": "試験町",
                "municipality_name": "試験町",
                "ward_name": None,
            }
        ]
        result = match_commons_files_to_municipalities(
            files,
            municipalities,
            wikidata_item_codes={"Q99999": "99999"},
        )
        self.assertEqual(result["matches"][0]["jis5"], "99999")

    def test_parent_city_inheritance_includes_reorganized_ward_code(self) -> None:
        files = [
            {
                "page_id": 12,
                "title": "File:Flag of Example City.svg",
                "prefecture_code": "99",
                "global_usage": [
                    {
                        "wiki": "www.wikidata.org",
                        "ns": "0",
                        "title": "Q12000",
                    }
                ],
            }
        ]
        municipalities = [
            {
                "jis5": "99108",
                "display_name": "中央区",
                "municipality_name": "試験市",
                "ward_name": "中央区",
            },
            {
                "jis5": "99110",
                "display_name": "天竜区",
                "municipality_name": "試験市",
                "ward_name": "天竜区",
            },
        ]
        result = match_commons_files_to_municipalities(
            files,
            municipalities,
            wikidata_item_codes={"Q12000": "99100"},
        )
        self.assertEqual(
            {match["jis5"] for match in result["matches"]},
            {"99108", "99110"},
        )

    def test_direct_ward_flag_is_primary_over_inherited_city_flag(self) -> None:
        matches = [
            {
                "jis5": "99999",
                "page_id": 10,
                "title": "File:Flag of Example City.svg",
                "method": "parent_city_flag_inheritance",
            },
            {
                "jis5": "99999",
                "page_id": 11,
                "title": "File:Flag of Example Ward.svg",
                "method": "wikidata_p429_item_usage",
            },
        ]
        _choose_primary_flags(matches)
        primary = next(match for match in matches if match["is_primary"])
        self.assertEqual(primary["page_id"], 11)


if __name__ == "__main__":
    unittest.main()
