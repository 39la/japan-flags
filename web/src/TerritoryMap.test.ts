import { describe, expect, it } from "vitest";
import { focusFeatureCamera, sceneCacheContainsViewport, zoomCamera } from "./map-camera";
import type { RenderedFeature } from "./map-geometry";
import type { TerritoryFeature } from "./types";

const cache = {
  camera: { x: 10, y: 20, k: 4 },
  marginX: 300,
  marginY: 210,
  visiblePixelWidth: 1200,
  visiblePixelHeight: 800,
};

describe("sceneCacheContainsViewport", () => {
  it("reuses a same-scale pan while it remains inside overscan", () => {
    expect(sceneCacheContainsViewport(cache, { x: 260, y: -150, k: 4 }, 1200, 800)).toBe(true);
  });

  it("invalidates at an overscan, zoom, or viewport boundary", () => {
    expect(sceneCacheContainsViewport(cache, { x: 311, y: 20, k: 4 }, 1200, 800)).toBe(false);
    expect(sceneCacheContainsViewport(cache, { x: 10, y: 20, k: 5 }, 1200, 800)).toBe(false);
    expect(sceneCacheContainsViewport(cache, { x: 10, y: 20, k: 4 }, 1199, 800)).toBe(false);
  });
});

describe("focusFeatureCamera", () => {
  it("centers and zooms to a municipality selected by search", () => {
    const feature: TerritoryFeature = {
      type: "Feature",
      properties: {
        territoryVersionId: 1,
        jis5: "13101",
        prefectureCode: "13",
        displayName: "千代田区",
        prefectureName: "東京都",
        entityType: "special_ward",
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
    };
    const rendered: RenderedFeature[] = [
      {
        feature,
        canvasPath: null,
        bounds: [
          [400, 300],
          [500, 400],
        ],
      },
    ];
    const camera = focusFeatureCamera(rendered, feature, "municipality");
    expect(camera).not.toBeNull();
    expect(camera!.k).toBeGreaterThan(1);
    expect(camera!.x + camera!.k * 450).toBeCloseTo(500);
    expect(camera!.y + camera!.k * 350).toBeCloseTo(380);
  });
});

describe("zoomCamera", () => {
  it("keeps the map center fixed while changing scale", () => {
    const camera = zoomCamera({ x: 10, y: 20, k: 2 }, 1.5);
    expect(camera.k).toBe(3);
    expect(camera.x + camera.k * ((500 - 10) / 2)).toBeCloseTo(500);
    expect(camera.y + camera.k * ((380 - 20) / 2)).toBeCloseTo(380);
  });
});
