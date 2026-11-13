import { afterEach, describe, expect, it, vi } from "vitest";
import { collectBoundaryArcSets } from "./map-geometry";
import { decodeMapData, decodeMapDataAsync, decodeTerritoryData } from "./topology";

describe("decodeTerritoryData", () => {
  it("uses the same shared-arc contract for prefectures", () => {
    const collection = decodeMapData({
      type: "Topology",
      arcs: [
        [
          [139, 35],
          [140, 35],
        ],
        [
          [140, 35],
          [140, 36],
        ],
        [
          [140, 36],
          [139, 36],
          [139, 35],
        ],
      ],
      objects: {
        territories: {
          type: "GeometryCollection",
          geometries: [
            {
              type: "Polygon",
              id: "13:main",
              arcs: [[0, 1, 2]],
              properties: {
                prefectureVersionId: 13,
                prefectureCode: "13",
                displayName: "東京都",
                prefectureName: "東京都",
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
            },
          ],
        },
      },
      metadata: {
        snapshotDate: "20260101",
        mapLayer: "prefecture",
        detailLevel: "overview",
        geometryLod: "l0",
        simplificationTolerance: 0.01,
        prefectureCount: 1,
        matchedFlagCount: 0,
      },
    });

    expect(collection.features[0].properties.entityType).toBe("prefecture");
    expect(collection.features[0].arcGeometry?.source.key).toBe("prefecture:overview:all");
    expect(collectBoundaryArcSets(collection.features)).toHaveLength(1);
  });

  it("decodes the exported TopoJSON contract", () => {
    const collection = decodeTerritoryData({
      type: "Topology",
      transform: {
        scale: [0.1, 0.1],
        translate: [130, 30],
      },
      arcs: [
        [
          [0, 0],
          [0, 10],
          [10, 0],
          [0, -10],
          [-10, 0],
        ],
      ],
      objects: {
        territories: {
          type: "GeometryCollection",
          geometries: [
            {
              type: "Polygon",
              id: 1,
              bbox: [130, 30, 131, 31],
              arcs: [[0]],
              properties: {
                territoryVersionId: 1,
                jis5: "99999",
                prefectureCode: "99",
                displayName: "試験町",
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
            },
          ],
        },
      },
      metadata: {
        snapshotDate: "20260101",
        simplificationTolerance: 0.02,
        simplificationToleranceUnit: "sqrt-screen-pixel-area",
        territoryCount: 1,
        matchedFlagCount: 0,
        quantization: 1_000_000,
        objectName: "territories",
      },
    });

    expect(collection.type).toBe("FeatureCollection");
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0].properties.displayName).toBe("試験町");
    expect(collection.features[0].bbox).toEqual([130, 30, 131, 31]);
    expect(collection.features[0].geometry.type).toBe("Polygon");
    expect(collection.metadata.simplificationToleranceUnit).toBe("sqrt-screen-pixel-area");
    expect(collection.features[0].arcGeometry).toMatchObject({
      source: {
        key: "municipality:overview:all",
        arcs: [
          [
            [130, 30],
            [130, 31],
            [131, 31],
            [131, 30],
            [130, 30],
          ],
        ],
      },
      polygons: [[[0]]],
    });
    expect(collection.features[0].arcGeometry?.source.arcs).toHaveLength(1);
    const geometry = collection.features[0].geometry;
    expect(geometry.type).toBe("Polygon");
    if (geometry.type === "Polygon") {
      expect(geometry.coordinates[0][0]).toBe(
        collection.features[0].arcGeometry?.source.arcs[0][0],
      );
    }
  });

  it("normalizes every MultiPolygon exterior for D3", () => {
    const collection = decodeTerritoryData({
      type: "Topology",
      arcs: [
        [
          [0, 0],
          [0, 10],
          [10, 0],
          [0, -10],
          [-10, 0],
        ],
        [
          [20, 0],
          [10, 0],
          [0, 10],
          [-10, 0],
          [0, -10],
        ],
      ],
      objects: {
        territories: {
          type: "GeometryCollection",
          geometries: [
            {
              type: "MultiPolygon",
              id: 1,
              arcs: [[[0]], [[1]]],
              properties: {
                territoryVersionId: 1,
                jis5: "12204",
                prefectureCode: "12",
                displayName: "船橋市",
                prefectureName: "千葉県",
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
            },
          ],
        },
      },
      metadata: {
        snapshotDate: "20260101",
        simplificationTolerance: 0.02,
        territoryCount: 1,
        matchedFlagCount: 0,
      },
    });

    const geometry = collection.features[0].geometry;
    expect(geometry.type).toBe("MultiPolygon");
    if (geometry.type !== "MultiPolygon") return;
    for (const polygon of geometry.coordinates) {
      const ring = polygon[0];
      const signedArea = ring.slice(0, -1).reduce((area, point, index) => {
        const next = ring[index + 1];
        return area + point[0] * next[1] - next[0] * point[1];
      }, 0);
      expect(signedArea).toBeLessThan(0);
    }
  });

  it("retains shared TopoJSON arcs for features and boundaries", () => {
    const properties = (jis5: string) => ({
      territoryVersionId: Number(jis5),
      jis5,
      prefectureCode: "99",
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
    });
    const collection = decodeTerritoryData({
      type: "Topology",
      arcs: [
        [
          [0, 0],
          [1, 0],
        ],
        [
          [1, 0],
          [1, 1],
        ],
        [
          [1, 1],
          [0, 1],
          [0, 0],
        ],
        [
          [1, 0],
          [2, 0],
          [2, 1],
          [1, 1],
        ],
      ],
      objects: {
        territories: {
          type: "GeometryCollection",
          geometries: [
            {
              type: "Polygon",
              id: 1,
              arcs: [[0, 1, 2]],
              properties: properties("99001"),
            },
            {
              type: "Polygon",
              id: 2,
              arcs: [[3, -2]],
              properties: properties("99002"),
            },
          ],
        },
      },
      metadata: {
        snapshotDate: "20260101",
        simplificationTolerance: 0.02,
        detailLevel: "prefecture",
        prefectureCode: "99",
        territoryCount: 2,
        matchedFlagCount: 0,
      },
    });

    const firstSource = collection.features[0].arcGeometry?.source;
    expect(firstSource).toBe(collection.features[1].arcGeometry?.source);
    expect(collection.features[1].arcGeometry?.polygons).toEqual([[[1, -4]]]);
    const boundaries = collectBoundaryArcSets(collection.features);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].prefectureCode).toBe("99");
    expect(boundaries[0].arcIndexes).toEqual([0, 1, 2, 3]);
  });
});

