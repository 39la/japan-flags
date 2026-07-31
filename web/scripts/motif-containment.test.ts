import { describe, expect, it } from "vitest";
import { analyzeMotifContainment, hasContainedVisiblePixels } from "./motif-containment.mjs";

function raster(width: number, height: number, pixels: Array<[number, number]>) {
  const data = new Uint8Array(width * height * 4);
  for (const [x, y] of pixels) data[(y * width + x) * 4 + 3] = 255;
  return { width, height, data };
}

describe("motif edge containment", () => {
  it("allows a sparse intentional edge contact", () => {
    const pixels: Array<[number, number]> = [];
    for (let x = 0; x < 30; x += 1) pixels.push([x, 20]);
    for (let y = 18; y <= 22; y += 1) pixels.push([0, y]);
    const result = raster(96, 64, pixels);
    expect(analyzeMotifContainment(result).longestEdgeRun).toBe(5);
    expect(hasContainedVisiblePixels(result)).toBe(true);
  });

  it("rejects a composition band running along an edge", () => {
    const pixels: Array<[number, number]> = [];
    for (let x = 0; x < 96; x += 1) {
      for (let y = 0; y < 12; y += 1) pixels.push([x, y]);
    }
    expect(hasContainedVisiblePixels(raster(96, 64, pixels))).toBe(false);
  });
});
