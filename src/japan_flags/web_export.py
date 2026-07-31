from __future__ import annotations

import json
import math
import shutil
import sqlite3
from pathlib import Path
from typing import Any

import numpy as np
import topojson
from shapely import (
    MultiPolygon,
    Point,
    coverage_is_valid,
    coverage_simplify,
    coverage_union_all,
    from_geojson,
    get_num_geometries,
    get_parts,
    make_valid,
    maximum_inscribed_circle,
    orient_polygons,
    set_precision,
    to_geojson,
    transform,
)
from shapely.errors import GEOSException
from shapely.ops import unary_union

DEFAULT_OVERVIEW_VW_TOLERANCE = 0.25
OVERVIEW_MIN_PART_PIXEL_AREA = 0.0
OVERVIEW_MAX_AREA_CHANGE_RATIO = 0.08
OVERVIEW_MAX_SHAPE_CHANGE_RATIO = 0.08
MAX_ADAPTIVE_SIMPLIFICATION_STEPS = 6
GEOMETRY_LOD_CONFIG = {
    "l0": {
        "vw_tolerance": 0.25,
        "min_part_pixel_area": 0.5,
        "quantization": 32_768,
    },
    "l1": {
        "vw_tolerance": 0.0625,
        "min_part_pixel_area": 0.125,
        "quantization": 65_536,
    },
    "l2": {
        "vw_tolerance": 0.015625,
        "min_part_pixel_area": 0.03125,
        "quantization": 262_144,
    },
    "l3": {
        "vw_tolerance": 0.0,
        "min_part_pixel_area": 0.0,
        "quantization": 1_000_000,
    },
}
REGION_VIEWPORTS = {
    "main": (908.0, 698.0),
    "islands": (164.0, 131.0),
    "okinawa": (244.0, 130.0),
}


def _map_region(prefecture_code: str, jis5: str) -> str:
    if prefecture_code == "47":
        return "okinawa"
    if prefecture_code == "13" and int(jis5) >= 13360:
        return "islands"
    return "main"


def _simplify_geometry(
    geometry_json: str,
    tolerance: float,
    *,
    min_part_area: float = 0.0,
) -> dict[str, Any]:
    geometry = from_geojson(geometry_json)
    if min_part_area:
        parts = list(get_parts(geometry))
        visible_parts = [part for part in parts if part.area >= min_part_area]
        if not visible_parts and parts:
            visible_parts = [max(parts, key=lambda part: part.area)]
        geometry = (
            visible_parts[0] if len(visible_parts) == 1 else MultiPolygon(visible_parts)
        )
    simplified = geometry.simplify(tolerance, preserve_topology=True)
    quantized = set_precision(simplified, 0.00001, mode="valid_output")
    d3_oriented = orient_polygons(quantized, exterior_cw=True)
    exported = json.loads(to_geojson(d3_oriented))
    exported["coordinates"] = _round_coordinates(exported["coordinates"])
    return exported


def _mercator_y(latitude: float) -> float:
    clamped = min(89.999999, max(-89.999999, latitude))
    radians = math.radians(clamped)
    return -math.log(math.tan(math.pi / 4 + radians / 2))


def _region_projection_scales(
    rows: list[dict[str, Any]],
) -> dict[str, tuple[float, float, float]]:
    bounds: dict[str, list[float]] = {}
    for row in rows:
        geometry = from_geojson(row["geometry_json"])
        min_lng, min_lat, max_lng, max_lat = geometry.bounds
        region = _map_region(
            str(row["prefecture_code"]),
            str(row["jis5"]),
        )
        mercator_bounds = [
            math.radians(min_lng),
            _mercator_y(max_lat),
            math.radians(max_lng),
            _mercator_y(min_lat),
        ]
        if region not in bounds:
            bounds[region] = mercator_bounds
            continue
        current = bounds[region]
        current[0] = min(current[0], mercator_bounds[0])
        current[1] = min(current[1], mercator_bounds[1])
        current[2] = max(current[2], mercator_bounds[2])
        current[3] = max(current[3], mercator_bounds[3])

    projections: dict[str, tuple[float, float, float]] = {}
    for region, (min_x, min_y, max_x, max_y) in bounds.items():
        width, height = REGION_VIEWPORTS[region]
        scale = min(
            width / max(max_x - min_x, 1e-12),
            height / max(max_y - min_y, 1e-12),
        )
        projections[region] = (min_x, min_y, scale)
    return projections


def _project_to_screen(
    geometry: Any,
    projection: tuple[float, float, float],
) -> Any:
    origin_x, origin_y, scale = projection

    def project(coordinates: np.ndarray) -> np.ndarray:
        longitude = np.radians(coordinates[:, 0])
        latitude = np.radians(np.clip(coordinates[:, 1], -89.999999, 89.999999))
        mercator_y = -np.log(np.tan(np.pi / 4 + latitude / 2))
        return np.column_stack(
            (
                (longitude - origin_x) * scale,
                (mercator_y - origin_y) * scale,
            )
        )

    return transform(geometry, project)


