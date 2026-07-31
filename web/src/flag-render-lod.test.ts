import { describe, expect, it } from "vitest";
import { DIRECT_SVG_MIN_PIXEL_SIZE, flagRenderLod } from "./flag-render-lod";

describe("flagRenderLod", () => {
  it("skips flags that are smaller than a visible screen pixel", () => {
    expect(flagRenderLod(1.24)).toEqual({
      rasterBucket: null,
      useDirectSvg: false,
    });
  });

  it("uses a bitmap before switching to direct SVG", () => {
    expect(flagRenderLod(50)).toEqual({
      rasterBucket: 64,
      useDirectSvg: false,
    });
    expect(flagRenderLod(192)).toEqual({
      rasterBucket: 256,
      useDirectSvg: false,
    });
  });

  it("keeps a 256px fallback while drawing SVG directly at high zoom", () => {
    expect(flagRenderLod(DIRECT_SVG_MIN_PIXEL_SIZE)).toEqual({
      rasterBucket: 256,
      useDirectSvg: true,
    });
    expect(flagRenderLod(1200)).toEqual({
      rasterBucket: 256,
      useDirectSvg: true,
    });
  });
});
