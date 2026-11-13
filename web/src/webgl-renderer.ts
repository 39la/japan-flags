import { fitCanvasViewport, type FittedViewport } from "./canvas-viewport";
import type { RenderedBoundary, RenderedBoundaryChunk, WebGLMeshChunk } from "./map-geometry";
import { MAP_HEIGHT, MAP_WIDTH } from "./map-model";
import { isVisible, type PlannedFeature } from "./render-plan";
import type { ViewTransform } from "./types";

type WebGLSceneFeature = Pick<PlannedFeature, "item" | "hasFlag" | "visual" | "motifPlacement">;

type WebGLSceneInput = {
  features: WebGLSceneFeature[];
  boundaries: RenderedBoundary[];
};

type WebGLScene = {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  linePositions: Float32Array;
};

export type WebGLMapRenderer = {
  maxSize: number;
  setScene: (features: WebGLSceneFeature[], boundaries: RenderedBoundary[]) => void;
  draw: (camera: ViewTransform, viewport?: FittedViewport) => void;
  dispose: () => void;
};

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec4 a_color;
uniform vec4 u_viewport;
uniform vec2 u_offset;
uniform vec4 u_camera;
out vec4 v_color;

void main() {
  vec2 content = (a_position * u_camera.z) + u_camera.xy;
  vec2 pixels = content * u_viewport.x + u_offset;
  vec2 clip = vec2(
    pixels.x / u_viewport.y * 2.0 - 1.0,
    1.0 - pixels.y / u_viewport.z * 2.0
  );
  gl_Position = vec4(clip, 0.0, 1.0);
  v_color = a_color;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 v_color;
out vec4 outColor;

void main() {
  outColor = v_color;
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Unknown shader error";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function parseColor(value: string) {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return [0.929, 0.941, 0.949, 1];
  const number = Number.parseInt(match[1], 16);
  return [((number >> 16) & 0xff) / 255, ((number >> 8) & 0xff) / 255, (number & 0xff) / 255, 1];
}

function featureColor(feature: WebGLSceneFeature) {
  const background =
    feature.visual?.kind === "separated" && feature.motifPlacement
      ? feature.visual.background
      : null;
  if (background?.kind === "solid") return background.color;
  return feature.hasFlag ? "#ffffff" : "#edf0f2";
}

export function combineScene(
  features: WebGLSceneFeature[],
  boundaries: RenderedBoundary[],
): WebGLScene {
  let vertexCount = 0;
  let indexCount = 0;
  for (const { item } of features) {
    if (!item.webglMesh) continue;
    vertexCount += item.webglMesh.vertices.length / 2;
    indexCount += item.webglMesh.indices.length;
  }
  const positions = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 4);
  const indices = new Uint32Array(indexCount);
  const linePositions = new Float32Array(
    boundaries.reduce((count, boundary) => count + (boundary.webglLines?.length ?? 0), 0),
  );
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const feature of features) {
    const mesh = feature.item.webglMesh;
    if (!mesh) continue;
    positions.set(mesh.vertices, vertexOffset * 2);
    const color = parseColor(featureColor(feature));
    for (let index = 0; index < mesh.vertices.length / 2; index += 1) {
      colors.set(color, (vertexOffset + index) * 4);
    }
    for (const index of mesh.indices) indices[indexOffset++] = vertexOffset + index;
    vertexOffset += mesh.vertices.length / 2;
  }
  let lineOffset = 0;
  for (const { webglLines } of boundaries) {
    if (!webglLines) continue;
    linePositions.set(webglLines, lineOffset);
    lineOffset += webglLines.length;
  }
  return { positions, colors, indices, linePositions };
}

export function sameSceneInput(previous: WebGLSceneInput | null, current: WebGLSceneInput) {
  return (
    previous !== null &&
    previous.features.length === current.features.length &&
    previous.boundaries.length === current.boundaries.length &&
    previous.features.every(
      (feature, index) =>
        feature.item === current.features[index].item &&
        featureColor(feature) === featureColor(current.features[index]),
    ) &&
    previous.boundaries.every((boundary, index) => boundary === current.boundaries[index])
  );
}

