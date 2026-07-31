from __future__ import annotations

import unittest

from japan_flags.classification import classify_manifest_file


class ClassificationTest(unittest.TestCase):
    def _values(self, title: str, category: str) -> dict[str, str]:
        assignments = classify_manifest_file({"title": title, "categories": [category]})
        return {
            assignment["field_name"]: assignment["value"] for assignment in assignments
        }

    def test_current_flag(self) -> None:
        values = self._values(
            "File:Flag of Miyazaki, Miyazaki.svg",
            "Category:SVG flags of municipalities in Miyazaki Prefecture",
        )
        self.assertEqual(values["lifecycle_status"], "current")
        self.assertEqual(values["prefecture_code"], "45")
        self.assertEqual(values["prefecture_name_ja"], "宮崎県")
        self.assertEqual(values["municipality_name_en_hint"], "Miyazaki")

    def test_filename_period_overrides_current_category(self) -> None:
        values = self._values(
            "File:Flag of Isumi, Chiba (1973–2005).svg",
            "Category:SVG flags of municipalities in Chiba Prefecture",
        )
        self.assertEqual(values["category_kind"], "current")
        self.assertEqual(values["lifecycle_status"], "historical")
        self.assertEqual(values["valid_from_year"], "1973")
        self.assertEqual(values["valid_to_year"], "2005")

    def test_open_start_period_and_ordinal(self) -> None:
        historical = self._values(
            "File:Flag of Irihirose, Niigata (–2004).svg",
            "Category:SVG historical flags of municipalities in Niigata Prefecture",
        )
        self.assertNotIn("valid_from_year", historical)
        self.assertEqual(historical["valid_to_year"], "2004")

        ordinal = self._values(
            "File:1st flag of Saga, Saga.svg",
            "Category:SVG historical flags of municipalities in Saga Prefecture",
        )
        self.assertEqual(ordinal["variant_ordinal"], "1")
        self.assertEqual(ordinal["municipality_name_en_hint"], "Saga")

    def test_period_inside_variant_annotation(self) -> None:
        values = self._values(
            "File:Flag of Kasama, Ibaraki (orange; 1958–2006).svg",
            "Category:SVG historical flags of municipalities in Ibaraki Prefecture",
        )
        self.assertEqual(values["valid_from_year"], "1958")
        self.assertEqual(values["valid_to_year"], "2006")
        self.assertEqual(values["municipality_name_en_hint"], "Kasama")

        approximate = self._values(
            "File:Flag of Hisai, Mie (c. 1910–2005).svg",
            "Category:SVG historical flags of municipalities in Mie Prefecture",
        )
        self.assertEqual(approximate["period_approximate"], "true")

    def test_hyphenated_name_is_not_a_period(self) -> None:
        values = self._values(
            "File:Flag of Minami-alps, Yamanashi.svg",
            "Category:SVG flags of municipalities in Yamanashi Prefecture",
        )
        self.assertEqual(values["lifecycle_status"], "current")
        self.assertNotIn("valid_to_year", values)


if __name__ == "__main__":
    unittest.main()
