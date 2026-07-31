import { readFile, readdir, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = path.join(webRoot, "public");
const dataDirectory = path.join(publicDirectory, "data");
const flagsDirectory = path.join(publicDirectory, "flags");

async function topologyMetrics(filePath) {
  const source = await readFile(filePath);
  const topology = JSON.parse(source);
  return {
    files: 1,
    arcs: topology.arcs?.length ?? 0,
    points: (topology.arcs ?? []).reduce((sum, arc) => sum + arc.length, 0),
    rawBytes: source.byteLength,
    gzipBytes: gzipSync(source).byteLength,
  };
}

function sumMetrics(metrics) {
  return metrics.reduce(
    (total, item) => ({
      files: total.files + item.files,
      arcs: total.arcs + item.arcs,
      points: total.points + item.points,
      rawBytes: total.rawBytes + item.rawBytes,
      gzipBytes: total.gzipBytes + item.gzipBytes,
    }),
    { files: 0, arcs: 0, points: 0, rawBytes: 0, gzipBytes: 0 },
  );
}

const geometry = {};
geometry.prefecture = await topologyMetrics(path.join(dataDirectory, "prefectures.topojson"));
for (const lod of ["l0", "l1"]) {
  geometry[`overview-${lod}`] = await topologyMetrics(
    path.join(dataDirectory, `territories-overview-${lod}.topojson`),
  );
}
const chunkNames = await readdir(path.join(dataDirectory, "territories"));
for (const lod of ["l1", "l2", "l3"]) {
  const names = chunkNames.filter((name) => name.endsWith(`-${lod}.topojson`));
  geometry[`detail-${lod}`] = sumMetrics(
    await Promise.all(
      names.map((name) => topologyMetrics(path.join(dataDirectory, "territories", name))),
    ),
  );
}

async function atlasMetrics(manifestPath) {
  const manifestSource = await readFile(manifestPath);
  const manifest = JSON.parse(manifestSource);
  const imagePath = path.join(publicDirectory, manifest.image.replace(/^\//, ""));
  return {
    atlases: 1,
    flags: manifest.count,
    encodedBytes: (await stat(imagePath)).size,
    decodedBytes: manifest.width * manifest.height * 4,
  };
}

const globalAtlas = await atlasMetrics(path.join(flagsDirectory, "sprites-global-32.json"));
const prefectureManifestNames = (await readdir(path.join(flagsDirectory, "sprites"))).filter(
  (name) => name.endsWith("-64.json"),
);
const prefectureAtlases = (
  await Promise.all(
    prefectureManifestNames.map((name) => atlasMetrics(path.join(flagsDirectory, "sprites", name))),
  )
).reduce(
  (total, atlas) => ({
    atlases: total.atlases + atlas.atlases,
    flags: total.flags + atlas.flags,
    encodedBytes: total.encodedBytes + atlas.encodedBytes,
    decodedBytes: total.decodedBytes + atlas.decodedBytes,
  }),
  { atlases: 0, flags: 0, encodedBytes: 0, decodedBytes: 0 },
);

console.log(
  JSON.stringify(
    {
      geometry,
      atlases: {
        global32: globalAtlas,
        allPrefecture64: prefectureAtlases,
      },
    },
    null,
    2,
  ),
);
