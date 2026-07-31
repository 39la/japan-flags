from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from japan_flags.database import open_database
from japan_flags.wikipedia_lists import (
    _build_jis5_index,
    _parse_date_cell,
    _parse_flag_color,
    _resolve_jis5,
    _split_table_cells,
    parse_list_page,
)

from test_database import sample_acquisition


def _seed_territory(
    connection,
    *,
    jis5: str,
    prefecture_code: str,
    prefecture_name: str,
    municipality_name: str,
    ward_name: str | None = None,
    display_name: str | None = None,
    entity_type: str = "municipality",
) -> None:
    connection.execute(
        """
        INSERT INTO territory_versions(
          snapshot_date, jis5, prefecture_code, prefecture_name,
          municipality_name, ward_name, display_name, entity_type,
          geometry_id, source_kind, source_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'test', 'http://x', '2026-01-01')
        """,
        (
            "20260101",
            jis5,
            prefecture_code,
            prefecture_name,
            municipality_name,
            ward_name,
            display_name or municipality_name,
            entity_type,
        ),
    )


class TestParseDateCell(unittest.TestCase):
    def test_full_date(self) -> None:
        result = _parse_date_cell("[[1925年]][[7月1日]]")
        self.assertEqual(result["enacted_on"], "1925-07-01")
        self.assertEqual(result["enacted_year"], 1925)
        self.assertEqual(result["enacted_month"], 7)
        self.assertEqual(result["enacted_day"], 1)
        self.assertEqual(result["enacted_precision"], "day")

    def test_year_and_month_only(self) -> None:
        result = _parse_date_cell("[[1911年]][[8月]]<ref name='p8'/>")
        self.assertEqual(result["enacted_on"], "1911-08")
        self.assertEqual(result["enacted_year"], 1911)
        self.assertEqual(result["enacted_month"], 8)
        self.assertIsNone(result["enacted_day"])
        self.assertEqual(result["enacted_precision"], "month")

    def test_approximate(self) -> None:
        result = _parse_date_cell("[[1822年]]頃")
        self.assertEqual(result["enacted_on"], "1822")
        self.assertEqual(result["enacted_year"], 1822)
        self.assertEqual(result["enacted_precision"], "approximate")

    def test_unknown(self) -> None:
        result = _parse_date_cell("不明")
        self.assertEqual(result["enacted_precision"], "unknown")
        self.assertIsNone(result["enacted_on"])

    def test_empty(self) -> None:
        result = _parse_date_cell("")
        self.assertEqual(result["enacted_precision"], "empty")


class TestParseFlagColor(unittest.TestCase):
    def test_standard(self) -> None:
        ground, emblem = _parse_flag_color(
            "地色は群青色であり、紋章は黄色が指定されている"
        )
        self.assertEqual(ground, "群青色")
        self.assertEqual(emblem, "黄色")

    def test_multi_color_emblem(self) -> None:
        ground, emblem = _parse_flag_color(
            "地色は白色であり、桜の形をした紋章は青色・紫色・緑色が指定されている"
        )
        self.assertEqual(ground, "白色")
        self.assertEqual(emblem, "青色・紫色・緑色")

    def test_ground_only(self) -> None:
        ground, emblem = _parse_flag_color("地色は深紫色である")
        self.assertEqual(ground, "深紫色")
        self.assertIsNone(emblem)

    def test_empty(self) -> None:
        self.assertEqual(_parse_flag_color(""), (None, None))


class TestSplitTableCells(unittest.TestCase):
    def test_simple_row(self) -> None:
        cells = _split_table_cells(
            "|[[宮崎市]]||[[File:X.svg]]||由来 ||[[1925年]][[7月1日]]||"
        )
        self.assertEqual(len(cells), 5)
        self.assertEqual(cells[0], "[[宮崎市]]")
        self.assertEqual(cells[1], "[[File:X.svg]]")
        self.assertEqual(cells[2], "由来 ")
        self.assertEqual(cells[3], "[[1925年]][[7月1日]]")
        self.assertEqual(cells[4], "")

    def test_template_in_cell(self) -> None:
        cells = _split_table_cells("|{{Cite web|url=X|title=Y}}||次のセル")
        self.assertEqual(len(cells), 2)
        self.assertTrue(cells[0].startswith("{{Cite web"))
        self.assertEqual(cells[1], "次のセル")