export function visibleDrawRanges<T extends Pick<RenderedBoundary, "bounds">>(
  items: T[],
  camera: ViewTransform,
  countFor: (item: T) => number,
  viewport: FittedViewport,
) {
  const marginX = (viewport.offsetX + 1) / viewport.scale;
  const marginY = (viewport.offsetY + 1) / viewport.scale;
  const ranges: Array<{ start: number; count: number }> = [];
  let offset = 0;
  for (const item of items) {
    const count = countFor(item);
    if (count && isVisible(item.bounds, camera, marginX, marginY)) {
      const previous = ranges.at(-1);
      if (previous && previous.start + previous.count === offset) {
        previous.count += count;
      } else {
        ranges.push({ start: offset, count });
      }
    }
    offset += count;
  }
  return ranges;
}

function createProgram(gl: WebGL2RenderingContext) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create WebGL program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "Unknown program error";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

export function createWebGLMapRenderer(canvas: HTMLCanvasElement): WebGLMapRenderer | null {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: true });
  if (!gl) return null;
  try {
    const program = createProgram(gl);
    const positionBuffer = gl.createBuffer();
    const colorBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();
    const lineBuffer = gl.createBuffer();
    if (!positionBuffer || !colorBuffer || !indexBuffer || !lineBuffer)
      throw new Error("Unable to create WebGL buffers");
    const positionLocation = gl.getAttribLocation(program, "a_position");
    const colorLocation = gl.getAttribLocation(program, "a_color");
    const viewportLocation = gl.getUniformLocation(program, "u_viewport");
    const offsetLocation = gl.getUniformLocation(program, "u_offset");
    const cameraLocation = gl.getUniformLocation(program, "u_camera");
    let currentScene:
      | (WebGLSceneInput & { fillChunks: WebGLMeshChunk[]; lineChunks: RenderedBoundaryChunk[] })
      | null = null;

    return {
      maxSize: Math.min(
        gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
        gl.getParameter(gl.MAX_TEXTURE_SIZE),
        ...gl.getParameter(gl.MAX_VIEWPORT_DIMS),
      ),
      setScene: (features, boundaries) => {
        const input = { features, boundaries };
        if (sameSceneInput(currentScene, input)) return;
        const scene = combineScene(features, boundaries);
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, scene.positions, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, scene.colors, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, scene.indices, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, scene.linePositions, gl.STATIC_DRAW);
        currentScene = {
          ...input,
          fillChunks: features.flatMap(({ item }) => item.webglMesh?.chunks ?? []),
          lineChunks: boundaries.flatMap((boundary) => boundary.chunks),
        };
      },
      draw: (camera, cachedViewport) => {
        if (!currentScene) return;
        const width = Math.max(1, canvas.width);
        const height = Math.max(1, canvas.height);
        const viewport = cachedViewport ?? fitCanvasViewport(width, height, MAP_WIDTH, MAP_HEIGHT);
        gl.viewport(0, 0, width, height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(program);
        gl.uniform4f(cameraLocation, camera.x, camera.y, camera.k, 0);
        gl.uniform4f(viewportLocation, viewport.scale, width, height, 0);
        gl.uniform2f(offsetLocation, viewport.offsetX, viewport.offsetY);
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
        gl.enableVertexAttribArray(colorLocation);
        gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        for (const { start, count } of visibleDrawRanges(
          currentScene.fillChunks,
          camera,
          (chunk) => chunk.indexCount,
          viewport,
        )) {
          gl.drawElements(
            gl.TRIANGLES,
            count,
            gl.UNSIGNED_INT,
            start * Uint32Array.BYTES_PER_ELEMENT,
          );
        }
        if (currentScene.boundaries.length) {
          gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
          gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
          gl.disableVertexAttribArray(colorLocation);
          gl.vertexAttrib4f(colorLocation, 0.682, 0.714, 0.737, 1);
          for (const { start, count } of visibleDrawRanges(
            currentScene.lineChunks,
            camera,
            (chunk) => chunk.vertexCount,
            viewport,
          )) {
            gl.drawArrays(gl.LINES, start, count);
          }
          gl.enableVertexAttribArray(colorLocation);
        }
      },
      dispose: () => {
        gl.deleteBuffer(positionBuffer);
        gl.deleteBuffer(colorBuffer);
        gl.deleteBuffer(indexBuffer);
        gl.deleteBuffer(lineBuffer);
        gl.deleteProgram(program);
      },
    };
  } catch {
    return null;
  }
}
