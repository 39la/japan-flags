import { describe, expect, it } from "vitest";
import { fitCanvasViewport, viewportPointToContent } from "./canvas-viewport";

describe("fitCanvasViewport", () => {
  it("preserves the map aspect ratio in a wide viewport", () => {
    const viewport = fitCanvasViewport(1280, 656, 1000, 760);
    expect(viewport.scale).toBeCloseTo(656 / 760);
    expect(viewport.contentWidth / viewport.contentHeight).toBeCloseTo(1000 / 760);
    expect(viewport.offsetX).toBeGreaterThan(0);
    expect(viewport.offsetY).toBeCloseTo(0);
  });

  it("maps the fitted viewport center back to the map center", () => {
    const viewport = fitCanvasViewport(390, 844, 1000, 760);
    const center = viewportPointToContent(viewport, 195, 422);
    expect(center.x).toBeCloseTo(500);
    expect(center.y).toBeCloseTo(380);
  });
});
