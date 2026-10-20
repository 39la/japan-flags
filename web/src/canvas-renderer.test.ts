import { afterEach, describe, expect, it, vi } from "vitest";
import { resizeVisibleCanvases } from "./canvas-renderer";

function canvas(width: number, height: number) {
  return {
    clientWidth: width,
    clientHeight: height,
    width: 0,
    height: 0,
  } as unknown as HTMLCanvasElement;
}

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