class TestParseListPage(unittest.TestCase):
    def test_emblem_all_sections(self) -> None:
        wikitext = (
            "== 市部 ==\n"
            '{|class= "wikitable"\n'
            "|-\n"
            "!市!!市章!!由来!!制定日!!備考\n"
            "|-\n"
            "|[[宮崎市]]||[[File:M.svg|100px]]||由来||[[1925年]][[7月1日]]||\n"
            "|-\n"
            "|[[札幌市]]||[[File:S.svg|100px]]||雪||[[1911年]][[8月]]||市旗別\n"
            "|}\n"
            "== 町村部 ==\n"
            '{|class= "wikitable"\n'
            "|-\n"
            "!郡!!町村!!町村章!!由来!!制定日!!備考\n"
            "|-\n"
            "|[[北諸県郡]]||[[三股町]]||[[File:M.svg]]||銀杏||[[1971年]][[8月1日]]||\n"
            "|}\n"
            "== 廃止された市町村章 ==\n"
            '{|class= "wikitable"\n'
            "|-\n"
            "!市郡!!町村!!市町村章!!由来!!制定日!!廃止日!!備考\n"
            "|-\n"
            "|[[宮崎郡]]||[[山田町_(宮崎県)]]||[[File:Y.jpg]]||円||[[1955年]][[1月31日]]||[[2006年]][[1月1日]]||\n"
            "|}\n"
        )
        rows = parse_list_page("宮崎県の市町村章一覧", wikitext)
        self.assertEqual(len(rows), 4)
        by_name = {row["display_name"]: row for row in rows}
        self.assertEqual(by_name["宮崎市"]["enacted_on"], "1925-07-01")
        self.assertEqual(by_name["札幌市"]["enacted_precision"], "month")
        self.assertEqual(by_name["三股町"]["prefecture_section"], "北諸県郡")
        self.assertEqual(by_name["山田町_(宮崎県)"]["section_kind"], "abandoned")
        self.assertEqual(by_name["山田町_(宮崎県)"]["abandoned_on"], "2006-01-01")

    def test_flag_with_absence(self) -> None:
        wikitext = (
            "== 市部 ==\n"
            '{|class= "wikitable"\n'
            "|-\n"
            "!市!!市旗!!制定有無!!制定日!!旗の色!!備考\n"
            "|-\n"
            "|[[A市]]||[[File:F1.svg]]||あり||[[2008年]][[4月1日]]||地色は赤色、紋章は金色||\n"
            "|-\n"
            "|[[B市]]||[[File:F2.svg]]||なし||[[2010年]][[1月1日]]||||\n"
            "|}\n"
        )
        rows = parse_list_page("X県の市町村旗一覧", wikitext)
        self.assertEqual(len(rows), 2)
        a_row, b_row = rows
        self.assertEqual(a_row["has_attribute"], 1)
        self.assertEqual(a_row["flag_ground_color"], "赤色")
        self.assertEqual(a_row["flag_emblem_color"], "金色")
        self.assertEqual(b_row["has_attribute"], 0)


class TestJis5Resolution(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        database_path = Path(self.tmp.name) / "test.sqlite"
        self.connection = open_database(database_path)
        acquisition = sample_acquisition()
        from japan_flags.database import ingest_n03

        ingest_n03(self.connection, acquisition)

    def tearDown(self) -> None:
        self.connection.close()
        self.tmp.cleanup()

    def test_index_returns_resolved(self) -> None:
        index = _build_jis5_index(self.connection, "20260101")
        self.assertEqual(_resolve_jis5(index, "99", "試験町"), ("99999", None))
        self.assertEqual(_resolve_jis5(index, "99", "未登録"), (None, "no_match"))


class TestIngestEndToEnd(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        database_path = Path(self.tmp.name) / "test.sqlite"
        self.connection = open_database(database_path)
        acquisition = sample_acquisition()
        from japan_flags.database import ingest_n03

        ingest_n03(self.connection, acquisition)

    def tearDown(self) -> None:
        self.connection.close()
        self.tmp.cleanup()

    def test_ingest_resolves_jis5(self) -> None:
        wikitext = (
            "== 市部 ==\n"
            '{|class= "wikitable"\n'
            "|-\n"
            "!市!!市章!!由来!!制定日!!備考\n"
            "|-\n"
            "|[[試験町]]||[[File:M.svg]]||由来||[[2000年]][[1月1日]]||\n"
            "|}\n"
        )
        rows = parse_list_page("試験県の市町村章一覧", wikitext)
        self.assertEqual(len(rows), 1)
        from japan_flags.wikipedia_lists import _upsert_rows

        inserted = _upsert_rows(
            self.connection,
            kind="emblem",
            rows=rows,
            prefecture_code="99",
            source_list_title="試験県の市町村章一覧",
            source_url="https://example/",
            fetched_at="2026-07-31T00:00:00Z",
            jis5_index=_build_jis5_index(self.connection, "20260101"),
        )
        self.assertEqual(inserted, 1)
        result = self.connection.execute(
            """
            SELECT jis5, display_name, enacted_on, resolution_status
            FROM municipality_wiki_attributes
            """
        ).fetchone()
        self.assertEqual(result["jis5"], "99999")
        self.assertEqual(result["display_name"], "試験町")
        self.assertEqual(result["enacted_on"], "2000-01-01")
        self.assertEqual(result["resolution_status"], "resolved")


if __name__ == "__main__":
    unittest.main()