def _unproject_from_screen(
    geometry: Any,
    projection: tuple[float, float, float],
) -> Any:
    origin_x, origin_y, scale = projection

    def unproject(coordinates: np.ndarray) -> np.ndarray:
        longitude = coordinates[:, 0] / scale + origin_x
        mercator_y = coordinates[:, 1] / scale + origin_y
        latitude = 2 * np.arctan(np.exp(-mercator_y)) - np.pi / 2
        return np.column_stack(
            (
                np.degrees(longitude),
                np.degrees(latitude),
            )
        )

    return transform(geometry, unproject)


def _visual_placement(geometry_json: str) -> dict[str, Any] | None:
    geometry = from_geojson(geometry_json)
    projected = _project_to_screen(geometry, (0.0, 0.0, 1.0))
    polygon_parts = [part for part in get_parts(projected) if part.area > 0]
    if not polygon_parts:
        return None
    primary = max(polygon_parts, key=lambda part: part.area)
    full_min_x, full_min_y, full_max_x, full_max_y = projected.bounds
    full_width = full_max_x - full_min_x
    full_height = full_max_y - full_min_y
    full_minimum_dimension = min(full_width, full_height)
    min_x, min_y, max_x, max_y = primary.bounds
    width = max_x - min_x
    height = max_y - min_y
    if min(width, height, full_minimum_dimension) <= 0:
        return None
    circle = maximum_inscribed_circle(
        primary,
        tolerance=max(width, height) / 2048,
    )
    coordinates = list(circle.coords)
    if len(coordinates) < 2:
        return None
    center_x, center_y = coordinates[0]
    edge_x, edge_y = coordinates[1]
    radius = math.hypot(edge_x - center_x, edge_y - center_y)
    centroid = primary.centroid
    centroid_x = float(centroid.x)
    centroid_y = float(centroid.y)
    centroid_clearance = (
        float(centroid.distance(primary.boundary)) if primary.covers(centroid) else 0.0
    )
    centroid_weight = min(1.0, centroid_clearance / max(radius, 1e-12))
    while centroid_weight > 1e-6:
        optimized_x = center_x + (centroid_x - center_x) * centroid_weight
        optimized_y = center_y + (centroid_y - center_y) * centroid_weight
        if primary.covers(Point(optimized_x, optimized_y)):
            break
        centroid_weight /= 2
    else:
        optimized_x = center_x
        optimized_y = center_y

    def normalized_point(x: float, y: float) -> list[float]:
        return [
            round((x - full_min_x) / full_width, 6),
            round((y - full_min_y) / full_height, 6),
        ]

    return {
        # Every value is relative to the complete feature bbox. This is
        # essential for MultiPolygons whose primary part does not share the
        # complete feature's origin or extent.
        "anchor": normalized_point(center_x, center_y),
        "centroidAnchor": normalized_point(centroid_x, centroid_y),
        "optimizedAnchor": normalized_point(optimized_x, optimized_y),
        "componentBounds": [
            round((min_x - full_min_x) / full_width, 6),
            round((min_y - full_min_y) / full_height, 6),
            round((max_x - full_min_x) / full_width, 6),
            round((max_y - full_min_y) / full_height, 6),
        ],
        "safeRadiusRatio": round(
            radius / full_minimum_dimension,
            6,
        ),
    }


def _filter_small_parts(geometry: Any, min_part_area: float) -> Any:
    if not min_part_area:
        return geometry
    parts = list(get_parts(geometry))
    visible_parts = [part for part in parts if part.area >= min_part_area]
    if not visible_parts and parts:
        visible_parts = [max(parts, key=lambda part: part.area)]
    if len(visible_parts) == 1:
        return visible_parts[0]
    return MultiPolygon(visible_parts)


def _export_geometry(geometry: Any) -> dict[str, Any]:
    quantized = set_precision(geometry, 0.00001, mode="valid_output")
    d3_oriented = orient_polygons(quantized, exterior_cw=True)
    exported = json.loads(to_geojson(d3_oriented))
    exported["coordinates"] = _round_coordinates(exported["coordinates"])
    return exported


def _geometry_bbox(geometry: dict[str, Any]) -> list[float]:
    min_x = float("inf")
    min_y = float("inf")
    max_x = float("-inf")
    max_y = float("-inf")
    pending = [geometry["coordinates"]]
    while pending:
        coordinates = pending.pop()
        if (
            len(coordinates) >= 2
            and isinstance(coordinates[0], (int, float))
            and isinstance(coordinates[1], (int, float))
        ):
            x = float(coordinates[0])
            y = float(coordinates[1])
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x)
            max_y = max(max_y, y)
        else:
            pending.extend(coordinates)
    return [min_x, min_y, max_x, max_y]


def _export_unsimplified_map_rows(
    rows: list[dict[str, Any]],
) -> tuple[dict[int, dict[str, Any]], dict[str, Any]]:
    exported: dict[int, dict[str, Any]] = {}
    repaired_feature_count = 0
    for row in rows:
        geometry = from_geojson(row["geometry_json"])
        if not geometry.is_valid:
            geometry = make_valid(
                geometry,
                method="structure",
                keep_collapsed=False,
            )
            repaired_feature_count += 1
        exported[int(row["id"])] = _export_geometry(geometry)
    return exported, {
        "algorithm": "none",
        "coordinateSpace": "geographic",
        "quantizationDecimalPlaces": 5,
        "repairedFeatureCount": repaired_feature_count,
    }


