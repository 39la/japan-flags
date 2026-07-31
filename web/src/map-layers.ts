import type { Position } from "geojson";
import type { MapArcGeometry, MapRegion, PrefectureFeature, TerritoryFeature } from "./types";

function polygonsOf(feature: TerritoryFeature): Position[][][] {
  return feature.geometry.type === "Polygon"
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates;
}

function combinedBounds(features: TerritoryFeature[]) {
  const bounds = features
    .map((feature) => feature.bbox)
    .filter((bbox): bbox is [number, number, number, number] => bbox?.length === 4);
  if (!bounds.length) return undefined;
  return bounds.reduce<[number, number, number, number]>(
    (current, bbox) => [
      Math.min(current[0], bbox[0]),
      Math.min(current[1], bbox[1]),
      Math.max(current[2], bbox[2]),
      Math.max(current[3], bbox[3]),
    ],
    [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ],
  );
}

function combinedArcGeometry(features: TerritoryFeature[]): MapArcGeometry | undefined {
  const geometries = features.map((feature) => feature.arcGeometry);
  const source = geometries[0]?.source;
  if (!source || geometries.some((geometry) => geometry?.source !== source)) {
    return undefined;
  }
  return {
    source,
    polygons: geometries.flatMap((geometry) => geometry?.polygons ?? []),
  };
}

function sameMembers(left: TerritoryFeature[], right: TerritoryFeature[]) {
  return left.length === right.length && left.every((feature, index) => feature === right[index]);
}

function derivePrefectureFeature(
  key: string,
  template: PrefectureFeature,
  features: TerritoryFeature[],
) {
  const [, regionValue] = key.split(":");
  const region = regionValue as MapRegion;
  return {
    type: "Feature" as const,
    id: key,
    properties: {
      ...template.properties,
      mapRegion: region,
      mapPart: key,
    },
    geometry: {
      type: "MultiPolygon" as const,
      coordinates: features.flatMap(polygonsOf),
    },
    bbox: combinedBounds(features),
    arcGeometry: combinedArcGeometry(features),
  };
}

export function createPrefectureFeatureDeriver() {
  const cache = new Map<
    string,
    {
      template: PrefectureFeature;
      members: TerritoryFeature[];
      result: PrefectureFeature;
    }
  >();

  return (
    prefectureMetadata: PrefectureFeature[],
    territories: TerritoryFeature[],
  ): PrefectureFeature[] => {
    const templates = new Map<string, PrefectureFeature>();
    for (const feature of prefectureMetadata) {
      templates.set(
        `${feature.properties.prefectureCode}:${feature.properties.mapRegion}`,
        feature,
      );
    }
    const groups = new Map<string, TerritoryFeature[]>();
    for (const feature of territories) {
      const code = feature.properties.prefectureCode ?? feature.properties.jis5.slice(0, 2);
      const region = feature.properties.mapRegion;
      const key = `${code}:${region}`;
      const group = groups.get(key) ?? [];
      group.push(feature);
      groups.set(key, group);
    }

    const result: PrefectureFeature[] = [];
    for (const [key, features] of groups) {
      const [code] = key.split(":");
      const template =
        templates.get(key) ??
        prefectureMetadata.find((feature) => feature.properties.prefectureCode === code);
      if (!template) continue;
      const cached = cache.get(key);
      if (cached && cached.template === template && sameMembers(cached.members, features)) {
        result.push(cached.result);
        continue;
      }
      const derived = derivePrefectureFeature(key, template, features);
      cache.set(key, { template, members: features, result: derived });
      result.push(derived);
    }
    for (const key of cache.keys()) {
      if (!groups.has(key)) cache.delete(key);
    }
    return result.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  };
}

export function derivePrefectureFeatures(
  prefectureMetadata: PrefectureFeature[],
  territories: TerritoryFeature[],
): PrefectureFeature[] {
  return createPrefectureFeatureDeriver()(prefectureMetadata, territories);
}
