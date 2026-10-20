import { describe, expect, it, vi } from "vitest";
import { hitTestFeature, type FeatureHitMap } from "./feature-hit-map";
import type { MapFeature } from "./types";

describe("hitTestFeature", () => {
  it("decodes the feature id from one pixel", () => {
    const selected = {} as MapFeature;
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray([2, 0, 0, 255]) }));
    const map = {
      canvas: { width: 2000, height: 1520 },
      context: { getImageData },
      features: [{} as MapFeature, selected],
      scale: 2,
    } as unknown as FeatureHitMap;

    expect(hitTestFeature(map, 12.25, 8.75)).toBe(selected);
    expect(getImageData).toHaveBeenCalledWith(24, 17, 1, 1);
  });

  it("skips pixel reads outside the map", () => {
    const getImageData = vi.fn();
    const map = {
      canvas: { width: 2000, height: 1520 },
      context: { getImageData },
      features: [],
      scale: 2,
    } as unknown as FeatureHitMap;

    expect(hitTestFeature(map, -1, 0)).toBeNull();
    expect(getImageData).not.toHaveBeenCalled();
  });
});