def _shape_change_metrics(
    source: Any,
    candidate: Any,
) -> tuple[float, float, bool]:
    if source.area <= 1e-12:
        return 0.0, 0.0, (get_num_geometries(source) == get_num_geometries(candidate))
    area_change = abs(candidate.area - source.area) / source.area
    try:
        shape_change = source.symmetric_difference(candidate).area / source.area
    except GEOSException:
        shape_change = float("inf")
    components_preserved = get_num_geometries(source) == get_num_geometries(candidate)
    return area_change, shape_change, components_preserved


def _adapt_simplified_geometry(
    source: Any,
    candidate: Any,
    *,
    vw_tolerance: float,
    max_area_change_ratio: float,
    max_shape_change_ratio: float,
) -> tuple[Any, bool, bool, float, float]:
    area_change, shape_change, components_preserved = _shape_change_metrics(
        source, candidate
    )
    if (
        components_preserved
        and area_change <= max_area_change_ratio
        and shape_change <= max_shape_change_ratio
    ):
        return candidate, False, False, area_change, shape_change

    local_tolerance = vw_tolerance
    for _ in range(MAX_ADAPTIVE_SIMPLIFICATION_STEPS):
        local_tolerance /= 2
        try:
            local_candidate = coverage_simplify(
                [source],
                local_tolerance,
                simplify_boundary=True,
            )[0]
        except GEOSException:
            continue
        area_change, shape_change, components_preserved = _shape_change_metrics(
            source, local_candidate
        )
        if (
            local_candidate.is_valid
            and components_preserved
            and area_change <= max_area_change_ratio
            and shape_change <= max_shape_change_ratio
        ):
            return (
                local_candidate,
                True,
                False,
                area_change,
                shape_change,
            )

    return source, True, True, 0.0, 0.0


def _simplify_coverage_group(
    geometries: list[Any],
    *,
    projection: tuple[float, float, float],
    vw_tolerance: float,
    min_part_pixel_area: float,
    max_area_change_ratio: float,
    max_shape_change_ratio: float,
) -> tuple[
    list[dict[str, Any]],
    bool,
    bool,
    str | None,
    dict[str, Any],
]:
    projected = [_project_to_screen(geometry, projection) for geometry in geometries]
    projected = [
        (
            geometry
            if geometry.is_valid
            else make_valid(
                geometry,
                method="structure",
                keep_collapsed=False,
            )
        )
        for geometry in projected
    ]
    fallback_reason = None
    try:
        simplified = list(
            coverage_simplify(
                projected,
                vw_tolerance,
                simplify_boundary=True,
            )
        )
        coverage_valid = bool(coverage_is_valid(simplified))
        algorithm_applied = not any(not geometry.is_valid for geometry in simplified)
        if not algorithm_applied:
            fallback_reason = "invalid-coverage-output"
    except GEOSException as error:
        simplified = []
        algorithm_applied = False
        coverage_valid = False
        fallback_reason = f"{type(error).__name__}: {error}"
    if not algorithm_applied:
        simplified = [
            geometry.simplify(vw_tolerance, preserve_topology=True)
            for geometry in projected
        ]
    adapted_feature_count = 0
    preserved_original_feature_count = 0
    max_area_change = 0.0
    max_shape_change = 0.0
    result = []
    for source, geometry in zip(projected, simplified, strict=True):
        visible_source = _filter_small_parts(
            source,
            min_part_pixel_area,
        )
        visible_candidate = _filter_small_parts(
            geometry,
            min_part_pixel_area,
        )
        (
            geometry,
            adapted,
            preserved_original,
            area_change,
            shape_change,
        ) = _adapt_simplified_geometry(
            visible_source,
            visible_candidate,
            vw_tolerance=vw_tolerance,
            max_area_change_ratio=max_area_change_ratio,
            max_shape_change_ratio=max_shape_change_ratio,
        )
        adapted_feature_count += int(adapted)
        preserved_original_feature_count += int(preserved_original)
        max_area_change = max(max_area_change, area_change)
        max_shape_change = max(max_shape_change, shape_change)
        geographic = _unproject_from_screen(
            geometry,
            projection,
        )
        result.append(_export_geometry(geographic))
    return (
        result,
        algorithm_applied,
        coverage_valid,
        fallback_reason,
        {
            "adaptedFeatureCount": adapted_feature_count,
            "preservedOriginalFeatureCount": preserved_original_feature_count,
            "maxAreaChangeRatio": max_area_change,
            "maxShapeChangeRatio": max_shape_change,
        },
    )


