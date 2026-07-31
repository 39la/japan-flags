import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = path.join(webRoot, "public");
const flagsDirectory = path.join(publicDirectory, "flags");
const dataDirectory = path.join(publicDirectory, "data");

const flagFiles = (await readdir(flagsDirectory))
  .filter((name) => /^\d+\.svg$/.test(name))
  .map((name) => `/flags/${name}`);
const visualManifest = JSON.parse(
  await readFile(path.join(flagsDirectory, "flag-visuals.json"), "utf8"),
);
if (visualManifest.version !== 1) {
  throw new Error("Unsupported flag visual manifest version");
}
for (const flagPath of flagFiles) {
  if (!visualManifest.visuals[flagPath]) {
    throw new Error(`Missing flag visual entry: ${flagPath}`);
  }
}

let separated = 0;
for (const [flagPath, visual] of Object.entries(visualManifest.visuals)) {
  if (visual.kind !== "separated") continue;
  separated += 1;
  if (
    !visual.motifPath ||
    !Number.isFinite(visual.motifAspectRatio) ||
    visual.motifAspectRatio <= 0
  ) {
    throw new Error(`Invalid separated visual: ${flagPath}`);
  }
  const motifFile = path.join(publicDirectory, visual.motifPath);
  await access(motifFile);
  const metadata = await sharp(motifFile, {
    limitInputPixels: false,
  }).metadata();
  if (!metadata.width || !metadata.height || metadata.format !== "svg") {
    throw new Error(`Invalid motif SVG: ${visual.motifPath}`);
  }
  if (visual.background?.kind === "asset") {
    await access(path.join(publicDirectory, visual.background.path));
  } else if (visual.background?.kind !== "solid" || !visual.background.color) {
    throw new Error(`Invalid motif background: ${flagPath}`);
  }
}
if (separated / flagFiles.length < 0.9) {
  throw new Error(`Motif separation coverage fell below 90%: ${separated}/${flagFiles.length}`);
}

const overview = JSON.parse(
  await readFile(path.join(dataDirectory, "territories-overview-l0.topojson"), "utf8"),
);
const placementByFeature = new Map();
const topologyFiles = [
  "prefectures.topojson",
  "territories-overview-l0.topojson",
  "territories-overview-l1.topojson",
  ...(await readdir(path.join(dataDirectory, "territories")))
    .filter((name) => /^\d{2}-l[123]\.topojson$/.test(name))
    .map((name) => path.join("territories", name)),
];
let placementFeatures = 0;
for (const topologyFile of topologyFiles) {
  const topology = JSON.parse(await readFile(path.join(dataDirectory, topologyFile), "utf8"));
  const geometries = Object.values(topology.objects ?? {}).flatMap(
    (object) => object.geometries ?? [],
  );
  for (const geometry of geometries) {
    const properties = geometry.properties ?? {};
    const anchor = properties.visualAnchor;
    const centroidAnchor = properties.visualCentroidAnchor;
    const optimizedAnchor = properties.visualOptimizedAnchor;
    const componentBounds = properties.visualComponentBounds;
    const radius = properties.visualSafeRadiusRatio;
    const invalidPoint = (point) =>
      !Array.isArray(point) ||
      point.length !== 2 ||
      point.some((value) => !Number.isFinite(value) || value < 0 || value > 1);
    if (
      invalidPoint(anchor) ||
      invalidPoint(centroidAnchor) ||
      invalidPoint(optimizedAnchor) ||
      !Array.isArray(componentBounds) ||
      componentBounds.length !== 4 ||
      componentBounds.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
      componentBounds[0] > componentBounds[2] ||
      componentBounds[1] > componentBounds[3] ||
      !Number.isFinite(radius) ||
      radius <= 0 ||
      radius > 1
    ) {
      throw new Error(`Invalid visual placement in ${topologyFile}`);
    }
    const featureKey = properties.jis5
      ? `municipality:${properties.jis5}`
      : `prefecture:${properties.mapPart ?? properties.prefectureCode}`;
    const signature = JSON.stringify([
      anchor,
      centroidAnchor,
      optimizedAnchor,
      componentBounds,
      radius,
    ]);
    const previous = placementByFeature.get(featureKey);
    if (previous && previous !== signature) {
      throw new Error(`Visual placement changed between LODs: ${featureKey}`);
    }
    placementByFeature.set(featureKey, signature);
    placementFeatures += 1;
  }
}
const mapCodes = new Set(
  (overview.objects?.territories?.geometries ?? [])
    .map((geometry) => geometry.properties?.jis5)
    .filter(Boolean),
);
const profileDirectory = path.join(dataDirectory, "profiles");
const profileFiles = (await readdir(profileDirectory)).filter((name) => /^\d{2}\.json$/.test(name));
const profileCodes = new Set();
let resolved = 0;
let population = 0;
let area = 0;
let jawiki = 0;
for (const profileFile of profileFiles) {
  const chunk = JSON.parse(await readFile(path.join(profileDirectory, profileFile), "utf8"));
  if (chunk.version !== 1 || !chunk.profiles) {
    throw new Error(`Invalid profile chunk: ${profileFile}`);
  }
  for (const [jis5, profile] of Object.entries(chunk.profiles)) {
    if (profileCodes.has(jis5)) {
      throw new Error(`Duplicate municipality profile: ${jis5}`);
    }
    profileCodes.add(jis5);
    if (profile.resolutionStatus === "resolved") resolved += 1;
    if (profile.population !== null) {
      if (!Number.isInteger(profile.population) || profile.population < 0) {
        throw new Error(`Invalid population: ${jis5}`);
      }
      population += 1;
    }
    if (profile.areaKm2 !== null) {
      if (!Number.isFinite(profile.areaKm2) || profile.areaKm2 < 0) {
        throw new Error(`Invalid area: ${jis5}`);
      }
      area += 1;
    }
    for (const key of ["wikidataUrl", "wikipediaUrl"]) {
      if (
        profile[key] !== null &&
        !/^https:\/\/(?:www\.)?(?:wikidata|ja\.wikipedia)\.org\//.test(profile[key])
      ) {
        throw new Error(`Invalid ${key}: ${jis5}`);
      }
    }
    if (profile.wikipediaUrl) jawiki += 1;
  }
}
for (const jis5 of mapCodes) {
  if (!profileCodes.has(jis5)) {
    throw new Error(`Missing municipality profile stub: ${jis5}`);
  }
}

console.log(
  JSON.stringify(
    {
      flags: flagFiles.length,
      separated,
      placementFeatures,
      profileChunks: profileFiles.length,
      profiles: profileCodes.size,
      resolved,
      population,
      area,
      jawiki,
    },
    null,
    2,
  ),
);
