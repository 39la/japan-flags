import { fitCanvasViewport } from "./canvas-viewport";
import type { RenderedBoundary } from "./map-geometry";
import { MAP_HEIGHT, MAP_WIDTH } from "./map-model";
import type { PlannedFeature } from "./render-plan";
import type { ViewTransform } from "./types";

type WebGLSceneFeature = Pick<PlannedFeature, "item" | "hasFlag" | "visual" | "motifPlacement">;

type WebGLScene = {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  linePositions: Float32Array;
};

export type WebGLMapRenderer = {
  setScene: (features: WebGLSceneFeature[], boundaries: RenderedBoundary[]) => void;
  draw: (camera: ViewTransform) => void;
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
  if (background?.kind === "solid") return parseColor(background.color);
  return parseColor(feature.hasFlag ? "#ffffff" : "#edf0f2");
}

function combineScene(features: WebGLSceneFeature[], boundaries: RenderedBoundary[]): WebGLScene {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const linePositions: number[] = [];
  for (const feature of features) {
    const mesh = feature.item.webglMesh;
    if (!mesh) continue;
    const vertexOffset = positions.length / 2;
    const color = featureColor(feature);
    positions.push(...mesh.vertices);
    for (let index = 0; index < mesh.vertices.length / 2; index += 1) colors.push(...color);
    for (const index of mesh.indices) indices.push(vertexOffset + index);
  }
  for (const boundary of boundaries) {
    if (boundary.webglLines) linePositions.push(...boundary.webglLines);
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    linePositions: new Float32Array(linePositions),
  };
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
    let scene: WebGLScene = {
      positions: new Float32Array(),
      colors: new Float32Array(),
      indices: new Uint32Array(),
      linePositions: new Float32Array(),
    };

    return {
      setScene: (features, boundaries) => {
        scene = combineScene(features, boundaries);
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, scene.positions, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, scene.colors, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, scene.indices, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, scene.linePositions, gl.STATIC_DRAW);
      },
      draw: (camera) => {
        const width = Math.max(1, canvas.width);
        const height = Math.max(1, canvas.height);
        const viewport = fitCanvasViewport(width, height, MAP_WIDTH, MAP_HEIGHT);
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
        if (scene.indices.length)
          gl.drawElements(gl.TRIANGLES, scene.indices.length, gl.UNSIGNED_INT, 0);
        if (scene.linePositions.length) {
          gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
          gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
          gl.disableVertexAttribArray(colorLocation);
          gl.vertexAttrib4f(colorLocation, 0.682, 0.714, 0.737, 1);
          gl.drawArrays(gl.LINES, 0, scene.linePositions.length / 2);
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
