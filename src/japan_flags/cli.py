from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any

from .bulk_svg import DEFAULT_ROOT, acquire_all_svg
from .classification import classify_manifest_file
from .cli_context import CliContext, print_json
from .commons import acquire_commons_data
from .database import (
    build_report,
    finish_run,
    ingest_commons,
    ingest_matches,
    ingest_n03,
    ingest_flag_asset_manifest,
    start_run,
)
from .matching import (
    choose_primary_flags,
    enwiki_titles,
    match_commons_files_to_municipalities,
)
from .n03 import acquire_n03_data
from .http import polite_delay
from .national_matching import match_current_flags_nationally
from .municipality_profiles import ingest_municipality_profiles
from .prefectures import ingest_current_prefectures
from .web_export import (
    DEFAULT_OVERVIEW_VW_TOLERANCE,
    export_web_data,
)
from .wikidata import fetch_wikidata_codes_for_enwiki_titles
from .wikipedia_lists import ingest_wikipedia_lists


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="japan-flags")
    subparsers = parser.add_subparsers(dest="command", required=True)

    ingest = subparsers.add_parser("ingest")
    ingest.add_argument("--prefecture-code", required=True)
    ingest.add_argument("--prefecture-name", required=True)
    ingest.add_argument("--commons-category", required=True)
    ingest.add_argument("--n03-date", required=True)
    ingest.add_argument("--data-dir", type=Path, default=Path("data"))
    ingest.add_argument("--database", type=Path)
    ingest.add_argument("--refresh", action="store_true")
    ingest.add_argument("--recursive-commons", action="store_true")

    report = subparsers.add_parser("report")
    report.add_argument("--prefecture-code")
    report.add_argument("--data-dir", type=Path, default=Path("data"))
    report.add_argument("--database", type=Path)

    fetch_svg = subparsers.add_parser("fetch-svg-all")
    fetch_svg.add_argument("--root-category", default=DEFAULT_ROOT)
    fetch_svg.add_argument("--data-dir", type=Path, default=Path("data"))
    fetch_svg.add_argument("--workers", type=int, default=8)
    fetch_svg.add_argument("--refresh", action="store_true")

    classify_svg = subparsers.add_parser("classify-svg")
    classify_svg.add_argument("--data-dir", type=Path, default=Path("data"))
    classify_svg.add_argument("--database", type=Path)

    national = subparsers.add_parser("ingest-current-national")
    national.add_argument("--n03-date", required=True)
    national.add_argument("--data-dir", type=Path, default=Path("data"))
    national.add_argument("--database", type=Path)
    national.add_argument("--refresh", action="store_true")

    export_web = subparsers.add_parser("export-web")
    export_web.add_argument("--snapshot-date", required=True)
    export_web.add_argument("--data-dir", type=Path, default=Path("data"))
    export_web.add_argument("--database", type=Path)
    export_web.add_argument(
        "--output",
        type=Path,
        default=Path("web/public"),
    )
    export_web.add_argument(
        "--comparison-output",
        type=Path,
        default=Path("data/derived/web-geojson"),
    )
    export_web.add_argument(
        "--overview-vw-tolerance",
        type=float,
        default=DEFAULT_OVERVIEW_VW_TOLERANCE,
    )

    match_national = subparsers.add_parser("match-current-national")
    match_national.add_argument("--snapshot-date", required=True)
    match_national.add_argument("--data-dir", type=Path, default=Path("data"))
    match_national.add_argument("--database", type=Path)
    match_national.add_argument("--refresh-usage", action="store_true")

    prefectures = subparsers.add_parser("ingest-current-prefectures")
    prefectures.add_argument("--snapshot-date", required=True)
    prefectures.add_argument("--data-dir", type=Path, default=Path("data"))
    prefectures.add_argument("--database", type=Path)
    prefectures.add_argument("--refresh", action="store_true")

    profiles = subparsers.add_parser("ingest-municipality-profiles")
    profiles.add_argument("--snapshot-date", required=True)
    profiles.add_argument("--data-dir", type=Path, default=Path("data"))
    profiles.add_argument("--database", type=Path)
    profiles.add_argument("--refresh", action="store_true")
    profiles.add_argument("--jis5", action="append", default=[])

    wiki_lists = subparsers.add_parser("wikipedia-lists-ingest")
    wiki_lists.add_argument("--snapshot-date", required=True)
    wiki_lists.add_argument("--data-dir", type=Path, default=Path("data"))
    wiki_lists.add_argument("--database", type=Path)
    wiki_lists.add_argument(
        "--kind",
        action="append",
        choices=["emblem", "flag"],
        default=[],
    )
    wiki_lists.add_argument("--refresh-titles", action="store_true")
    wiki_lists.add_argument("--refresh-pages", action="store_true")
    return parser


