import { describe, expect, it } from "vitest";
import { exportCamera, parseMapExportRequest, scopeMapFeatures } from "./map-export";
import type { RenderedFeature } from "./map-geometry";
import type { TerritoryFeature } from "./types";

const feature = (code: string, bounds: [[number, number], [number, number]]): RenderedFeature => ({
  feature: {
    type: "Feature",
    properties: {
      territoryVersionId: Number(code),
      jis5: `${code}101`,
      prefectureCode: code,
      displayName: code,
      prefectureName: code,
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
    geometry: { type: "Polygon", coordinates: [] },
  } satisfies TerritoryFeature,
  canvasPath: null,
  bounds,
});

describe("parseMapExportRequest", () => {
  it("parses and normalizes a render-only query", () => {
    expect(
      parseMapExportRequest("?mapExport=1&layer=municipality&fitMode=motif&codes=13,01,13"),
    ).toEqual({ layer: "municipality", fitMode: "motif", codes: ["01", "13"], fill: 0.86 });
  });

  it("ignores normal application URLs", () => {
    expect(parseMapExportRequest("?flagDebug=1")).toBeNull();
  });
});

describe("exportCamera", () => {
  it("fits only requested prefectures", () => {
    const camera = exportCamera(
      [
        feature("01", [
          [100, 100],
          [200, 200],
        ]),
        feature("13", [
          [400, 300],
          [500, 400],
        ]),
      ],
      { layer: "municipality", fitMode: "cover", codes: ["13"], fill: 0.8 },
      { x: 0, y: 0, k: 1 },
    );
    expect(camera).not.toBeNull();
    expect(camera!.x + camera!.k * 450).toBeCloseTo(500);
    expect(camera!.y + camera!.k * 350).toBeCloseTo(380);
  });
});

describe("scopeMapFeatures", () => {
  it("removes neighbouring prefectures from standalone exports", () => {
    const features = [
      feature("01", [
        [0, 0],
        [1, 1],
      ]),
      feature("13", [
        [1, 1],
        [2, 2],
      ]),
    ];
    const scoped = scopeMapFeatures(
      features.map((item) => item.feature),
      { layer: "municipality", fitMode: "cover", codes: ["13"], fill: 0.86 },
    );
    expect(scoped.map((item) => item.properties.prefectureCode)).toEqual(["13"]);
  });
});
