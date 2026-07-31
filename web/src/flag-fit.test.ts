import { describe, expect, it } from "vitest";
import { DEFAULT_MOTIF_PLACEMENT, placeMotif } from "./flag-fit";

describe("placeMotif", () => {
  it("uses the visual anchor and preserves the motif aspect ratio", () => {
    const placement = placeMotif(
      200,
      100,
      [
        [0, 0],
        [100, 80],
      ],
      [0.7, 0.25],
      0.3,
      DEFAULT_MOTIF_PLACEMENT,
    );

    expect(placement.width / placement.height).toBeCloseTo(2);
    expect(placement.x + placement.width / 2).toBeCloseTo(70);
    expect(placement.y + placement.height / 2).toBeCloseTo(20);
    expect(Math.max(placement.width, placement.height)).toBeLessThanOrEqual(56);
  });

  it("can blend back toward the bbox center", () => {
    const placement = placeMotif(
      1,
      1,
      [
        [0, 0],
        [100, 100],
      ],
      [0.9, 0.1],
      0.4,
      {
        ...DEFAULT_MOTIF_PLACEMENT,
        anchorMode: "hybrid",
        anchorBias: 0,
      },
      [0.5, 0.5],
    );

    expect(placement.x + placement.width / 2).toBeCloseTo(50);
    expect(placement.y + placement.height / 2).toBeCloseTo(50);
  });

  it("switches among centroid, hybrid, and optimized anchors", () => {
    const bounds: [[number, number], [number, number]] = [
      [0, 0],
      [100, 100],
    ];
    const centroid = placeMotif(
      1,
      1,
      bounds,
      [0.8, 0.2],
      0.4,
      { ...DEFAULT_MOTIF_PLACEMENT, anchorMode: "centroid" },
      [0.3, 0.7],
      [0.6, 0.4],
    );
    const optimized = placeMotif(
      1,
      1,
      bounds,
      [0.8, 0.2],
      0.4,
      { ...DEFAULT_MOTIF_PLACEMENT, anchorMode: "optimized" },
      [0.3, 0.7],
      [0.6, 0.4],
    );
    expect(centroid.x + centroid.width / 2).toBeCloseTo(30);
    expect(centroid.y + centroid.height / 2).toBeCloseTo(70);
    expect(optimized.x + optimized.width / 2).toBeCloseTo(60);
    expect(optimized.y + optimized.height / 2).toBeCloseTo(40);
  });

  it("uses the primary component for size clamps and permits overflow", () => {
    const base = placeMotif(
      1,
      1,
      [
        [0, 0],
        [200, 100],
      ],
      [0.25, 0.5],
      0.2,
      { ...DEFAULT_MOTIF_PLACEMENT, minSizeRatio: 0, maxSizeRatio: 2 },
      null,
      null,
      [0, 0, 0.5, 1],
    );
    const overflow = placeMotif(
      1,
      1,
      [
        [0, 0],
        [200, 100],
      ],
      [0.25, 0.5],
      0.2,
      {
        ...DEFAULT_MOTIF_PLACEMENT,
        minSizeRatio: 0,
        maxSizeRatio: 2,
        overflow: 0.5,
      },
      null,
      null,
      [0, 0, 0.5, 1],
    );
    expect(overflow.width).toBeCloseTo(base.width * 1.5);
  });
});