def _simplify_map_rows(
    rows: list[dict[str, Any]],
    *,
    projections: dict[str, tuple[float, float, float]],
    vw_tolerance: float,
    min_part_pixel_area: float,
    max_area_change_ratio: float,
    max_shape_change_ratio: float,
) -> tuple[dict[int, dict[str, Any]], dict[str, Any]]:
    groups: dict[str, list[tuple[dict[str, Any], Any]]] = {}
    for row in rows:
        region = _map_region(
            str(row["prefecture_code"]),
            str(row["jis5"]),
        )
        geometry = from_geojson(row["geometry_json"])
        if not geometry.is_valid:
            geometry = make_valid(
                geometry,
                method="structure",
                keep_collapsed=False,
            )
        groups.setdefault(region, []).append((row, geometry))

    exported: dict[int, dict[str, Any]] = {}
    visvalingam_groups = 0
    valid_coverage_groups = 0
    fallback_groups: list[str] = []
    adapted_feature_count = 0
    preserved_original_feature_count = 0
    max_area_change = 0.0
    max_shape_change = 0.0
    for region, items in groups.items():
        (
            geometries,
            algorithm_applied,
            coverage_valid,
            fallback_reason,
            validation,
        ) = _simplify_coverage_group(
            [geometry for _, geometry in items],
            projection=projections[region],
            vw_tolerance=vw_tolerance,
            min_part_pixel_area=min_part_pixel_area,
            max_area_change_ratio=max_area_change_ratio,
            max_shape_change_ratio=max_shape_change_ratio,
        )
        if algorithm_applied:
            visvalingam_groups += 1
        else:
            fallback_groups.append(f"{region}:{fallback_reason or 'unknown'}")
        if coverage_valid:
            valid_coverage_groups += 1
        adapted_feature_count += validation["adaptedFeatureCount"]
        preserved_original_feature_count += validation["preservedOriginalFeatureCount"]
        max_area_change = max(
            max_area_change,
            validation["maxAreaChangeRatio"],
        )
        max_shape_change = max(
            max_shape_change,
            validation["maxShapeChangeRatio"],
        )
        for (row, _), geometry in zip(items, geometries, strict=True):
            exported[int(row["id"])] = geometry
    return exported, {
        "algorithm": "visvalingam-whyatt-coverage",
        "coordinateSpace": "web-mercator-screen-pixels",
        "vwAreaTolerance": vw_tolerance,
        "toleranceUnit": "sqrt-screen-pixel-area",
        "coverageGroupCount": len(groups),
        "visvalingamGroupCount": visvalingam_groups,
        "validCoverageGroupCount": valid_coverage_groups,
        "fallbackGroups": fallback_groups,
        "maxAllowedAreaChangeRatio": max_area_change_ratio,
        "maxAllowedShapeChangeRatio": max_shape_change_ratio,
        "targetScreenError": vw_tolerance,
        "adaptedFeatureCount": adapted_feature_count,
        "preservedOriginalFeatureCount": preserved_original_feature_count,
        "maxAreaChangeRatio": max_area_change,
        "maxShapeChangeRatio": max_shape_change,
    }


def _write_topology(
    collection: dict[str, Any],
    target: Path,
    *,
    object_name: str = "territories",
    quantization: int = 1_000_000,
) -> None:
    topology = topojson.Topology(
        collection,
        object_name=object_name,
        prequantize=quantization,
        presimplify=False,
        toposimplify=False,
        topology=True,
    ).to_dict()
    source_features = collection["features"]
    bbox_by_id = {
        str(feature["id"]): feature["bbox"]
        for feature in source_features
        if feature.get("id") is not None and feature.get("bbox") is not None
    }
    topology_geometries = topology["objects"][object_name].get(
        "geometries",
        [],
    )
    for index, geometry in enumerate(topology_geometries):
        bbox = bbox_by_id.get(str(geometry.get("id")))
        if bbox is None and index < len(source_features):
            bbox = source_features[index].get("bbox")
        if bbox is not None:
            geometry["bbox"] = bbox
    topology["metadata"] = {
        **collection["metadata"],
        "quantization": quantization,
        "objectName": object_name,
    }
    target.write_text(
        json.dumps(topology, ensure_ascii=False, separators=(",", ":")) + "\n"
    )


def _round_coordinates(value: Any) -> Any:
    if isinstance(value, list):
        return [_round_coordinates(item) for item in value]
    if isinstance(value, float):
        return round(value, 5)
    return value


def _designated_city_jis5(ward_jis5: str) -> str:
    return f"{int(ward_jis5) // 10 * 10:05d}"


def _unify_ward_geometries(ward_rows: list[sqlite3.Row]) -> Any:
    geometries = [from_geojson(row["geometry_json"]) for row in ward_rows]
    merged = coverage_union_all(geometries)
    if not merged.is_valid:
        merged = unary_union(geometries)
    if not merged.is_valid:
        merged = make_valid(
            merged,
            method="structure",
            keep_collapsed=False,
        )
    return merged