describe("decodeMapDataAsync scheduling", () => {
  const payload = {
    type: "Topology",
    arcs: [
      [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
        [0, 0],
      ],
    ],
    objects: {
      territories: {
        type: "GeometryCollection",
        geometries: Array.from({ length: 16 }, (_, id) => ({
          type: "Polygon",
          id,
          arcs: [[0]],
          properties: { territoryVersionId: id },
        })),
      },
    },
    metadata: { snapshotDate: "20260101" },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("yields without waiting for a display frame when the scheduler is available", async () => {
    const yieldTask = vi.fn(() => Promise.resolve());
    const frame = vi.fn();
    vi.stubGlobal("scheduler", { yield: yieldTask });
    vi.stubGlobal("requestAnimationFrame", frame);

    expect(await decodeMapDataAsync(payload)).toEqual(decodeMapData(payload));
    expect(yieldTask).toHaveBeenCalledOnce();
    expect(frame).not.toHaveBeenCalled();
  });

  it("keeps the animation-frame fallback without scheduler.yield", async () => {
    const frame = vi.fn((callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal("scheduler", undefined);
    vi.stubGlobal("requestAnimationFrame", frame);

    expect(await decodeMapDataAsync(payload)).toEqual(decodeMapData(payload));
    expect(frame).toHaveBeenCalledOnce();
  });
});
