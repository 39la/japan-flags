import { describe, expect, it } from "vitest";
import {
  detailGeometryLod,
  geometryLodForRenderScale,
  overviewGeometryLod,
  physicalRenderScale,
} from "./render-scale";

describe("render scale LOD", () => {
  it("uses physical canvas pixels as the shared scale", () => {
    expect(physicalRenderScale(1.5, 8)).toBe(12);
  });

  it("selects the coarsest geometry below the screen-error budget", () => {
    expect(geometryLodForRenderScale(1)).toBe("l0");
    expect(geometryLodForRenderScale(2)).toBe("l1");
    expect(geometryLodForRenderScale(8)).toBe("l2");
    expect(geometryLodForRenderScale(30)).toBe("l3");
  });

  it("uses hysteresis around an existing tier", () => {
    expect(geometryLodForRenderScale(1.5, "l0")).toBe("l0");
    expect(geometryLodForRenderScale(1.7, "l0")).toBe("l1");
    expect(geometryLodForRenderScale(1.3, "l1")).toBe("l1");
    expect(geometryLodForRenderScale(1.1, "l1")).toBe("l0");
  });

  it("maps runtime tiers to available overview and detail assets", () => {
    expect(overviewGeometryLod("l3")).toBe("l1");
    expect(detailGeometryLod("l0")).toBe("l1");
    expect(detailGeometryLod("l2")).toBe("l2");
  });
});
