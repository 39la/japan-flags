import { describe, expect, it } from "vitest";
import { buildMapRenderer } from "./map-model";
import type { MapFeature, PrefectureFeature, PrefectureProperties } from "./types";

function feature(
  code: string,
  name: string,
  mapRegion: PrefectureProperties["mapRegion"],
  longitude: number,
  latitude: number,
): PrefectureFeature {
  return {
    type: "Feature",
    id: `${code}:${mapRegion}`,
    bbox: [longitude, latitude, longitude + 0.5, latitude + 0.5],
    properties: {
      prefectureVersionId: Number(code),
      prefectureCode: code,
      displayName: name,
      prefectureName: name,
      entityType: "prefecture",
      snapshotDate: "20260101",
      flagPageId: null,
      flagPath: null,
      flagRole: null,
      assignmentKind: null,
      matchMethod: null,
      confidence: null,
      commonsUrl: null,
      mapRegion,
      mapPart: `${code}:${mapRegion}`,
    },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [longitude, latitude],
          [longitude, latitude + 0.5],
          [longitude + 0.5, latitude + 0.5],
          [longitude + 0.5, latitude],
          [longitude, latitude],
        ],
      ],
    },
  };
}

describe("buildMapRenderer", () => {
  it("places remote islands in one projection at their geographic positions", () => {
    const features: MapFeature[] = [
      feature("01", "北海道", "main", 141, 43),
      feature("13", "東京都島嶼部", "islands", 142, 27),
      feature("47", "沖縄県", "okinawa", 127, 26),
    ];
    const renderer = buildMapRenderer(features);

    expect(renderer).not.toBeNull();
    if (!renderer) return;
    expect(renderer.features).toHaveLength(3);
    const hokkaido = renderer.projection([141, 43]);
    const tokyoIslands = renderer.projection([142, 27]);
    const okinawa = renderer.projection([127, 26]);
    expect(hokkaido).not.toBeNull();
    expect(tokyoIslands).not.toBeNull();
    expect(okinawa).not.toBeNull();
    if (!hokkaido || !tokyoIslands || !okinawa) return;
    expect(okinawa[0]).toBeLessThan(hokkaido[0]);
    expect(okinawa[1]).toBeGreaterThan(hokkaido[1]);
    expect(tokyoIslands[1]).toBeGreaterThan(hokkaido[1]);
  });

  it("reuses an existing projection when the feature set changes", () => {
    const features: MapFeature[] = [
      feature("01", "北海道", "main", 141, 43),
      feature("13", "東京都", "main", 139, 35),
    ];
    const initial = buildMapRenderer(features);
    expect(initial).not.toBeNull();
    if (!initial) return;
    const updated = buildMapRenderer(
      [...features, feature("47", "沖縄県", "okinawa", 127, 26)],
      initial.projection,
    );

    expect(updated).not.toBeNull();
    if (!updated) return;
    expect(updated.projection).toBe(initial.projection);
  });
});
