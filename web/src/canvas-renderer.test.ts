import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drawMapOverlay,
  drawPrefectureBoundaries,
  drawSceneBoundaries,
  resizeVisibleCanvases,
} from "./canvas-renderer";
import type { RenderedBoundary } from "./map-geometry";
import type { MapDisplayOptions, MapFeature } from "./types";

function canvas(width: number, height: number) {
  return {
    clientWidth: width,
    clientHeight: height,
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;
}

describe("boundary chunk visibility", () => {
  afterEach(() => vi.unstubAllGlobals());

  function boundary(xs: number[]): RenderedBoundary {
    return {
      bounds: [
        [Math.min(...xs), 10],
        [Math.max(...xs) + 1, 20],
      ],
      chunks: xs.map((x) => ({
        bounds: [
          [x, 10],
          [x + 1, 20],
        ],
        canvasPath: {} as Path2D,
        vertexCount: 2,
      })),
    } as RenderedBoundary;
  }

  it("skips individual offscreen chunks and retains the stroke fringe", () => {
    const item = boundary([-1, 10, 2000]);
    const context = {
      lineWidth: 1,
      getTransform: () => ({ a: 1 }),
      stroke: vi.fn(),
    };
    drawSceneBoundaries(
      context as unknown as CanvasRenderingContext2D,
      [item],
      { x: 0, y: 0, k: 1 },
      0,
      0,
    );
    expect(context.stroke.mock.calls.map(([path]) => path)).toEqual([
      item.chunks[0].canvasPath,
      item.chunks[1].canvasPath,
    ]);
  });

  it("draws static prefecture borders throughout the cache overscan", () => {
    const item = boundary([1250, 2000]);
    const context = { lineWidth: 1, getTransform: () => ({ a: 1 }), stroke: vi.fn() };
    drawPrefectureBoundaries(
      context as unknown as CanvasRenderingContext2D,
      [item],
      { x: 0, y: 0, k: 1 },
      300,
      228,
    );
    expect(context.stroke.mock.calls.map(([path]) => path)).toEqual([item.chunks[0].canvasPath]);
  });

  it("keeps selection drawing when prefecture borders are already in the base cache", () => {
    vi.stubGlobal("Path2D", class {});
    const chosen = {
      properties: { entityType: "municipality", territoryVersionId: 1 },
    } as MapFeature;
    const selectedPath = {} as Path2D;
    const context = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      stroke: vi.fn(),
      strokeStyle: "",
      lineJoin: "miter",
      lineCap: "butt",
    };
    drawMapOverlay({
      canvas: {
        width: 1000,
        height: 760,
        getContext: () => context,
      } as unknown as HTMLCanvasElement,
      camera: { x: 0, y: 0, k: 1 },
      layer: "municipality",
      displayOptions: { showPrefectureBoundaries: true } as MapDisplayOptions,
      hovered: null,
      selected: chosen,
      renderedFeatures: [
        {
          feature: chosen,
          canvasPath: selectedPath,
          bounds: [
            [10, 10],
            [20, 20],
          ],
        },
      ],
      prefectureBoundaries: [boundary([10])],
      municipalityBoundaries: [],
      prefectureBoundariesCached: true,
    });
    expect(context.stroke).toHaveBeenCalledExactlyOnceWith(selectedPath);
    expect(context.strokeStyle).toBe("#d3261d");
    expect(context.lineJoin).toBe("round");
    expect(context.lineCap).toBe("round");
  });

  it("keeps overlay chunks in the visible letterbox space", () => {
    vi.stubGlobal("Path2D", class {});
    const item = boundary([-100, 10, 2000]);
    const context = {
      canvas: { width: 1400, height: 760 },
      lineWidth: 1,
      getTransform: () => ({ a: 1 }),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      stroke: vi.fn(),
    };
    const visibleCanvas = {
      ...context.canvas,
      getContext: () => context,
    } as unknown as HTMLCanvasElement;
    drawMapOverlay({
      canvas: visibleCanvas,
      camera: { x: 0, y: 0, k: 1 },
      layer: "municipality",
      displayOptions: { showPrefectureBoundaries: true } as MapDisplayOptions,
      hovered: null,
      selected: null,
      renderedFeatures: [],
      prefectureBoundaries: [item],
      municipalityBoundaries: [],
    });
    expect(context.stroke.mock.calls.map(([path]) => path)).toEqual([
      item.chunks[0].canvasPath,
      item.chunks[1].canvasPath,
    ]);
  });
});

describe("resizeVisibleCanvases", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sizes both canvases to the full device pixel ratio", () => {
    vi.stubGlobal("devicePixelRatio", 3);
    const base = canvas(1000, 760);
    const overlay = canvas(1000, 760);
    resizeVisibleCanvases(base, overlay);
    expect(base.width).toBe(3000);
    expect(base.height).toBe(2280);
    expect(overlay.width).toBe(3000);
    expect(overlay.height).toBe(2280);
  });

  it("keeps full resolution on large high-density displays", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const base = canvas(3840, 2160);
    const overlay = canvas(3840, 2160);
    resizeVisibleCanvases(base, overlay);
    expect(base.width).toBe(7680);
    expect(base.height).toBe(4320);
  });

  it("reports whether a canvas was resized", () => {
    vi.stubGlobal("devicePixelRatio", 1);
    const base = canvas(800, 600);
    const overlay = canvas(800, 600);
    expect(resizeVisibleCanvases(base, overlay)).toBe(true);
    expect(resizeVisibleCanvases(base, overlay)).toBe(false);
  });

  it("does nothing until both canvases exist", () => {
    expect(resizeVisibleCanvases(null, canvas(10, 10))).toBe(false);
  });
});
