from __future__ import annotations

import re
from typing import Any

PREFECTURES: dict[str, tuple[str, str]] = {
    "Hokkaidō": ("01", "北海道"),
    "Aomori": ("02", "青森県"),
    "Iwate": ("03", "岩手県"),
    "Miyagi": ("04", "宮城県"),
    "Akita": ("05", "秋田県"),
    "Yamagata": ("06", "山形県"),
    "Fukushima": ("07", "福島県"),
    "Ibaraki": ("08", "茨城県"),
    "Tochigi": ("09", "栃木県"),
    "Gunma": ("10", "群馬県"),
    "Saitama": ("11", "埼玉県"),
    "Chiba": ("12", "千葉県"),
    "Tōkyō": ("13", "東京都"),
    "Kanagawa": ("14", "神奈川県"),
    "Niigata": ("15", "新潟県"),
    "Toyama": ("16", "富山県"),
    "Ishikawa": ("17", "石川県"),
    "Fukui": ("18", "福井県"),
    "Yamanashi": ("19", "山梨県"),
    "Nagano": ("20", "長野県"),
    "Gifu": ("21", "岐阜県"),
    "Shizuoka": ("22", "静岡県"),
    "Aichi": ("23", "愛知県"),
    "Mie": ("24", "三重県"),
    "Shiga": ("25", "滋賀県"),
    "Kyōto": ("26", "京都府"),
    "Ōsaka": ("27", "大阪府"),
    "Hyōgo": ("28", "兵庫県"),
    "Nara": ("29", "奈良県"),
    "Wakayama": ("30", "和歌山県"),
    "Tottori": ("31", "鳥取県"),
    "Shimane": ("32", "島根県"),
    "Okayama": ("33", "岡山県"),
    "Hiroshima": ("34", "広島県"),
    "Yamaguchi": ("35", "山口県"),
    "Tokushima": ("36", "徳島県"),
    "Kagawa": ("37", "香川県"),
    "Ehime": ("38", "愛媛県"),
    "Kōchi": ("39", "高知県"),
    "Fukuoka": ("40", "福岡県"),
    "Saga": ("41", "佐賀県"),
    "Nagasaki": ("42", "長崎県"),
    "Kumamoto": ("43", "熊本県"),
    "Ōita": ("44", "大分県"),
    "Miyazaki": ("45", "宮崎県"),
    "Kagoshima": ("46", "鹿児島県"),
    "Okinawa": ("47", "沖縄県"),
}

CATEGORY_PREFECTURE = re.compile(r" in (.+?)(?: Prefecture)?$")
PERIOD = re.compile(
    r"(?P<approx>c\.\s*)?"
    r"(?P<start>1[89]\d{2}|20\d{2})?"
    r"[–-](?P<end>1[89]\d{2}|20\d{2})"
)
TRAILING_PARENTHETICAL = re.compile(r"\s*\([^()]*\)\s*$")
ORDINAL_PREFIX = re.compile(r"^(?P<ordinal>\d+)(?:st|nd|rd|th) flag of ", re.I)
FLAG_PREFIX = re.compile(r"^Flag of ", re.I)


def _assignment(
    field_name: str,
    value: str | int,
    method: str,
    confidence: float,
    evidence: dict[str, Any],
) -> dict[str, Any]:
    return {
        "field_name": field_name,
        "value": str(value),
        "method": method,
        "confidence": confidence,
        "is_primary": True,
        "evidence": evidence,
    }


def classify_manifest_file(file: dict[str, Any]) -> list[dict[str, Any]]:
    categories = file["categories"]
    direct_category = categories[0]
    category_lower = direct_category.lower()
    category_kind = (
        "former"
        if "former" in category_lower
        else "historical"
        if "historical" in category_lower
        else "current"
    )

    title = file["title"].removeprefix("File:").removesuffix(".svg")
    period_match = PERIOD.search(title)
    lifecycle = (
        "historical"
        if category_kind != "current" or period_match or ORDINAL_PREFIX.match(title)
        else "current"
    )
    lifecycle_method = (
        "filename_period_override"
        if category_kind == "current" and period_match
        else "commons_category"
    )

    assignments = [
        _assignment(
            "category_kind",
            category_kind,
            "commons_category",
            1.0,
            {"category": direct_category},
        ),
        _assignment(
            "lifecycle_status",
            lifecycle,
            lifecycle_method,
            1.0 if lifecycle == "historical" else 0.98,
            {"category": direct_category, "title": file["title"]},
        ),
    ]

    prefecture_match = CATEGORY_PREFECTURE.search(direct_category)
    if prefecture_match:
        prefecture_label = prefecture_match.group(1)
        if prefecture_label not in PREFECTURES:
            raise ValueError(f"Unknown prefecture category label: {prefecture_label}")
        prefecture_code, prefecture_name = PREFECTURES[prefecture_label]
        assignments.extend(
            [
                _assignment(
                    "prefecture_code",
                    prefecture_code,
                    "commons_category",
                    1.0,
                    {"category": direct_category},
                ),
                _assignment(
                    "prefecture_name_ja",
                    prefecture_name,
                    "prefecture_lookup",
                    1.0,
                    {"category_label": prefecture_label},
                ),
            ]
        )

    ordinal_match = ORDINAL_PREFIX.match(title)
    if ordinal_match:
        assignments.append(
            _assignment(
                "variant_ordinal",
                ordinal_match.group("ordinal"),
                "filename_parse",
                1.0,
                {"title": file["title"]},
            )
        )
        name_hint = title[ordinal_match.end() :]
    else:
        name_hint = FLAG_PREFIX.sub("", title)

    if period_match:
        name_hint = TRAILING_PARENTHETICAL.sub("", name_hint).strip()
        if period_match.group("approx"):
            assignments.append(
                _assignment(
                    "period_approximate",
                    "true",
                    "filename_parse",
                    0.95,
                    {"title": file["title"]},
                )
            )
        if start := period_match.group("start"):
            assignments.append(
                _assignment(
                    "valid_from_year",
                    start,
                    "filename_parse",
                    0.85 if period_match.group("approx") else 0.95,
                    {"title": file["title"]},
                )
            )
        if end := period_match.group("end"):
            assignments.append(
                _assignment(
                    "valid_to_year",
                    end,
                    "filename_parse",
                    0.95,
                    {"title": file["title"]},
                )
            )

    municipality_hint = name_hint.rsplit(",", 1)[0].strip()
    assignments.extend(
        [
            _assignment(
                "name_hint_en",
                name_hint,
                "filename_parse",
                0.75,
                {"title": file["title"]},
            ),
            _assignment(
                "municipality_name_en_hint",
                municipality_hint,
                "filename_parse",
                0.7,
                {"title": file["title"]},
            ),
        ]
    )
    return assignments