def _ingest(arguments: argparse.Namespace) -> None:
    prefecture_code = arguments.prefecture_code.zfill(2)
    context = CliContext.from_arguments(arguments, create_data_directory=True)
    data_directory = context.data_directory
    database_path = context.database_path
    connection = context.open_connection()
    parameters = {
        "prefecture_code": prefecture_code,
        "prefecture_name": arguments.prefecture_name,
        "category": arguments.commons_category,
        "n03_date": arguments.n03_date,
        "refresh": arguments.refresh,
    }
    run_id = start_run(connection, parameters)

    try:
        print(f"N03: {arguments.prefecture_name} ({prefecture_code})", flush=True)
        n03 = acquire_n03_data(
            prefecture_code=prefecture_code,
            n03_date=arguments.n03_date,
            raw_directory=data_directory / "raw" / "n03",
            refresh=arguments.refresh,
        )
        ingest_n03(connection, n03)
        print(
            f"  {n03['feature_count']} features -> {len(n03['areas'])} areas",
            flush=True,
        )

        print(f"Commons: {arguments.commons_category}", flush=True)
        commons = acquire_commons_data(
            category=arguments.commons_category,
            raw_directory=data_directory / "raw" / "commons",
            asset_directory=data_directory / "assets" / "commons",
            refresh=arguments.refresh,
            recursive=arguments.recursive_commons,
        )
        ingest_commons(connection, commons, database_path)
        print(f"  {len(commons['files'])} SVG files", flush=True)

        flag_target_areas = [
            area for area in n03["areas"] if area["municipality_name"] != "所属未定地"
        ]
        matching = match_commons_files_to_municipalities(
            commons["files"],
            flag_target_areas,
        )
        if matching["unmatched"]:
            unmatched_ids = {file["page_id"] for file in matching["unmatched"]}
            unmatched_files = [
                file for file in commons["files"] if file["page_id"] in unmatched_ids
            ]
            enwiki_codes = fetch_wikidata_codes_for_enwiki_titles(
                enwiki_titles(unmatched_files)
            )
            matching = match_commons_files_to_municipalities(
                commons["files"],
                flag_target_areas,
                enwiki_codes=enwiki_codes,
            )
        choose_primary_flags(matching["matches"])
        ingest_matches(
            connection,
            matching["matches"],
            snapshot_date=arguments.n03_date,
        )
        linked_page_ids = {match["page_id"] for match in matching["matches"]}
        alternate_page_ids = {
            match["page_id"] for match in matching["matches"] if not match["is_primary"]
        }
        report = {
            **build_report(connection, prefecture_code),
            "flag_files": len(commons["files"]),
            "linked_flag_files": len(linked_page_ids),
            "flag_file_coverage_pct": round(
                100 * len(linked_page_ids) / len(commons["files"]),
                2,
            ),
            "polygon_coverage_pct": 0.0,
            "alternate_flag_files": len(alternate_page_ids),
            "flag_polygon_edges": len(matching["matches"]),
            "excluded_nonmunicipal_areas": len(n03["areas"]) - len(flag_target_areas),
            "match_methods": dict(
                Counter(match["method"] for match in matching["matches"])
            ),
            "unmatched_details": matching["unmatched"],
            "n03_cache_hit": n03["cache_hit"],
            "commons_cache_hit": commons["cache_hit"],
        }
        report["polygon_coverage_pct"] = round(
            100 * report["matched"] / report["municipalities"],
            2,
        )
        derived_directory = data_directory / "derived"
        derived_directory.mkdir(parents=True, exist_ok=True)
        reconciliation_path = (
            derived_directory
            / f"reconciliation-{prefecture_code}-{arguments.n03_date}.json"
        )
        reconciliation_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n"
        )
        finish_run(connection, run_id, "completed", report)
        print_json(report)
    except Exception as error:
        finish_run(
            connection,
            run_id,
            "failed",
            {"type": type(error).__name__, "message": str(error)},
        )
        raise
    finally:
        connection.close()


def _report(arguments: argparse.Namespace) -> None:
    context = CliContext.from_arguments(arguments)
    connection = context.open_connection()
    try:
        report: dict[str, Any] = build_report(
            connection,
            arguments.prefecture_code,
        )
        print_json(report)
    finally:
        connection.close()


