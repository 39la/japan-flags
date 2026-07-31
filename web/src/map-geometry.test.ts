import { geoMercator, geoPath } from "d3-geo";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectBoundaryArcSets,
  cachedRenderedBoundaries,
  cacheRenderedBoundaries,
  createProjectedArcStore,
  createRenderedBoundaryCompiler,
  createRenderedFeatureCompiler,
  type RenderedFeature,
  type RenderedBoundary,
  type RenderedFeatureCache,
  type RenderedBoundaryCache,
  type BoundarySourceGroup,
} from "./map-geometry";
import type { MapArcSource, MapFeature } from "./types";

function feature(jis5: string): MapFeature {
  return {
    type: "Feature",
    bbox: [139, 35, 140, 36],
    properties: {
      territoryVersionId: Number(jis5),
      jis5,
      prefectureCode: jis5.slice(0, 2),
      displayName: jis5,
      prefectureName: "テスト県",
      entityType: "municipality",
      snapshotDate: "20260101",
      flagPageId: 1,
      flagPath: "/flags/1.svg",
      flagRole: "primary",
      assignmentKind: "direct",
      matchMethod: "test",
      confidence: 1,
      commonsUrl: null,
      mapRegion: "main",
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [139, 35],
          [139, 36],
          [140, 36],
          [140, 35],
          [139, 35],
        ],
      ],
    },
  };
}

function finishCompiler(compiler: ReturnType<typeof createRenderedFeatureCompiler>) {
  let item: RenderedFeature | null = null;
  while (!item) item = compiler.next();
  return { item, compiled: compiler.compiled };
}

describe("createRenderedFeatureCompiler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("only recompiles changed feature objects under a stable projection", () => {
    const pathInstances: Array<{ commands: string[] }> = [];
    class FakePath2D {
      commands: string[] = [];
      constructor() {
        pathInstances.push(this);
      }
      moveTo() {
        this.commands.push("moveTo");
      }
      lineTo() {
        this.commands.push("lineTo");
      }
      arc() {
        this.commands.push("arc");
      }
      closePath() {
        this.commands.push("closePath");
      }
    }
    vi.stubGlobal("Path2D", FakePath2D);
    const first = feature("13101");
    const second = feature("13102");
    const replacement = {
      ...second,
      properties: { ...second.properties },
    } as MapFeature;
    const projection = geoMercator().scale(100).translate([0, 0]);
    const otherProjection = geoMercator().scale(200).translate([0, 0]);
    const path = geoPath(projection);
    const otherPath = geoPath(otherProjection);
    const bounds = vi.spyOn(path, "bounds");
    const cache: RenderedFeatureCache = new WeakMap();

    const results = [
      finishCompiler(createRenderedFeatureCompiler(first, path, projection, cache)),
      finishCompiler(createRenderedFeatureCompiler(second, path, projection, cache)),
      finishCompiler(createRenderedFeatureCompiler(first, path, projection, cache)),
      finishCompiler(createRenderedFeatureCompiler(second, path, projection, cache)),
      finishCompiler(createRenderedFeatureCompiler(replacement, path, projection, cache)),
      finishCompiler(createRenderedFeatureCompiler(first, otherPath, otherProjection, cache)),
      finishCompiler(createRenderedFeatureCompiler(replacement, otherPath, otherProjection, cache)),
    ];

    expect(results.map((result) => result.compiled)).toEqual([
      true,
      true,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(bounds).not.toHaveBeenCalled();
    expect(pathInstances).toHaveLength(5);
    expect(pathInstances.every((instance) => instance.commands.includes("closePath"))).toBe(true);
    expect(results[0].item.bounds[0][0]).toBeLessThan(results[0].item.bounds[1][0]);
    expect(results[0].item.bounds[0][1]).toBeLessThan(results[0].item.bounds[1][1]);

    const multipart = {
      ...first,
      geometry: {
        type: "MultiPolygon" as const,
        coordinates: [
          [
            [
              [139, 35],
              [139, 35.2],
              [139.2, 35.2],
              [139.2, 35],
              [139, 35],
            ],
          ],
          [
            [
              [139.5, 35.5],
              [139.5, 35.7],
              [139.7, 35.7],
              [139.7, 35.5],
              [139.5, 35.5],
            ],
          ],
        ],
      },
    } as MapFeature;
    const multipartCompiler = createRenderedFeatureCompiler(multipart, path, projection, cache);

    expect(multipartCompiler.next()).toBeNull();
    expect(multipartCompiler.next()).not.toBeNull();
    expect(pathInstances).toHaveLength(6);
  });
});

