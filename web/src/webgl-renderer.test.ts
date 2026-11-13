import { describe, expect, it, vi } from "vitest";
import { fitCanvasViewport } from "./canvas-viewport";
import type { RenderedBoundary } from "./map-geometry";
import {
  combineScene,
  createWebGLMapRenderer,
  sameSceneInput,
  visibleDrawRanges,
} from "./webgl-renderer";

type SceneFeature = Parameters<typeof combineScene>[0][number];

function feature(vertices: Float32Array, indices: Uint32Array): SceneFeature {
  return {
    item: { webglMesh: { vertices, indices, chunks: [] } } as unknown as SceneFeature["item"],
    hasFlag: true,
    visual: null,
    motifPlacement: null,
  };
}

function boundary(webglLines: Float32Array): RenderedBoundary {
  return { webglLines } as RenderedBoundary;
}

describe("combineScene", () => {
  it("concatenates buffers and offsets indices for each mesh", () => {
    const vertices = new Float32Array([0, 0, 1, 0, 0, 1]);
    const indices = new Uint32Array([0, 1, 2]);
    const scene = combineScene(
      [feature(vertices, indices), feature(vertices, indices)],
      [boundary(new Float32Array([0, 0, 1, 1])), boundary(new Float32Array([2, 2, 3, 3]))],
    );

    expect(scene.positions).toEqual(new Float32Array([...vertices, ...vertices]));
    expect(scene.indices).toEqual(new Uint32Array([0, 1, 2, 3, 4, 5]));
    expect(scene.colors).toEqual(new Float32Array(24).fill(1));
    expect(scene.linePositions).toEqual(new Float32Array([0, 0, 1, 1, 2, 2, 3, 3]));
  });

  it("handles individual meshes and boundaries larger than function argument limits", () => {
    const vertices = new Float32Array(400_000).fill(0.5);
    const lines = new Float32Array(400_000).fill(0.25);
    const scene = combineScene([feature(vertices, new Uint32Array([0, 1, 2]))], [boundary(lines)]);

    expect(scene.positions).toEqual(vertices);
    expect(scene.linePositions).toEqual(lines);
    expect(scene.colors).toHaveLength(800_000);
  });

  it("handles an empty scene", () => {
    const scene = combineScene([], []);
    for (const buffer of Object.values(scene)) expect(buffer).toHaveLength(0);
  });
});

describe("GPU chunk drawing", () => {
  it("draws visible triangle chunks with byte offsets instead of the entire feature", () => {
    const methods: Record<string, unknown> = {
      createShader: () => ({}),
      createProgram: () => ({}),
      createBuffer: () => ({}),
      getShaderParameter: () => true,
      getProgramParameter: () => true,
      getAttribLocation: () => 0,
      getUniformLocation: () => ({}),
      MAX_VIEWPORT_DIMS: 0x0d3a,
      getParameter: (name: number) => (name === 0x0d3a ? [16384, 16384] : 16384),
      TRIANGLES: 4,
      UNSIGNED_INT: 5125,
      drawElements: vi.fn(),
    };
    const gl = new Proxy(methods, {
      get(target, name: string) {
        if (!(name in target)) target[name] = /^[A-Z_]+$/.test(name) ? 0 : vi.fn();
        return target[name];
      },
    });
    const renderer = createWebGLMapRenderer({
      width: 1000,
      height: 760,
      getContext: () => gl,
    } as unknown as HTMLCanvasElement);
    const shape = feature(new Float32Array(18), new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    shape.item.webglMesh!.chunks = [10, 2000, 30].map((x) => ({
      bounds: [
        [x, 10],
        [x + 10, 20],
      ],
      indexCount: 3,
    }));
    expect(renderer).not.toBeNull();
    renderer!.setScene([shape], []);
    renderer!.draw({ x: 0, y: 0, k: 1 });
    expect(methods.drawElements).toHaveBeenCalledTimes(2);
    expect(methods.drawElements).toHaveBeenNthCalledWith(1, 4, 3, 5125, 0);
    expect(methods.drawElements).toHaveBeenNthCalledWith(2, 4, 3, 5125, 24);
  });
});

describe("sameSceneInput", () => {
  const shape = feature(new Float32Array([0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));
  const edge = boundary(new Float32Array([0, 0, 1, 1]));
  const input = { features: [shape], boundaries: [edge] };

  it("requires an initial upload but reuses unchanged drawing inputs", () => {
    expect(sameSceneInput(null, input)).toBe(false);
    expect(sameSceneInput(input, { features: [{ ...shape }], boundaries: [edge] })).toBe(true);
  });

  it("updates colors when the focused region changes without changing feature keys", () => {
    expect(
      sameSceneInput(input, { features: [{ ...shape, hasFlag: false }], boundaries: [edge] }),
    ).toBe(false);
  });

  it("updates a newly compiled item even if its buffers have the same lengths", () => {
    const recompiled = { ...shape, item: { ...shape.item } };
    expect(sameSceneInput(input, { features: [recompiled], boundaries: [edge] })).toBe(false);
  });

  it("updates changed boundaries", () => {
    expect(sameSceneInput(input, { features: [shape], boundaries: [{ ...edge }] })).toBe(false);
  });
});

describe("visibleDrawRanges", () => {
  const camera = { x: 0, y: 0, k: 1 };
  const viewport = fitCanvasViewport(1000, 760, 1000, 760);
  const countFor = (item: { count: number }) => item.count;
  const item = (x: number, y = 10, count = 3) => ({
    bounds: [
      [x, y],
      [x + 10, y + 10],
    ] as RenderedBoundary["bounds"],
    count,
  });

  it("coalesces adjacent visible ranges while preserving skipped buffer offsets", () => {
    expect(
      visibleDrawRanges([item(10), item(30), item(2000), item(50)], camera, countFor, viewport),
    ).toEqual([
      { start: 0, count: 6 },
      { start: 9, count: 3 },
    ]);
  });

  it("re-evaluates visibility as the camera pans without repacking buffers", () => {
    expect(
      visibleDrawRanges([item(10), item(2000)], { x: -1500, y: 0, k: 1 }, countFor, viewport),
    ).toEqual([{ start: 3, count: 3 }]);
  });

  it("keeps content visible in horizontal and vertical letterbox space", () => {
    expect(
      visibleDrawRanges([item(-100)], camera, countFor, fitCanvasViewport(1400, 760, 1000, 760)),
    ).toEqual([{ start: 0, count: 3 }]);
    expect(
      visibleDrawRanges(
        [item(10, -100)],
        camera,
        countFor,
        fitCanvasViewport(1000, 1000, 1000, 760),
      ),
    ).toEqual([{ start: 0, count: 3 }]);
  });

  it("ignores empty ranges without producing empty draw calls", () => {
    expect(visibleDrawRanges([], camera, countFor, viewport)).toEqual([]);
    expect(visibleDrawRanges([item(10, 10, 0)], camera, countFor, viewport)).toEqual([]);
  });
});