def _fetch_svg_all(arguments: argparse.Namespace) -> None:
    if not 1 <= arguments.workers <= 16:
        raise ValueError("--workers must be between 1 and 16")
    data_directory = CliContext.from_arguments(arguments).data_directory
    result = acquire_all_svg(
        root_category=arguments.root_category,
        raw_directory=data_directory / "raw" / "commons",
        asset_directory=data_directory / "assets" / "commons",
        workers=arguments.workers,
        refresh=arguments.refresh,
    )
    print_json(result)


def _classify_svg(arguments: argparse.Namespace) -> None:
    context = CliContext.from_arguments(arguments)
    data_directory = context.data_directory
    database_path = context.database_path
    manifest_path = (
        data_directory / "raw" / "commons" / "all-municipal-svg-manifest.json"
    )
    manifest = json.loads(manifest_path.read_text())
    assignments_by_page = {
        int(file["page_id"]): classify_manifest_file(file) for file in manifest["files"]
    }
    connection = context.open_connection()
    try:
        ingest_flag_asset_manifest(
            connection,
            manifest,
            data_directory / "assets" / "commons",
            assignments_by_page,
            database_path,
        )
        rows = connection.execute(
            """
            SELECT lifecycle_status, COUNT(*) AS count
            FROM flag_asset_catalog
            GROUP BY lifecycle_status
            ORDER BY lifecycle_status
            """
        ).fetchall()
        lifecycle_counts = {row[0]: row[1] for row in rows}
        historical_count = lifecycle_counts.get("historical", 0)
        historical_without_end = connection.execute(
            """
            SELECT page_id, commons_title
            FROM flag_asset_catalog
            WHERE lifecycle_status = 'historical' AND valid_to_year IS NULL
            ORDER BY commons_title
            """
        ).fetchall()
        override_count = connection.execute(
            """
            SELECT COUNT(*)
            FROM flag_asset_assignments
            WHERE field_name = 'lifecycle_status'
              AND method = 'filename_period_override'
              AND is_primary = 1
            """
        ).fetchone()[0]
        duplicate_primary_count = connection.execute(
            """
            SELECT COUNT(*) FROM (
              SELECT page_id, field_name
              FROM flag_asset_assignments
              WHERE is_primary = 1
              GROUP BY page_id, field_name
              HAVING COUNT(*) > 1
            )
            """
        ).fetchone()[0]
        report = {
            "assets": len(manifest["files"]),
            "lifecycle": lifecycle_counts,
            "prefecture_assigned": connection.execute(
                """
                SELECT COUNT(*) FROM flag_asset_catalog
                WHERE prefecture_code IS NOT NULL
                """
            ).fetchone()[0],
            "name_hint_assigned": connection.execute(
                """
                SELECT COUNT(*) FROM flag_asset_catalog
                WHERE municipality_name_en_hint IS NOT NULL
                """
            ).fetchone()[0],
            "valid_from_assigned": connection.execute(
                """
                SELECT COUNT(*) FROM flag_asset_catalog
                WHERE valid_from_year IS NOT NULL
                """
            ).fetchone()[0],
            "valid_to_assigned": connection.execute(
                """
                SELECT COUNT(*) FROM flag_asset_catalog
                WHERE valid_to_year IS NOT NULL
                """
            ).fetchone()[0],
            "historical_end_year_coverage_pct": round(
                100
                * (historical_count - len(historical_without_end))
                / historical_count,
                2,
            ),
            "quality_checks": {
                "current_category_overridden_by_filename_period": override_count,
                "duplicate_primary_fields": duplicate_primary_count,
                "historical_without_end_year": len(historical_without_end),
            },
            "open_items": {
                "historical_without_end_year": [
                    {"page_id": row[0], "commons_title": row[1]}
                    for row in historical_without_end
                ]
            },
        }
        derived_directory = data_directory / "derived"
        derived_directory.mkdir(parents=True, exist_ok=True)
        report_path = derived_directory / "svg-classification-report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print_json(report)
    finally:
        connection.close()


