import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIRECTORY = join(WEB_ROOT, "dist");
const MAX_STATIC_ASSET_FILES = 20_000;
const MAX_STATIC_ASSET_BYTES = 25 * 1024 * 1024;

type FileInfo = {
  path: string;
  bytes: number;
};

async function filesUnder(directory: string) {
  const files: FileInfo[] = [];
  const visit = async (current: string) => {
    for await (const entry of Deno.readDir(current)) {
      const path = join(current, entry.name);
      if (entry.isDirectory) await visit(path);
      else if (entry.isFile) {
        files.push({ path: relative(directory, path), bytes: (await Deno.stat(path)).size });
      }
    }
  };
  await visit(directory);
  return files;
}

async function main() {
  const files = await filesUnder(DIST_DIRECTORY).catch((error: unknown) => {
    throw new Error(`web/dist is unavailable; run the production build first.\n${error}`);
  });
  const requiredFiles = ["index.html", "_headers"];
  for (const required of requiredFiles) {
    if (!files.some((file) => file.path === required)) {
      throw new Error(`Required deployment asset is missing: ${required}`);
    }
  }
  const oversized = files.filter((file) => file.bytes > MAX_STATIC_ASSET_BYTES);
  const empty = files.filter((file) => file.bytes === 0);
  if (files.length > MAX_STATIC_ASSET_FILES) {
    throw new Error(
      `Static asset count ${files.length} exceeds the Workers Free limit ${MAX_STATIC_ASSET_FILES}`,
    );
  }
  if (oversized.length) {
    throw new Error(
      `Static assets exceed 25 MiB:\n${oversized.map((file) => `${file.path}: ${file.bytes}`).join("\n")}`,
    );
  }
  if (empty.length) {
    throw new Error(`Empty deployment assets:\n${empty.map((file) => file.path).join("\n")}`);
  }
  const largest = [...files].sort((left, right) => right.bytes - left.bytes).slice(0, 5);
  console.log(
    JSON.stringify(
      {
        directory: DIST_DIRECTORY,
        files: files.length,
        bytes: files.reduce((total, file) => total + file.bytes, 0),
        largest,
        limits: {
          files: MAX_STATIC_ASSET_FILES,
          individualFileBytes: MAX_STATIC_ASSET_BYTES,
        },
      },
      null,
      2,
    ),
  );
}

await main();