def _municipality_map_rows(
    rows: list[sqlite3.Row],
) -> list[dict[str, Any]]:
    map_rows: list[dict[str, Any]] = []
    wards_by_city: dict[tuple[str, str], list[sqlite3.Row]] = {}
    for row in rows:
        if row["entity_type"] != "ward":
            map_rows.append(dict(row))
            continue
        key = (
            str(row["prefecture_code"]),
            str(row["municipality_name"]),
        )
        wards_by_city.setdefault(key, []).append(row)

    for (
        prefecture_code,
        municipality_name,
    ), ward_rows in wards_by_city.items():
        parent_jis5 = _designated_city_jis5(min(str(row["jis5"]) for row in ward_rows))
        flag_row = next(
            (
                row
                for row in ward_rows
                if row["assignment_kind"] == "inherited" and row["page_id"] is not None
            ),
            next(
                (row for row in ward_rows if row["page_id"] is not None), ward_rows[0]
            ),
        )
        geometry = _unify_ward_geometries(ward_rows)
        member_ids = sorted(int(row["id"]) for row in ward_rows)
        member_jis5s = sorted(str(row["jis5"]) for row in ward_rows)
        ward_names = sorted(str(row["ward_name"]) for row in ward_rows)
        map_rows.append(
            {
                **dict(flag_row),
                "id": member_ids[0],
                "jis5": parent_jis5,
                "display_name": municipality_name,
                "municipality_name": municipality_name,
                "ward_name": None,
                "entity_type": "designated_city",
                "geometry_json": to_geojson(geometry),
                "assignment_kind": (
                    "inherited" if flag_row["page_id"] is not None else None
                ),
                "match_method": (
                    "parent_city_flag_ward_union"
                    if flag_row["page_id"] is not None
                    else None
                ),
                "prefecture_code": prefecture_code,
                "member_territory_version_ids": member_ids,
                "member_jis5s": member_jis5s,
                "ward_names": ward_names,
                "ward_count": len(ward_rows),
                "aggregation_kind": "designated_city_wards",
            }
        )
    return sorted(map_rows, key=lambda row: str(row["jis5"]))


def _prefecture_parts(
    prefecture_code: str,
    geometry_json: str,
) -> list[tuple[str, Any]]:
    source_geometry = from_geojson(geometry_json)
    visible_parts = [
        part for part in get_parts(source_geometry) if part.area >= 0.000001
    ]
    geometry = unary_union(visible_parts)
    if prefecture_code == "47":
        return [("okinawa", geometry)]
    if prefecture_code != "13":
        return [("main", geometry)]

    main_parts = []
    island_parts = []
    for part in get_parts(geometry):
        target = island_parts if part.centroid.y < 35.0 else main_parts
        target.append(part)
    result: list[tuple[str, Any]] = []
    if main_parts:
        result.append(("main", unary_union(main_parts)))
    if island_parts:
        result.append(("islands", unary_union(island_parts)))
    return result


def _export_prefecture_data(
    connection: sqlite3.Connection,
    *,
    database_path: Path,
    snapshot_date: str,
    output_directory: Path,
    tolerance: float,
    territory_features: list[dict[str, Any]],
) -> dict[str, Any]:
    rows = connection.execute(
        """
        SELECT
          p.id,
          p.prefecture_code,
          p.prefecture_name,
          p.snapshot_date,
          g.geometry_json,
          f.page_id,
          f.role,
          f.match_method,
          f.confidence,
          a.local_path,
          a.description_url
        FROM prefecture_versions p
        JOIN geometries g ON g.id = p.geometry_id
        LEFT JOIN prefecture_version_flags f
          ON f.prefecture_version_id = p.id AND f.role = 'primary'
        LEFT JOIN flag_assets a ON a.page_id = f.page_id
        WHERE p.snapshot_date = ?
        ORDER BY p.prefecture_code
        """,
        (snapshot_date,),
    ).fetchall()
    if not rows:
        return {"prefectures": 0, "features": 0, "matched_flags": 0}

    flags_directory = output_directory / "flags"
    flags_directory.mkdir(parents=True, exist_ok=True)
    features: list[dict[str, Any]] = []
    matched_codes: set[str] = set()
    territory_geometries: dict[tuple[str, str], list[Any]] = {}
    for feature in territory_features:
        properties = feature["properties"]
        key = (
            str(properties["prefectureCode"]),
            str(properties["mapRegion"]),
        )
        territory_geometries.setdefault(key, []).append(
            from_geojson(json.dumps(feature["geometry"]))
        )
    for row in rows:
        page_id = int(row["page_id"]) if row["page_id"] is not None else None
        flag_path = None
        if page_id is not None and row["local_path"]:
            source_path = (database_path.parent / row["local_path"]).resolve()
            if source_path.exists():
                shutil.copy2(source_path, flags_directory / f"{page_id}.svg")
                flag_path = f"/flags/{page_id}.svg"
                matched_codes.add(str(row["prefecture_code"]))

        for map_region, geometry in _prefecture_parts(
            str(row["prefecture_code"]),
            row["geometry_json"],
        ):
            shared_geometries = territory_geometries.get(
                (str(row["prefecture_code"]), map_region)
            )
            if shared_geometries:
                shared_geometry = unary_union(shared_geometries)
                geometry_dict = _export_geometry(shared_geometry)
            else:
                geometry_dict = _simplify_geometry(
                    to_geojson(geometry),
                    tolerance,
                )
            visual_placement = _visual_placement(to_geojson(geometry))
            feature_id = f"{row['prefecture_code']}:{map_region}"
            features.append(
                {
                    "type": "Feature",
                    "id": feature_id,
                    "properties": {
                        "prefectureVersionId": int(row["id"]),
                        "prefectureCode": row["prefecture_code"],
                        "displayName": row["prefecture_name"],
                        "prefectureName": row["prefecture_name"],
                        "entityType": "prefecture",
                        "snapshotDate": row["snapshot_date"],
                        "flagPageId": page_id,
                        "flagPath": flag_path,
                        "flagRole": row["role"],
                        "assignmentKind": "direct" if page_id else None,
                        "matchMethod": row["match_method"],
                        "confidence": row["confidence"],
                        "commonsUrl": row["description_url"],
                        "mapRegion": map_region,
                        "mapPart": feature_id,
                        "visualAnchor": (
                            visual_placement["anchor"] if visual_placement else None
                        ),
                        "visualCentroidAnchor": (
                            visual_placement["centroidAnchor"]
                            if visual_placement
                            else None
                        ),
                        "visualOptimizedAnchor": (
                            visual_placement["optimizedAnchor"]
                            if visual_placement
                            else None
                        ),
                        "visualComponentBounds": (
                            visual_placement["componentBounds"]
                            if visual_placement
                            else None
                        ),
                        "visualSafeRadiusRatio": (
                            visual_placement["safeRadiusRatio"]
                            if visual_placement
                            else None
                        ),
                    },
                    "bbox": _geometry_bbox(geometry_dict),
                    "geometry": geometry_dict,
                }
            )

    collection = {
        "type": "FeatureCollection",
        "metadata": {
            "snapshotDate": snapshot_date,
            "mapLayer": "prefecture",
            "detailLevel": "overview",
            "geometryLod": "l0",
            "simplificationTolerance": tolerance,
            "prefectureCount": len(rows),
            "matchedFlagCount": len(matched_codes),
        },
        "features": features,
    }
    target = output_directory / "data" / "prefectures.topojson"
    target.parent.mkdir(parents=True, exist_ok=True)
    (output_directory / "data" / "prefectures.geojson").unlink(missing_ok=True)
    _write_topology(
        collection,
        target,
        quantization=int(GEOMETRY_LOD_CONFIG["l0"]["quantization"]),
    )
    return {
        "prefectures": len(rows),
        "features": len(features),
        "matched_flags": len(matched_codes),
        "topojson_path": str(target),
    }