def _ingest_current_national(arguments: argparse.Namespace) -> None:
    context = CliContext.from_arguments(arguments, create_data_directory=True)
    data_directory = context.data_directory
    connection = context.open_connection()
    parameters = {
        "command": "ingest-current-national",
        "n03_date": arguments.n03_date,
        "refresh": arguments.refresh,
    }
    run_id = start_run(connection, parameters)
    results: list[dict[str, Any]] = []
    try:
        for number in range(1, 48):
            prefecture_code = f"{number:02d}"
            print(f"N03: {prefecture_code}/47", flush=True)
            acquisition = acquire_n03_data(
                prefecture_code=prefecture_code,
                n03_date=arguments.n03_date,
                raw_directory=data_directory / "raw" / "n03",
                refresh=arguments.refresh,
            )
            ingest_n03(connection, acquisition)
            results.append(
                {
                    "prefecture_code": prefecture_code,
                    "areas": len(acquisition["areas"]),
                    "source_features": acquisition["feature_count"],
                    "cache_hit": acquisition["cache_hit"],
                }
            )
            if not acquisition["cache_hit"]:
                polite_delay(0.1)
        result = {
            "snapshot_date": arguments.n03_date,
            "prefectures": len(results),
            "territories": sum(item["areas"] for item in results),
            "source_features": sum(item["source_features"] for item in results),
            "details": results,
        }
        finish_run(connection, run_id, "completed", result)
        print_json(result)
    except Exception as error:
        finish_run(
            connection,
            run_id,
            "failed",
            {"type": type(error).__name__, "message": str(error), "details": results},
        )
        raise
    finally:
        connection.close()


def _export_web(arguments: argparse.Namespace) -> None:
    context = CliContext.from_arguments(arguments)
    database_path = context.database_path
    connection = context.open_connection()
    try:
        result = export_web_data(
            connection,
            database_path=database_path,
            snapshot_date=arguments.snapshot_date,
            output_directory=arguments.output.resolve(),
            comparison_output_directory=arguments.comparison_output.resolve(),
            overview_vw_tolerance=arguments.overview_vw_tolerance,
        )
        print_json(result)
    finally:
        connection.close()


def _match_current_national(arguments: argparse.Namespace) -> None:
    context = CliContext.from_arguments(arguments)
    data_directory = context.data_directory
    connection = context.open_connection()
    try:
        report = match_current_flags_nationally(
            connection,
            snapshot_date=arguments.snapshot_date,
            report_path=(
                data_directory
                / "derived"
                / f"national-current-reconciliation-{arguments.snapshot_date}.json"
            ),
            refresh_usage=arguments.refresh_usage,
        )
        print_json(report)
    finally:
        connection.close()


def _ingest_current_prefectures(arguments: argparse.Namespace) -> None:
    context = CliContext.from_arguments(arguments)
    data_directory = context.data_directory
    database_path = context.database_path
    connection = context.open_connection()
    try:
        result = ingest_current_prefectures(
            connection,
            database_path=database_path,
            data_directory=data_directory,
            snapshot_date=arguments.snapshot_date,
            refresh=arguments.refresh,
        )
        print_json(result)
    finally:
        connection.close()


def _ingest_municipality_profiles(
    arguments: argparse.Namespace,
) -> None:
    context = CliContext.from_arguments(arguments)
    connection = context.open_connection()
    try:
        result = ingest_municipality_profiles(
            connection,
            snapshot_date=arguments.snapshot_date,
            refresh=arguments.refresh,
            jis5_filter=set(arguments.jis5) or None,
        )
        print_json(result)
    finally:
        connection.close()


def _wikipedia_lists_ingest(arguments: argparse.Namespace) -> None:
    context = CliContext.from_arguments(arguments)
    connection = context.open_connection()
    try:
        kinds = tuple(arguments.kind) if arguments.kind else ("emblem", "flag")
        result = ingest_wikipedia_lists(
            connection,
            snapshot_date=arguments.snapshot_date,
            kinds=kinds,
            refresh_titles=arguments.refresh_titles,
            refresh_pages=arguments.refresh_pages,
        )
        print_json(result)
    finally:
        connection.close()


def main() -> None:
    arguments = _parser().parse_args()
    if arguments.command == "ingest":
        _ingest(arguments)
    elif arguments.command == "fetch-svg-all":
        _fetch_svg_all(arguments)
    elif arguments.command == "classify-svg":
        _classify_svg(arguments)
    elif arguments.command == "ingest-current-national":
        _ingest_current_national(arguments)
    elif arguments.command == "export-web":
        _export_web(arguments)
    elif arguments.command == "match-current-national":
        _match_current_national(arguments)
    elif arguments.command == "ingest-current-prefectures":
        _ingest_current_prefectures(arguments)
    elif arguments.command == "ingest-municipality-profiles":
        _ingest_municipality_profiles(arguments)
    elif arguments.command == "wikipedia-lists-ingest":
        _wikipedia_lists_ingest(arguments)
    else:
        _report(arguments)


if __name__ == "__main__":
    main()
