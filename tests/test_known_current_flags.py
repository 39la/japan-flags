from __future__ import annotations

import unittest

from japan_flags.known_current_flags import (
    KNOWN_CURRENT_FLAGS,
    add_known_current_flags,
    known_current_flag_matches,
)


class KnownCurrentFlagsTest(unittest.TestCase):
    def test_supplements_add_missing_files_without_duplicating_existing(self) -> None:
        existing = KNOWN_CURRENT_FLAGS[0]
        inventory = {
            "files": [
                {
                    "title": existing["title"],
                    "categories": [existing["category"]],
                }
            ]
        }
        added = add_known_current_flags(inventory)
        self.assertEqual(added, len(KNOWN_CURRENT_FLAGS) - 1)
        self.assertEqual(
            len({file["title"] for file in inventory["files"]}),
            len(KNOWN_CURRENT_FLAGS),
        )

    def test_known_matches_include_nine_direct_and_seven_inherited_edges(
        self,
    ) -> None:
        files = [
            {"page_id": index, "title": known["title"]}
            for index, known in enumerate(KNOWN_CURRENT_FLAGS, 1)
        ]
        municipalities = [
            {"jis5": jis5} for known in KNOWN_CURRENT_FLAGS for jis5 in known["jis5"]
        ]
        matches = known_current_flag_matches(files, municipalities)
        self.assertEqual(len(matches), 16)
        self.assertEqual(
            sum(match["method"] == "parent_city_flag_inheritance" for match in matches),
            7,
        )
        self.assertEqual(
            sum(match["method"] == "curated_commons_title_match" for match in matches),
            9,
        )


if __name__ == "__main__":
    unittest.main()
