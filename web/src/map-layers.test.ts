import { describe, expect, it } from "vitest";
import { createPrefectureFeatureDeriver, derivePrefectureFeatures } from "./map-layers";
import type { MapArcSource, PrefectureFeature, TerritoryFeature } from "./types";

const source: MapArcSource = { key: "municipality:l0", arcs: [] };

function territory(jis5: string, x: number): TerritoryFeature {
  return {
    type: "Feature",
    id: jis5,
    properties: {
      territoryVersionId: Number(jis5),
      jis5,
      prefectureCode: jis5.slice(0, 2),
      displayName: jis5,
      prefectureName: "試験県",
      entityType: "municipality",
      snapshotDate: "20260101",
      flagPageId: null,
      flagPath: null,
      flagRole: null,
      assignmentKind: null,
      matchMethod: null,
      confidence: null,
      commonsUrl: null,
      mapRegion: "main",
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [x, 0],
          [x + 1, 0],
          [x + 1, 1],
          [x, 1],
          [x, 0],
        ],
      ],
    },
    bbox: [x, 0, x + 1, 1],
    arcGeometry: { source, polygons: [[[Number(jis5)]]] },
  };
}

const prefecture: PrefectureFeature = {
  type: "Feature",
  id: "13:main",
  properties: {
    prefectureVersionId: 13,
    prefectureCode: "13",
    displayName: "試験県",
    prefectureName: "試験県",
    entityType: "prefecture",
    snapshotDate: "20260101",
    flagPageId: null,
    flagPath: null,
    flagRole: null,
    assignmentKind: null,
    matchMethod: null,
    confidence: null,
    commonsUrl: null,
    mapRegion: "main",
    mapPart: "13:main",
  },
  geometry: territory("13001", 0).geometry,
};

describe("derivePrefectureFeatures", () => {
  it("groups municipality polygons without changing their coordinates or arc source", () => {
    const features = [territory("13001", 0), territory("13002", 1)];
    const [derived] = derivePrefectureFeatures([prefecture], features);
    expect(derived.geometry.type).toBe("MultiPolygon");
    expect(derived.geometry.coordinates).toEqual(
      features.map((feature) =>
        feature.geometry.type === "Polygon"
          ? feature.geometry.coordinates
          : feature.geometry.coordinates[0],
      ),
    );
    expect(derived.arcGeometry?.source).toBe(source);
    expect(derived.arcGeometry?.polygons).toHaveLength(2);
    expect(derived.bbox).toEqual([0, 0, 2, 1]);
  });

  it("reuses a derived prefecture while its municipality members stay unchanged", () => {
    const derive = createPrefectureFeatureDeriver();
    const features = [territory("13001", 0), territory("13002", 1)];
    const [first] = derive([prefecture], features);
    const [second] = derive([prefecture], [...features]);

    expect(second).toBe(first);
  });
});