def _public_wikipedia_extract(value: str | None) -> str | None:
    if not value:
        return None
    normalized = " ".join(value.split())
    if len(normalized) <= 400:
        return normalized
    shortened = normalized[:400]
    sentence_end = max(
        shortened.rfind("。"),
        shortened.rfind(". "),
    )
    if sentence_end >= 160:
        return shortened[: sentence_end + 1]
    return shortened.rstrip() + "…"


def _export_municipality_profiles(
    connection: sqlite3.Connection,
    *,
    snapshot_date: str,
    output_directory: Path,
    map_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    rows = connection.execute(
        """
        SELECT *
        FROM municipality_profiles
        WHERE snapshot_date = ?
        ORDER BY jis5
        """,
        (snapshot_date,),
    ).fetchall()
    profiles_by_jis5 = {str(row["jis5"]): row for row in rows}
    chunks: dict[str, dict[str, Any]] = {}
    resolved = 0
    for map_row in map_rows:
        jis5 = str(map_row["jis5"])
        prefecture_code = str(map_row["prefecture_code"])
        row = profiles_by_jis5.get(jis5)
        if row is None:
            profile = {
                "resolutionStatus": "unresolved",
                "wikidataItemId": None,
                "wikidataUrl": None,
                "wikipediaTitle": None,
                "wikipediaUrl": None,
                "wikipediaExtract": None,
                "population": None,
                "populationAsOf": None,
                "populationDatePrecision": None,
                "areaKm2": None,
            }
        else:
            resolved += row["resolution_status"] == "resolved"
            profile = {
                "resolutionStatus": row["resolution_status"],
                "wikidataItemId": row["wikidata_item_id"],
                "wikidataUrl": row["wikidata_url"],
                "wikipediaTitle": row["jawiki_title"],
                "wikipediaUrl": row["jawiki_url"],
                "wikipediaExtract": _public_wikipedia_extract(row["wikipedia_extract"]),
                "population": row["population"],
                "populationAsOf": row["population_as_of"],
                "populationDatePrecision": row["population_date_precision"],
                "areaKm2": row["area_km2"],
            }
        chunks.setdefault(prefecture_code, {})[jis5] = profile

    profiles_directory = output_directory / "data" / "profiles"
    profiles_directory.mkdir(parents=True, exist_ok=True)
    for stale in profiles_directory.glob("*.json"):
        stale.unlink()
    for prefecture_code, profiles in sorted(chunks.items()):
        target = profiles_directory / f"{prefecture_code}.json"
        target.write_text(
            json.dumps(
                {
                    "version": 1,
                    "snapshotDate": snapshot_date,
                    "prefectureCode": prefecture_code,
                    "profiles": profiles,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n"
        )
    return {
        "chunks": len(chunks),
        "profiles": sum(len(chunk) for chunk in chunks.values()),
        "resolved": resolved,
    }


def export_web_data(
    connection: sqlite3.Connection,
    *,
    database_path: Path,
    snapshot_date: str,
    output_directory: Path,
    comparison_output_directory: Path | None = None,
    overview_vw_tolerance: float = DEFAULT_OVERVIEW_VW_TOLERANCE,
) -> dict[str, Any]:
    rows = connection.execute(
        """
        SELECT
          t.id,
          t.jis5,
          t.display_name,
          t.municipality_name,
          t.ward_name,
          t.prefecture_name,
          t.prefecture_code,
          t.entity_type,
          t.snapshot_date,
          g.geometry_json,
          f.page_id,
          f.role,
          f.assignment_kind,
          f.match_method,
          f.confidence,
          a.local_path,
          a.description_url
        FROM territory_versions t
        JOIN geometries g ON g.id = t.geometry_id
        LEFT JOIN territory_version_flags f
          ON f.territory_version_id = t.id
         AND f.role = 'primary'
        LEFT JOIN flag_assets a ON a.page_id = f.page_id
        WHERE t.snapshot_date = ?
        ORDER BY t.jis5
        """,
        (snapshot_date,),
    ).fetchall()
    if not rows:
        raise ValueError(f"No territory versions found for snapshot {snapshot_date}")
    source_territory_count = len(rows)
    map_rows = _municipality_map_rows(rows)
    projections = _region_projection_scales(map_rows)
    lod_configs = {lod: dict(config) for lod, config in GEOMETRY_LOD_CONFIG.items()}
    lod_configs["l0"]["vw_tolerance"] = overview_vw_tolerance
    lod_configs["l1"]["vw_tolerance"] = overview_vw_tolerance / 4
    lod_configs["l2"]["vw_tolerance"] = overview_vw_tolerance / 16
    lod_geometries: dict[str, dict[int, dict[str, Any]]] = {}
    lod_simplification: dict[str, dict[str, Any]] = {}
    for lod in ("l0", "l1", "l2"):
        config = lod_configs[lod]
        geometries, simplification = _simplify_map_rows(
            map_rows,
            projections=projections,
            vw_tolerance=float(config["vw_tolerance"]),
            min_part_pixel_area=float(config["min_part_pixel_area"]),
            max_area_change_ratio=OVERVIEW_MAX_AREA_CHANGE_RATIO,
            max_shape_change_ratio=OVERVIEW_MAX_SHAPE_CHANGE_RATIO,
        )
        lod_geometries[lod] = geometries
        lod_simplification[lod] = simplification
    (
        lod_geometries["l3"],
        lod_simplification["l3"],
    ) = _export_unsimplified_map_rows(map_rows)

    data_directory = output_directory / "data"
    flags_directory = output_directory / "flags"
    data_directory.mkdir(parents=True, exist_ok=True)
    flags_directory.mkdir(parents=True, exist_ok=True)
    (data_directory / "territories.topojson").unlink(missing_ok=True)
    (data_directory / "territories.geojson").unlink(missing_ok=True)
    (data_directory / "territories-overview.topojson").unlink(missing_ok=True)
    (data_directory / "territories-overview.geojson").unlink(missing_ok=True)
    if comparison_output_directory is not None:
        comparison_output_directory.mkdir(parents=True, exist_ok=True)

    features_by_lod: dict[str, list[dict[str, Any]]] = {lod: [] for lod in lod_configs}
    features_by_prefecture_and_lod: dict[
        str,
        dict[str, list[dict[str, Any]]],
    ] = {lod: {} for lod in lod_configs}
    copied_flags: set[int] = set()
    for row in map_rows:
        page_id = int(row["page_id"]) if row["page_id"] is not None else None
        flag_path = None
        if page_id is not None and row["local_path"]:
            source_path = (database_path.parent / row["local_path"]).resolve()
            if source_path.exists():
                target_path = flags_directory / f"{page_id}.svg"
                shutil.copy2(source_path, target_path)
                copied_flags.add(page_id)
                flag_path = f"/flags/{page_id}.svg"

        visual_placement = _visual_placement(row["geometry_json"])
        properties = {
            "territoryVersionId": int(row["id"]),
            "jis5": row["jis5"],
            "prefectureCode": row["prefecture_code"],
            "displayName": row["display_name"],
            "prefectureName": row["prefecture_name"],
            "entityType": row["entity_type"],
            "snapshotDate": row["snapshot_date"],
            "flagPageId": page_id,
            "flagPath": flag_path,
            "flagRole": row["role"],
            "assignmentKind": row["assignment_kind"],
            "matchMethod": row["match_method"],
            "confidence": row["confidence"],
            "commonsUrl": row["description_url"],
            "mapRegion": _map_region(
                row["prefecture_code"],
                row["jis5"],
            ),
            "aggregationKind": row.get("aggregation_kind"),
            "memberTerritoryVersionIds": row.get(
                "member_territory_version_ids",
                [int(row["id"])],
            ),
            "memberJis5s": row.get("member_jis5s", [row["jis5"]]),
            "wardNames": row.get("ward_names", []),
            "wardCount": row.get("ward_count", 0),
            "visualAnchor": (visual_placement["anchor"] if visual_placement else None),
            "visualCentroidAnchor": (
                visual_placement["centroidAnchor"] if visual_placement else None
            ),
            "visualOptimizedAnchor": (
                visual_placement["optimizedAnchor"] if visual_placement else None
            ),
            "visualComponentBounds": (
                visual_placement["componentBounds"] if visual_placement else None
            ),
            "visualSafeRadiusRatio": (
                visual_placement["safeRadiusRatio"] if visual_placement else None
            ),
        }
        for lod in lod_configs:
            geometry = lod_geometries[lod][int(row["id"])]
            feature = {
                "type": "Feature",
                "id": int(row["id"]),
                "properties": properties,
                "geometry": geometry,
                "bbox": _geometry_bbox(geometry),
            }
            features_by_lod[lod].append(feature)
            features_by_prefecture_and_lod[lod].setdefault(
                str(row["prefecture_code"]),
                [],
            ).append(feature)

    matched_flag_count = sum(
        feature["properties"]["flagPath"] is not None
        for feature in features_by_lod["l3"]
    )

    def collection_for_lod(
        lod: str,
        features: list[dict[str, Any]],
        *,
        detail_level: str,
        prefecture_code: str | None = None,
    ) -> dict[str, Any]:
        config = lod_configs[lod]
        metadata = {
            "snapshotDate": snapshot_date,
            "mapLayer": "municipality",
            "geometryLod": lod,
            "detailLevel": detail_level,
            "simplificationTolerance": config["vw_tolerance"],
            "minPartArea": config["min_part_pixel_area"],
            "simplification": lod_simplification[lod],
            "territoryCount": len(features),
            "sourceTerritoryCount": source_territory_count,
            "matchedFlagCount": matched_flag_count,
        }
        if lod != "l3":
            metadata["simplificationToleranceUnit"] = "sqrt-screen-pixel-area"
            metadata["minPartAreaUnit"] = "screen-pixels-squared"
        if prefecture_code is not None:
            metadata["prefectureCode"] = prefecture_code
        return {
            "type": "FeatureCollection",
            "metadata": metadata,
            "features": features,
        }

    feature_collection = collection_for_lod(
        "l3",
        features_by_lod["l3"],
        detail_level="prefecture",
    )
    comparison_target = (
        comparison_output_directory / "territories.geojson"
        if comparison_output_directory is not None
        else None
    )
    if comparison_target is not None:
        comparison_target.write_text(
            json.dumps(
                feature_collection,
                ensure_ascii=False,
                separators=(",", ":"),
            )
            + "\n"
        )
    overview_topology_paths: dict[str, str] = {}
    comparison_overview_paths: dict[str, str] = {}
    for lod in ("l0", "l1"):
        overview_collection = collection_for_lod(
            lod,
            features_by_lod[lod],
            detail_level="overview",
        )
        if comparison_output_directory is not None:
            comparison_overview_target = (
                comparison_output_directory / f"territories-overview-{lod}.geojson"
            )
            comparison_overview_target.write_text(
                json.dumps(
                    overview_collection,
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                + "\n"
            )
            comparison_overview_paths[lod] = str(comparison_overview_target)
        overview_topology_target = (
            data_directory / f"territories-overview-{lod}.topojson"
        )
        _write_topology(
            overview_collection,
            overview_topology_target,
            quantization=int(lod_configs[lod]["quantization"]),
        )
        overview_topology_paths[lod] = str(overview_topology_target)
    chunks_directory = data_directory / "territories"
    chunks_directory.mkdir(parents=True, exist_ok=True)
    for stale_geojson in chunks_directory.glob("*.geojson"):
        stale_geojson.unlink()
    for stale_topology in chunks_directory.glob("*.topojson"):
        stale_topology.unlink()
    comparison_chunks_directory = (
        comparison_output_directory / "territories"
        if comparison_output_directory is not None
        else None
    )
    if comparison_chunks_directory is not None:
        comparison_chunks_directory.mkdir(parents=True, exist_ok=True)
        for stale_geojson in comparison_chunks_directory.glob("*.geojson"):
            stale_geojson.unlink()
    prefecture_codes = sorted(features_by_prefecture_and_lod["l3"])
    for lod in ("l1", "l2", "l3"):
        for prefecture_code in prefecture_codes:
            prefecture_features = features_by_prefecture_and_lod[lod][prefecture_code]
            chunk = collection_for_lod(
                lod,
                prefecture_features,
                detail_level="prefecture",
                prefecture_code=prefecture_code,
            )
            if comparison_chunks_directory is not None and lod == "l3":
                comparison_chunk = (
                    comparison_chunks_directory / f"{prefecture_code}.geojson"
                )
                comparison_chunk.write_text(
                    json.dumps(
                        chunk,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    + "\n"
                )
            _write_topology(
                chunk,
                chunks_directory / f"{prefecture_code}-{lod}.topojson",
                quantization=int(lod_configs[lod]["quantization"]),
            )
    prefecture_result = _export_prefecture_data(
        connection,
        database_path=database_path,
        snapshot_date=snapshot_date,
        output_directory=output_directory,
        tolerance=float(lod_configs["l0"]["vw_tolerance"]),
        territory_features=features_by_lod["l0"],
    )
    profile_result = _export_municipality_profiles(
        connection,
        snapshot_date=snapshot_date,
        output_directory=output_directory,
        map_rows=map_rows,
    )
    return {
        "snapshot_date": snapshot_date,
        "territories": len(features_by_lod["l3"]),
        "matched_flags": matched_flag_count,
        "copied_flag_assets": len(copied_flags),
        "comparison_geojson_path": (
            str(comparison_target) if comparison_target is not None else None
        ),
        "comparison_overview_geojson_paths": comparison_overview_paths,
        "overview_topojson_paths": overview_topology_paths,
        "prefecture_chunks": len(prefecture_codes) * 3,
        "lod_simplification": lod_simplification,
        "prefecture_layer": prefecture_result,
        "municipality_profiles": profile_result,
    }
