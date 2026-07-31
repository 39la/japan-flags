import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { hasContainedVisiblePixels } from "./motif-containment.mjs";
import sharp from "sharp";
import { optimize } from "svgo";

sharp.cache({ memory: 64, files: 20, items: 100 });
sharp.concurrency(2);

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = path.join(webRoot, "public");
const flagsDirectory = path.join(publicDirectory, "flags");
const motifDirectory = path.join(flagsDirectory, "motifs");
const backgroundDirectory = path.join(flagsDirectory, "backgrounds");
const prefectureSpritesDirectory = path.join(flagsDirectory, "sprites");
const overridesPath = path.join(webRoot, "flag-visual-overrides.json");
const recheckFullOnly = process.argv.includes("--recheck-full-only");
const manifestPath = path.join(flagsDirectory, "flag-visuals.json");
const previousManifest = recheckFullOnly ? JSON.parse(await readFile(manifestPath, "utf8")) : null;

const overrides = JSON.parse(await readFile(overridesPath, "utf8"));
if (overrides.version !== 1 || !overrides.flags || !overrides.defaults) {
  throw new Error("flag-visual-overrides.json must use version 1");
}

for (const directory of [motifDirectory, backgroundDirectory, prefectureSpritesDirectory]) {
  await mkdir(directory, { recursive: true });
}
if (!recheckFullOnly) {
  for (const directory of [motifDirectory, backgroundDirectory]) {
    for (const name of await readdir(directory)) {
      if (/^\d+\.svg$/.test(name)) {
        await unlink(path.join(directory, name));
      }
    }
  }
}
for (const legacyName of ["sprites.json", "sprites.webp"]) {
  await unlink(path.join(flagsDirectory, legacyName)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

const filenames = (await readdir(flagsDirectory))
  .filter((name) => /^\d+\.svg$/.test(name))
  .sort((left, right) => Number.parseInt(left) - Number.parseInt(right));

const svgOptimization = {
  multipass: false,
  plugins: [
    "removeDoctype",
    "removeXMLProcInst",
    "removeComments",
    "removeMetadata",
    "removeEditorsNSData",
    "cleanupAttrs",
    "removeEmptyAttrs",
    "removeEmptyContainers",
    "removeUnusedNS",
    "sortAttrs",
  ],
};

function attributes(source) {
  const result = {};
  for (const match of source.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1]] = match[2] ?? match[3] ?? "";
  }
  return result;
}

function numberOrNull(value) {
  if (value === undefined || value === "") return null;
  const result = Number.parseFloat(value);
  return Number.isFinite(result) ? result : null;
}

function closeEnough(left, right) {
  return Math.abs(left - right) <= Math.max(1e-6, Math.abs(right) * 1e-6);
}

function absoluteSvgLengthOrNull(value) {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(px|pt|pc|mm|cm|in)?$/i.exec(
    value?.trim() ?? "",
  );
  if (!match) return null;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const cssPixelsPerUnit = {
    px: 1,
    pt: 96 / 72,
    pc: 16,
    mm: 96 / 25.4,
    cm: 96 / 2.54,
    in: 96,
  };
  return numeric * (cssPixelsPerUnit[match[2]?.toLowerCase() ?? "px"] ?? 1);
}

function parseViewBox(source) {
  const root = /<svg\b[^>]*>/i.exec(source);
  if (!root) return null;
  const attrs = attributes(root[0]);
  const values = attrs.viewBox
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    values &&
    values.length === 4 &&
    values.every((value) => Number.isFinite(value)) &&
    values[2] > 0 &&
    values[3] > 0
  ) {
    return {
      root,
      minX: values[0],
      minY: values[1],
      width: values[2],
      height: values[3],
    };
  }
  const width = absoluteSvgLengthOrNull(attrs.width);
  const height = absoluteSvgLengthOrNull(attrs.height);
  if (width === null || height === null) return null;
  return {
    root,
    minX: 0,
    minY: 0,
    width,
    height,
  };
}

function styleValue(style, property) {
  return style
    ?.split(";")
    .map((entry) => entry.split(":").map((value) => value.trim()))
    .find(([name]) => name === property)?.[1];
}

