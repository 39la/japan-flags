import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = join(WEB_ROOT, "bench", "pixi", "public", "maps");
const SVG_PATH = join(OUTPUT_DIR, "japan-basemap.svg");
const META_PATH = join(OUTPUT_DIR, "japan-basemap.json");

const WIDTH = 4000;
const HEIGHT = 3040;
const FIT_MODE = "cover";
const FILL = 0.96;
const LAYER = "municipality";
const TIMEOUT_MS = 120_000;

function integer(value: string, name: string, minimum: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseOptions(args: string[]) {
  let force = false;
  let baseUrl: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      console.log(`Usage: deno run -A web/scripts/bake-basemap.ts [options]

  --force          re-bake even if the SVG already exists
  --base-url URL   reuse an already-running preview server
`);
      Deno.exit(0);
    } else if (argument === "--force") {
      force = true;
    } else if (argument === "--width") {
      integer(args[++index] ?? "", argument, 320);
    } else if (argument === "--height") {
      integer(args[++index] ?? "", argument, 240);
    } else if (argument === "--base-url") {
      baseUrl = (args[++index] ?? "").replace(/\/$/, "");
      if (!baseUrl) throw new Error("--base-url requires a value");
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return { force, baseUrl };
}

async function waitForServer(baseUrl: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Vite preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Preview server did not start: ${baseUrl}`);
}

async function main() {
  const { force, baseUrl: externalBaseUrl } = parseOptions(Deno.args);
  const snapshotDate = Deno.env.get("snapshot_date") ?? "20260101";

  if (!force) {
    try {
      const stat = await Deno.stat(SVG_PATH);
      if (stat.isFile) {
        const existing = JSON.parse(await Deno.readTextFile(META_PATH));
        if (existing.snapshotDate === snapshotDate) {
          console.log(JSON.stringify({
            status: "skipped",
            reason: "up-to-date",
            svg: SVG_PATH,
            snapshotDate,
          }));
          return;
        }
      }
    } catch {
      // Fall through to bake.
    }
  }

  await Deno.mkdir(OUTPUT_DIR, { recursive: true });

  const port = 41_000 + Math.floor(Math.random() * 1_000);
  const baseUrl = externalBaseUrl ?? `http://127.0.0.1:${port}`;
  const server = externalBaseUrl
    ? null
    : new Deno.Command(Deno.execPath(), {
      args: ["task", "preview", "--host", "127.0.0.1", "--port", String(port)],
      cwd: WEB_ROOT,
      stdout: "null",
      stderr: "inherit",
    }).spawn();

  try {
    await waitForServer(baseUrl);

    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      throw new Error(
        `Chromiumを起動できません。先に mise run render:install-browser を実行してください。\n${error}`,
      );
    }
    try {
      const page = await browser.newPage({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: 1,
      });
      page.on("pageerror", (error) => console.error(`[page] ${error.message}`));
      const parameters = new URLSearchParams({
        mapExport: "1",
        layer: LAYER,
        fitMode: FIT_MODE,
        fill: String(FILL),
      });
      const url = `${baseUrl}/?${parameters}`;
      console.error(`[bake] ${url}`);
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUT_MS,
      });
      const map = page.locator('.map-shell[data-export-ready="true"]');
      await map.waitFor({ state: "visible", timeout: TIMEOUT_MS });
      await page.evaluate("document.fonts.ready");
      const source = await page.evaluate(
        async (dimensions) => {
          const render = (
            globalThis as unknown as {
              __renderMapExportSvg?: (value: {
                width: number;
                height: number;
              }) => Promise<string>;
            }
          ).__renderMapExportSvg;
          if (!render) throw new Error("SVG export backend is unavailable");
          return render(dimensions);
        },
        { width: WIDTH, height: HEIGHT },
      );
      const bytes = new TextEncoder().encode(source);
      await Deno.writeFile(SVG_PATH, bytes);
      const meta = {
        snapshotDate,
        generatedAt: new Date().toISOString(),
        sourceQuery: `?${parameters}`,
        layer: LAYER,
        fitMode: FIT_MODE,
        fill: FILL,
        width: WIDTH,
        height: HEIGHT,
        bytes: bytes.byteLength,
        svg: "japan-basemap.svg",
      };
      await Deno.writeTextFile(META_PATH, `${JSON.stringify(meta, null, 2)}\n`);
      console.log(JSON.stringify({
        status: "baked",
        svg: SVG_PATH,
        meta: META_PATH,
        ...meta,
      }));
    } finally {
      await browser.close();
    }
  } finally {
    if (server) {
      try {
        server.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      await server.status;
    }
  }
}

void (async () => {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    Deno.exit(1);
  }
})();