describe("shared TopoJSON arcs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("projects each decoded arc only once", () => {
    const source: MapArcSource = {
      key: "overview:all",
      arcs: [
        [
          [130, 30],
          [131, 30],
          [131, 31],
        ],
      ],
    };
    const projection = geoMercator().scale(100).translate([0, 0]);
    const store = createProjectedArcStore(source, projection);

    const forward = store.get(0);
    const reverseReference = store.get(-1);

    expect(reverseReference).toBe(forward);
    expect(store.projectedArcCount()).toBe(1);
    expect(store.projectedPointCount()).toBe(3);
  });

  it("builds feature and boundary paths from the same projected arcs", () => {
    const pathInstances: Array<{
      commands: Array<[string, number?, number?]>;
    }> = [];
    class FakePath2D {
      commands: Array<[string, number?, number?]> = [];
      constructor() {
        pathInstances.push(this);
      }
      moveTo(x: number, y: number) {
        this.commands.push(["moveTo", x, y]);
      }
      lineTo(x: number, y: number) {
        this.commands.push(["lineTo", x, y]);
      }
      closePath() {
        this.commands.push(["closePath"]);
      }
    }
    vi.stubGlobal("Path2D", FakePath2D);
    const source: MapArcSource = {
      key: "prefecture:13",
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
    };
    const current = {
      ...feature("13101"),
      arcGeometry: {
        source,
        polygons: [[[0, 1, 2]]],
      },
    } as MapFeature;
    const projection = geoMercator().scale(100).translate([0, 0]);
    const path = geoPath(projection);
    const featureCache: RenderedFeatureCache = new WeakMap();
    const featureCompiler = createRenderedFeatureCompiler(current, path, projection, featureCache);
    const renderedFeature = finishCompiler(featureCompiler).item;
    const store = createProjectedArcStore(source, projection);
    expect(store.projectedArcCount()).toBe(3);

    const boundaries = collectBoundaryArcSets([current]);
    const boundaryCompiler = createRenderedBoundaryCompiler(boundaries[0], projection);
    let renderedBoundary = boundaryCompiler.next();
    while (!renderedBoundary) {
      renderedBoundary = boundaryCompiler.next();
    }

    expect(boundaries[0].arcIndexes).toEqual([0, 1, 2]);
    expect(store.projectedArcCount()).toBe(3);
    expect(renderedBoundary.pointCount).toBe(7);
    expect(renderedFeature.canvasPath).toBe(pathInstances[0]);
    expect(renderedBoundary.canvasPaths[0]).toBe(pathInstances[1]);
    const featureCoordinates = pathInstances[0].commands
      .filter(([command]) => command !== "closePath")
      .map(([, x, y]) => [x, y]);
    const boundaryCoordinates = pathInstances[1].commands
      .filter(([command]) => command !== "closePath")
      .map(([, x, y]) => [x, y]);
    for (const coordinate of featureCoordinates) {
      expect(boundaryCoordinates).toContainEqual(coordinate);
    }
  });

  it("omits municipality-internal shared arcs from prefecture boundaries", () => {
    const source: MapArcSource = {
      key: "municipality:overview:all",
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
        ],
      ],
    };
    const current: MapFeature = {
      type: "Feature",
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
      geometry: { type: "MultiPolygon", coordinates: [] },
      arcGeometry: {
        source,
        polygons: [[[0, 1]], [[~1, 2]]],
      },
    };
    expect(collectBoundaryArcSets([current])[0].arcIndexes).toEqual([0, 2]);
  });

  it("caches rendered boundaries by source, projection, and feature signature", () => {
    const source: MapArcSource = {
      key: "overview:all",
      arcs: [],
    };
    const projection = geoMercator().scale(100).translate([0, 0]);
    const cache: RenderedBoundaryCache = new WeakMap();
    const group: BoundarySourceGroup = {
      source,
      signature: "territory:1",
      arcSets: [],
    };
    const items: RenderedBoundary[] = [
      {
        source: {
          key: "overview:all:13",
          prefectureCode: "13",
          source,
          arcIndexes: [],
        },
        canvasPaths: [],
        bounds: [
          [0, 0],
          [1, 1],
        ],
        pointCount: 0,
      },
    ];

    cacheRenderedBoundaries(cache, group, projection, items);

    expect(cachedRenderedBoundaries(cache, group, projection)).toBe(items);
    expect(
      cachedRenderedBoundaries(cache, { ...group, signature: "territory:2" }, projection),
    ).toBeNull();
    expect(
      cachedRenderedBoundaries(cache, group, geoMercator().scale(100).translate([0, 0])),
    ).toBeNull();
    for (let index = 2; index <= 5; index += 1) {
      cacheRenderedBoundaries(cache, { ...group, signature: `territory:${index}` }, projection, []);
    }
    expect(cachedRenderedBoundaries(cache, group, projection)).toBeNull();
  });
});