function solidFill(attrs) {
  const fill = attrs.fill ?? styleValue(attrs.style, "fill") ?? "black";
  const opacity = numberOrNull(attrs.opacity ?? styleValue(attrs.style, "opacity")) ?? 1;
  const fillOpacity =
    numberOrNull(attrs["fill-opacity"] ?? styleValue(attrs.style, "fill-opacity")) ?? 1;
  if (
    opacity < 0.999 ||
    fillOpacity < 0.999 ||
    /^(?:none|transparent|currentColor|inherit)$/i.test(fill) ||
    /url\s*\(|var\s*\(/i.test(fill)
  ) {
    return null;
  }
  return fill;
}

function isInsideContainer(sourcePrefix, tagName) {
  const normalized = sourcePrefix.toLowerCase();
  const tag = tagName.toLowerCase();
  return normalized.lastIndexOf(`<${tag}`) > normalized.lastIndexOf(`</${tag}>`);
}

function findAutomaticBackground(source) {
  const viewBox = parseViewBox(source);
  if (!viewBox) return null;
  const content = source.slice(viewBox.root.index + viewBox.root[0].length);
  const rectPattern = /<rect\b[^>]*(?:\/>|>\s*<\/rect>)/gi;
  let visibleElementCount = 0;
  for (const match of content.matchAll(
    /<(rect|path|circle|ellipse|polygon|polyline|line|image|text|g|use)\b[^>]*(?:\/>|>)/gi,
  )) {
    visibleElementCount += 1;
    if (visibleElementCount > 5) break;
    if (match[1].toLowerCase() !== "rect") continue;
    rectPattern.lastIndex = match.index;
    const rectMatch = rectPattern.exec(content);
    if (!rectMatch || rectMatch.index !== match.index) continue;
    const rect = rectMatch[0];
    const attrs = attributes(rect);
    const prefix = content.slice(0, match.index);
    const inNonRenderingContainer = [
      "defs",
      "clipPath",
      "mask",
      "pattern",
      "symbol",
      "marker",
    ].some((tagName) => isInsideContainer(prefix, tagName));
    const inGroup = isInsideContainer(prefix, "g");
    if (
      inNonRenderingContainer ||
      inGroup ||
      attrs.transform ||
      attrs.mask ||
      attrs.filter ||
      attrs.pattern ||
      (numberOrNull(attrs.rx) ?? 0) !== 0 ||
      (numberOrNull(attrs.ry) ?? 0) !== 0
    ) {
      continue;
    }
    const x = numberOrNull(attrs.x) ?? 0;
    const y = numberOrNull(attrs.y) ?? 0;
    const width = attrs.width === "100%" ? viewBox.width : numberOrNull(attrs.width);
    const height = attrs.height === "100%" ? viewBox.height : numberOrNull(attrs.height);
    const color = solidFill(attrs);
    if (
      width === null ||
      height === null ||
      !color ||
      !closeEnough(x, viewBox.minX) ||
      !closeEnough(y, viewBox.minY) ||
      !closeEnough(width, viewBox.width) ||
      !closeEnough(height, viewBox.height)
    ) {
      continue;
    }
    const absoluteStart = viewBox.root.index + viewBox.root[0].length + match.index;
    return {
      color,
      source: source.slice(0, absoluteStart) + source.slice(absoluteStart + rect.length),
      viewBox,
    };
  }
  return null;
}

const renderedElementNames = new Set([
  "g",
  "rect",
  "path",
  "polygon",
  "polyline",
  "circle",
  "ellipse",
  "use",
  "image",
]);
const definitionContainers = new Set(["defs", "clippath", "mask", "pattern", "symbol", "marker"]);

function parseSvgElements(source) {
  const elements = [];
  const stack = [];
  let elementStart = 0;
  try {
    const parser = new SaxesParser({ xmlns: false });
    parser.on("opentagstart", () => {
      elementStart = source.lastIndexOf("<", parser.position - 1);
    });
    parser.on("opentag", (tag) => {
      const parent = stack.at(-1) ?? null;
      const element = {
        name: tag.name.toLowerCase(),
        attributes: Object.fromEntries(
          Object.entries(tag.attributes).map(([name, value]) => [
            name.toLowerCase(),
            String(value),
          ]),
        ),
        start: elementStart,
        end: tag.isSelfClosing ? parser.position : null,
        parent,
      };
      elements.push(element);
      if (!tag.isSelfClosing) stack.push(element);
    });
    parser.on("closetag", (tag) => {
      if (tag.isSelfClosing) return;
      const element = stack.pop();
      if (!element || element.name !== tag.name.toLowerCase()) {
        throw new Error("Unbalanced SVG element stack");
      }
      element.end = parser.position;
    });
    parser.write(source).close();
  } catch {
    return null;
  }
  return elements.every((element) => element.end !== null) ? elements : null;
}

function hasDefinitionAncestor(element) {
  for (let current = element.parent; current; current = current.parent) {
    if (definitionContainers.has(current.name)) return true;
  }
  return false;
}

function containsElement(parent, child) {
  return parent.start <= child.start && parent.end >= child.end;
}

function usesUnsupportedBackgroundEffect(element, elements) {
  const related = elements.filter((candidate) => containsElement(element, candidate));
  for (let current = element.parent; current; current = current.parent) {
    related.push(current);
  }
  return related.some((node) => {
    if (node.attributes.mask || node.attributes.filter) return true;
    return ["fill", "stroke", "style"].some((attribute) =>
      /url\s*\(/i.test(node.attributes[attribute] ?? ""),
    );
  });
}

function removeRanges(source, ranges) {
  let result = source;
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, range.start) + result.slice(range.end);
  }
  return result;
}

function isolateCandidate(source, elements, candidate) {
  const removals = [];
  for (const element of elements) {
    if (!renderedElementNames.has(element.name)) continue;
    if (
      hasDefinitionAncestor(element) ||
      containsElement(element, candidate) ||
      containsElement(candidate, element) ||
      removals.some((removed) => containsElement(removed, element))
    ) {
      continue;
    }
    removals.push(element);
  }
  return removeRanges(source, removals);
}

function removeCandidate(source, candidate) {
  return source.slice(0, candidate.start) + source.slice(candidate.end);
}

async function renderAnalysisRaster(source, viewBox, maxDimension = 96) {
  const ratio = viewBox.width / viewBox.height;
  const width = ratio >= 1 ? maxDimension : Math.max(1, Math.round(maxDimension * ratio));
  const height = ratio >= 1 ? Math.max(1, Math.round(maxDimension / ratio)) : maxDimension;
  const renderSource = setRootRenderSize(source, viewBox, width, height);
  const { data, info } = await sharp(Buffer.from(renderSource), {
    density: 72,
    limitInputPixels: false,
  })
    .resize({ width, height, fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function analyzeSolidCoverage(raster) {
  const pixelCount = raster.width * raster.height;
  let covered = 0;
  let colorSamples = 0;
  let redMin = 255;
  let redMax = 0;
  let greenMin = 255;
  let greenMax = 0;
  let blueMin = 255;
  let blueMax = 0;
  let redSum = 0;
  let greenSum = 0;
  let blueSum = 0;
  for (let offset = 0; offset < raster.data.length; offset += 4) {
    const alpha = raster.data[offset + 3];
    if (alpha >= 16) covered += 1;
    if (alpha < 128) continue;
    const red = raster.data[offset];
    const green = raster.data[offset + 1];
    const blue = raster.data[offset + 2];
    colorSamples += 1;
    redMin = Math.min(redMin, red);
    redMax = Math.max(redMax, red);
    greenMin = Math.min(greenMin, green);
    greenMax = Math.max(greenMax, green);
    blueMin = Math.min(blueMin, blue);
    blueMax = Math.max(blueMax, blue);
    redSum += red;
    greenSum += green;
    blueSum += blue;
  }
  if (
    covered / pixelCount < 0.995 ||
    colorSamples === 0 ||
    redMax - redMin > 3 ||
    greenMax - greenMin > 3 ||
    blueMax - blueMin > 3
  ) {
    return null;
  }
  const channel = (sum) =>
    Math.round(sum / colorSamples)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(redSum)}${channel(greenSum)}${channel(blueSum)}`;
}

async function findRenderedBackground(source) {
  const viewBox = parseViewBox(source);
  if (!viewBox) return null;
  const elements = parseSvgElements(source);
  if (!elements) return null;
  const candidates = elements
    .filter(
      (element) =>
        renderedElementNames.has(element.name) &&
        !hasDefinitionAncestor(element) &&
        !usesUnsupportedBackgroundEffect(element, elements),
    )
    .slice(0, 8);
  for (const candidate of candidates) {
    try {
      const isolatedSource = isolateCandidate(source, elements, candidate);
      const color = analyzeSolidCoverage(await renderAnalysisRaster(isolatedSource, viewBox));
      if (!color) continue;
      const motifSource = removeCandidate(source, candidate);
      const motifRaster = await renderAnalysisRaster(motifSource, viewBox);
      const contained = hasContainedVisiblePixels(motifRaster);
      if (!contained) {
        continue;
      }
      return { color, source: motifSource, viewBox };
    } catch {
      // A candidate with unresolved references is not a safe background.
    }
  }
  return null;
}

function replaceRootViewport(source, viewBox) {
  return source.replace(/<svg\b[^>]*>/i, (root) => {
    const withoutDimensions = root
      .replace(/\sviewBox\s*=\s*(?:"[^"]*"|'[^']*')/i, "")
      .replace(/\swidth\s*=\s*(?:"[^"]*"|'[^']*')/i, "")
      .replace(/\sheight\s*=\s*(?:"[^"]*"|'[^']*')/i, "");
    return withoutDimensions.replace(
      />$/,
      ` viewBox="${viewBox.join(" ")}" width="${viewBox[2]}" height="${viewBox[3]}">`,
    );
  });
}

function setRootRenderSize(source, viewBox, width, height) {
  return source.replace(/<svg\b[^>]*>/i, (root) => {
    const withoutViewport = root
      .replace(/\sviewBox\s*=\s*(?:"[^"]*"|'[^']*')/i, "")
      .replace(/\swidth\s*=\s*(?:"[^"]*"|'[^']*')/i, "")
      .replace(/\sheight\s*=\s*(?:"[^"]*"|'[^']*')/i, "");
    return withoutViewport.replace(
      />$/,
      ` viewBox="${viewBox.minX} ${viewBox.minY} ${viewBox.width} ${viewBox.height}" width="${width}" height="${height}">`,
    );
  });
}

async function cropMotifSvg(source, originalViewBox) {
  const optimized = optimize(source, svgOptimization).data;
  const ratio = originalViewBox.width / originalViewBox.height;
  const renderWidth = ratio >= 1 ? 1024 : Math.max(1, Math.round(1024 * ratio));
  const renderHeight = ratio >= 1 ? Math.max(1, Math.round(1024 / ratio)) : 1024;
  // Materialize the resized raster before trimming. libvips reports trim
  // offsets in the input raster's coordinate space; doing both operations in
  // one pipeline leaves the offsets scaled to the SVG density rather than to
  // renderWidth/renderHeight.
  const renderSource = setRootRenderSize(optimized, originalViewBox, renderWidth, renderHeight);
  const rendered = await sharp(Buffer.from(renderSource), {
    density: 72,
    limitInputPixels: false,
  })
    .resize({ width: renderWidth, height: renderHeight, fit: "fill" })
    .png()
    .toBuffer();
  const { info } = await sharp(rendered)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) {
    throw new Error("Generated motif is empty");
  }
  const trimLeft = -(info.trimOffsetLeft ?? 0);
  const trimTop = -(info.trimOffsetTop ?? 0);
  const left = Math.max(0, trimLeft - 1);
  const top = Math.max(0, trimTop - 1);
  const right = Math.min(renderWidth, trimLeft + info.width + 1);
  const bottom = Math.min(renderHeight, trimTop + info.height + 1);
  const croppedViewBox = [
    originalViewBox.minX + (left / renderWidth) * originalViewBox.width,
    originalViewBox.minY + (top / renderHeight) * originalViewBox.height,
    ((right - left) / renderWidth) * originalViewBox.width,
    ((bottom - top) / renderHeight) * originalViewBox.height,
  ].map((value) => Number(value.toFixed(6)));
  const cropped = optimize(replaceRootViewport(optimized, croppedViewBox), svgOptimization).data;
  const validationWidth =
    croppedViewBox[2] >= croppedViewBox[3]
      ? 256
      : Math.max(1, Math.round((256 * croppedViewBox[2]) / croppedViewBox[3]));
  const validationHeight =
    croppedViewBox[2] >= croppedViewBox[3]
      ? Math.max(1, Math.round((256 * croppedViewBox[3]) / croppedViewBox[2]))
      : 256;
  const validationSource = setRootRenderSize(
    cropped,
    {
      minX: croppedViewBox[0],
      minY: croppedViewBox[1],
      width: croppedViewBox[2],
      height: croppedViewBox[3],
    },
    validationWidth,
    validationHeight,
  );
  const validation = sharp(Buffer.from(validationSource), {
    density: 72,
    limitInputPixels: false,
  }).ensureAlpha();
  const stats = await validation.stats();
  if ((stats.channels[3]?.max ?? 0) === 0) {
    throw new Error("Generated motif has no visible pixels");
  }
  return {
    source: cropped,
    aspectRatio: croppedViewBox[2] / croppedViewBox[3],
  };
}

async function readManualSvg(relativePath) {
  const sourcePath = path.resolve(webRoot, relativePath);
  const source = optimize(await readFile(sourcePath, "utf8"), svgOptimization).data;
  const metadata = await sharp(Buffer.from(source), {
    density: 144,
    limitInputPixels: false,
  }).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Manual SVG has no dimensions: ${relativePath}`);
  }
  return {
    source,
    aspectRatio: metadata.width / metadata.height,
  };
}

const resources = new Map();
const visuals = {};
let sourceBytes = 0;
let optimizedBytes = 0;
let separatedCount = 0;

for (const filename of filenames) {
  const pageId = filename.replace(/\.svg$/, "");
  const fullPath = `/flags/${filename}`;
  const inputPath = path.join(flagsDirectory, filename);
  const source = await readFile(inputPath, "utf8");
  const optimized = optimize(source, {
    ...svgOptimization,
    path: inputPath,
  }).data;
  sourceBytes += Buffer.byteLength(source);
  optimizedBytes += Buffer.byteLength(optimized);
  if (optimized !== source) await writeFile(inputPath, optimized);
  resources.set(fullPath, Buffer.from(optimized));

  const previousVisual = previousManifest?.visuals?.[fullPath];
  if (previousVisual?.kind === "separated") {
    const previousMotifPath = path.join(
      publicDirectory,
      previousVisual.motifPath.replace(/^\//, ""),
    );
    const previousMotif = await readFile(previousMotifPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (previousMotif) {
      resources.set(previousVisual.motifPath, previousMotif);
      visuals[fullPath] = previousVisual;
      separatedCount += 1;
      continue;
    }
  }

  const override = overrides.flags[pageId] ?? {};
  const placement = override.placement;
  if (override.separation === "disabled") {
    visuals[fullPath] = {
      kind: "full",
      fullPath,
      provenance: "override",
      ...(placement ? { placement } : {}),
    };
    continue;
  }

  let motif;
  let background;
  let provenance = "auto";
  if (override.separation === "manual") {
    if (!override.motifSource) {
      throw new Error(`Manual motifSource is missing for ${pageId}`);
    }
    motif = await readManualSvg(override.motifSource);
    if (override.backgroundSource) {
      const manualBackground = await readManualSvg(override.backgroundSource);
      const backgroundPath = `/flags/backgrounds/${filename}`;
      await writeFile(path.join(backgroundDirectory, filename), manualBackground.source);
      background = { kind: "asset", path: backgroundPath };
    } else if (override.backgroundColor) {
      background = { kind: "solid", color: override.backgroundColor };
    } else {
      throw new Error(`Manual background is missing for ${pageId}`);
    }
    provenance = "override";
  } else {
    const automatic = findAutomaticBackground(source) ?? (await findRenderedBackground(source));
    if (automatic) {
      try {
        motif = await cropMotifSvg(automatic.source, automatic.viewBox);
      } catch (error) {
        throw new Error(`Automatic motif generation failed for ${pageId}`, {
          cause: error,
        });
      }
      background = {
        kind: "solid",
        color: override.backgroundColor ?? automatic.color,
      };
      if (override.backgroundColor || placement) provenance = "override";
    }
  }

  if (!motif || !background) {
    visuals[fullPath] = {
      kind: "full",
      fullPath,
      provenance: override.separation ? "override" : "fallback",
      ...(placement ? { placement } : {}),
    };
    continue;
  }
  const motifPath = `/flags/motifs/${filename}`;
  await writeFile(path.join(motifDirectory, filename), motif.source);
  resources.set(motifPath, Buffer.from(motif.source));
  visuals[fullPath] = {
    kind: "separated",
    fullPath,
    motifPath,
    motifAspectRatio: motif.aspectRatio,
    background,
    provenance,
    ...(placement ? { placement } : {}),
  };
  separatedCount += 1;
}

await writeFile(
  path.join(flagsDirectory, "flag-visuals.json"),
  `${JSON.stringify({ version: 1, visuals })}\n`,
);

async function buildAtlas({
  resourcePaths,
  cellWidth,
  cellHeight,
  columns,
  imagePath,
  imageUrl,
  manifestPath,
}) {
  const rows = Math.ceil(resourcePaths.length / columns);
  const atlasWidth = columns * cellWidth;
  const atlasHeight = rows * cellHeight;
  const composites = [];
  const sprites = {};

  for (let index = 0; index < resourcePaths.length; index += 1) {
    const resourcePath = resourcePaths[index];
    const input = resources.get(resourcePath);
    if (!input) throw new Error(`Missing atlas resource: ${resourcePath}`);
    const inputSource = input.toString("utf8");
    const inputViewBox = parseViewBox(inputSource);
    const scale = inputViewBox
      ? Math.min(cellWidth / inputViewBox.width, cellHeight / inputViewBox.height)
      : 1;
    const renderInput = inputViewBox
      ? Buffer.from(
          setRootRenderSize(
            inputSource,
            inputViewBox,
            Math.max(1, Math.round(inputViewBox.width * scale)),
            Math.max(1, Math.round(inputViewBox.height * scale)),
          ),
        )
      : input;
    const { data, info } = await sharp(renderInput, {
      density: 72,
      limitInputPixels: false,
    })
      .resize({
        width: cellWidth,
        height: cellHeight,
        fit: "inside",
        withoutEnlargement: false,
      })
      .png()
      .toBuffer({ resolveWithObject: true });
    const cellX = (index % columns) * cellWidth;
    const cellY = Math.floor(index / columns) * cellHeight;
    const x = cellX + Math.floor((cellWidth - info.width) / 2);
    const y = cellY + Math.floor((cellHeight - info.height) / 2);
    composites.push({ input: data, left: x, top: y });
    sprites[resourcePath] = { x, y, width: info.width, height: info.height };
  }

  await sharp({
    create: {
      width: atlasWidth,
      height: atlasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .webp({ lossless: true, effort: 6 })
    .toFile(imagePath);

  await writeFile(
    manifestPath,
    `${JSON.stringify({
      version: 3,
      image: imageUrl,
      width: atlasWidth,
      height: atlasHeight,
      cellWidth,
      cellHeight,
      count: resourcePaths.length,
      sprites,
    })}\n`,
  );
  return { width: atlasWidth, height: atlasHeight };
}

const globalResourcePaths = [...resources.keys()].sort();
const globalAtlas = await buildAtlas({
  resourcePaths: globalResourcePaths,
  cellWidth: 32,
  cellHeight: 24,
  columns: 64,
  imagePath: path.join(flagsDirectory, "sprites-global-32.webp"),
  imageUrl: "/flags/sprites-global-32.webp",
  manifestPath: path.join(flagsDirectory, "sprites-global-32.json"),
});

const overviewCandidates = [
  path.join(publicDirectory, "data", "territories-overview-l0.topojson"),
  path.join(publicDirectory, "data", "territories-overview.topojson"),
];
let overview;
for (const candidate of overviewCandidates) {
  try {
    overview = JSON.parse(await readFile(candidate, "utf8"));
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
if (!overview) throw new Error("Municipality overview TopoJSON is missing");

const pathsByPrefecture = new Map();
const geometries = overview.objects?.territories?.geometries ?? [];
for (const geometry of geometries) {
  const code = String(geometry.properties?.prefectureCode ?? "");
  const fullPath = String(geometry.properties?.flagPath ?? "");
  if (!code || !resources.has(fullPath)) continue;
  if (!pathsByPrefecture.has(code)) pathsByPrefecture.set(code, new Set());
  const paths = pathsByPrefecture.get(code);
  paths.add(fullPath);
  const visual = visuals[fullPath];
  if (visual?.kind === "separated") paths.add(visual.motifPath);
}

let prefectureAtlasCount = 0;
for (const [code, paths] of [...pathsByPrefecture].sort()) {
  const resourcePaths = [...paths].sort();
  if (!resourcePaths.length) continue;
  const columns = Math.min(8, Math.ceil(Math.sqrt(resourcePaths.length)));
  await buildAtlas({
    resourcePaths,
    cellWidth: 64,
    cellHeight: 48,
    columns,
    imagePath: path.join(prefectureSpritesDirectory, `${code}-64.webp`),
    imageUrl: `/flags/sprites/${code}-64.webp`,
    manifestPath: path.join(prefectureSpritesDirectory, `${code}-64.json`),
  });
  prefectureAtlasCount += 1;
}

console.log(`Built global flag atlas: ${globalAtlas.width}x${globalAtlas.height}`);
console.log(`Built ${prefectureAtlasCount} prefecture flag atlases at 64px`);
console.log(`Separated ${separatedCount}/${filenames.length} flag motifs`);
console.log(`Optimized SVGs: ${sourceBytes} -> ${optimizedBytes} bytes`);
