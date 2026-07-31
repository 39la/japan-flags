import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";

type Scope = "national" | "regions" | "prefectures" | "all";
type Layer = "prefecture" | "municipality";
type FitMode = "cover" | "contain" | "stretch" | "motif";
type OutputFormat = "png" | "webp" | "svg";

type Options = {
  scope: Scope;
  layer: Layer;
  fitMode: FitMode;
  format: OutputFormat;
  width: number;
  height: number;
  fill: number;
  timeoutMs: number;
  snapshotDate: string;
  output: string;
  baseUrl: string | null;
  codes: string[];
};

type RenderJob = {
  scope: "national" | "region" | "prefecture";
  slug: string;
  name: string;
  codes: string[];
};

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = resolve(WEB_ROOT, "..");
const PREFECTURE_NAMES = [
  "北海道",
  "青森県",
  "岩手県",
  "宮城県",
  "秋田県",
  "山形県",
  "福島県",
  "茨城県",
  "栃木県",
  "群馬県",
  "埼玉県",
  "千葉県",
  "東京都",
  "神奈川県",
  "新潟県",
  "富山県",
  "石川県",
  "福井県",
  "山梨県",
  "長野県",
  "岐阜県",
  "静岡県",
  "愛知県",
  "三重県",
  "滋賀県",
  "京都府",
  "大阪府",
  "兵庫県",
  "奈良県",
  "和歌山県",
  "鳥取県",
  "島根県",
  "岡山県",
  "広島県",
  "山口県",
  "徳島県",
  "香川県",
  "愛媛県",
  "高知県",
  "福岡県",
  "佐賀県",
  "長崎県",
  "熊本県",
  "大分県",
  "宮崎県",
  "鹿児島県",
  "沖縄県",
] as const;

const REGIONS: RenderJob[] = [
  { scope: "region", slug: "01-hokkaido", name: "北海道", codes: ["01"] },
  { scope: "region", slug: "02-tohoku", name: "東北", codes: codes(2, 7) },
  { scope: "region", slug: "03-kanto", name: "関東", codes: codes(8, 14) },
  { scope: "region", slug: "04-chubu", name: "中部", codes: codes(15, 23) },
  { scope: "region", slug: "05-kinki", name: "近畿", codes: codes(24, 30) },
  { scope: "region", slug: "06-chugoku", name: "中国", codes: codes(31, 35) },
  { scope: "region", slug: "07-shikoku", name: "四国", codes: codes(36, 39) },
  { scope: "region", slug: "08-kyushu-okinawa", name: "九州・沖縄", codes: codes(40, 47) },
];

function codes(first: number, last: number) {
  return Array.from({ length: last - first + 1 }, (_, index) =>
    String(first + index).padStart(2, "0"),
  );
}

function valueAfter(arguments_: string[], index: number, name: string) {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function integer(value: string, name: string, minimum: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseOptions(arguments_: string[]): Options {
  const snapshotDate = Deno.env.get("snapshot_date") ?? "20260101";
  let outputSpecified = false;
  const options: Options = {
    scope: "national",
    layer: "municipality",
    fitMode: "cover",
    format: "png",
    width: 3840,
    height: 2160,
    fill: 0.86,
    timeoutMs: 120_000,
    snapshotDate,
    output: join(REPOSITORY_ROOT, "data", "derived", "map-renders", snapshotDate),
    baseUrl: null,
    codes: [],
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      console.log(`Usage: deno task render:maps [options]

  --scope national|regions|prefectures|all
  --layer prefecture|municipality
  --fit-mode cover|contain|stretch|motif
  --format png|webp|svg
  --width PIXELS          default: 3840
  --height PIXELS         default: 2160
  --fill RATIO            target bounds fill, 0.35-0.96
  --snapshot-date DATE    output metadata/path label
  --output DIRECTORY
  --timeout-ms MS
  --base-url URL          reuse an already-running built app
  --codes 13,14           restrict --scope prefectures
`);
      Deno.exit(0);
    }
    const next = () => valueAfter(arguments_, index++, argument);
    if (argument === "--scope") options.scope = next() as Scope;
    else if (argument === "--layer") options.layer = next() as Layer;
    else if (argument === "--fit-mode") options.fitMode = next() as FitMode;
    else if (argument === "--format") options.format = next() as OutputFormat;
    else if (argument === "--width") options.width = integer(next(), argument, 320);
    else if (argument === "--height") options.height = integer(next(), argument, 240);
    else if (argument === "--timeout-ms") options.timeoutMs = integer(next(), argument, 1_000);
    else if (argument === "--snapshot-date") options.snapshotDate = next();
    else if (argument === "--output") {
      options.output = resolve(next());
      outputSpecified = true;
    } else if (argument === "--base-url") options.baseUrl = next().replace(/\/$/, "");
    else if (argument === "--codes") {
      options.codes = [
        ...new Set(
          next()
            .split(",")
            .map((code) => code.trim()),
        ),
      ];
    } else if (argument === "--fill") options.fill = Number(next());
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!["national", "regions", "prefectures", "all"].includes(options.scope)) {
    throw new Error(`Invalid --scope: ${options.scope}`);
  }
  if (!["prefecture", "municipality"].includes(options.layer)) {
    throw new Error(`Invalid --layer: ${options.layer}`);
  }
  if (!["cover", "contain", "stretch", "motif"].includes(options.fitMode)) {
    throw new Error(`Invalid --fit-mode: ${options.fitMode}`);
  }
  if (!["png", "webp", "svg"].includes(options.format)) {
    throw new Error(`Invalid --format: ${options.format}`);
  }
  if (!Number.isFinite(options.fill) || options.fill < 0.35 || options.fill > 0.96) {
    throw new Error("--fill must be between 0.35 and 0.96");
  }
  if (
    options.codes.some((code) => !/^\d{2}$/.test(code) || Number(code) < 1 || Number(code) > 47)
  ) {
    throw new Error("--codes must contain prefecture codes from 01 through 47");
  }
  if (options.codes.length && options.scope !== "prefectures") {
    throw new Error("--codes is supported with --scope prefectures");
  }
  if (!outputSpecified) {
    options.output = join(REPOSITORY_ROOT, "data", "derived", "map-renders", options.snapshotDate);
  }
  return options;
}

function jobsForScope(scope: Scope): RenderJob[] {
  const national: RenderJob = { scope: "national", slug: "japan", name: "全国", codes: [] };
  const prefectures: RenderJob[] = PREFECTURE_NAMES.map((name, index) => {
    const code = String(index + 1).padStart(2, "0");
    return { scope: "prefecture", slug: `${code}-prefecture`, name, codes: [code] };
  });
  if (scope === "national") return [national];
  if (scope === "regions") return REGIONS;
  if (scope === "prefectures") return prefectures;
  return [national, ...REGIONS, ...prefectures];
}

async function waitForServer(baseUrl: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Preview server did not start: ${baseUrl}`);
}

async function main() {
  const options = parseOptions(Deno.args);
  const requestedCodes = new Set(options.codes);
  const jobs = jobsForScope(options.scope).filter(
    (job) => !requestedCodes.size || job.codes.some((code) => requestedCodes.has(code)),
  );
  const port = 41_000 + Math.floor(Math.random() * 1_000);
  const baseUrl = options.baseUrl ?? `http://127.0.0.1:${port}`;
  const server = options.baseUrl
    ? null
    : new Deno.Command(Deno.execPath(), {
        args: ["task", "preview", "--host", "127.0.0.1", "--port", String(port)],
        cwd: WEB_ROOT,
        stdout: "null",
        stderr: "inherit",
      }).spawn();

  try {
    await waitForServer(baseUrl);
    await Deno.mkdir(options.output, { recursive: true });
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      throw new Error(
        `Chromiumを起動できません。先に mise run render:install-browser を実行してください。\n${error}`,
      );
    }
    const rendered = [];
    try {
      const page = await browser.newPage({
        viewport: { width: options.width, height: options.height },
        deviceScaleFactor: 1,
      });
      page.on("pageerror", (error) => console.error(`[page] ${error.message}`));
      for (const [index, job] of jobs.entries()) {
        const parameters = new URLSearchParams({
          mapExport: "1",
          layer: options.layer,
          fitMode: options.fitMode,
          fill: String(options.fill),
        });
        if (job.codes.length) parameters.set("codes", job.codes.join(","));
        const url = `${baseUrl}/?${parameters}`;
        console.error(`[${index + 1}/${jobs.length}] ${job.name}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
        const map = page.locator('.map-shell[data-export-ready="true"]');
        await map.waitFor({ state: "visible", timeout: options.timeoutMs });
        await page.evaluate("document.fonts.ready");
        const bytes = await (async () => {
          if (options.format === "svg") {
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
              { width: options.width, height: options.height },
            );
            return new TextEncoder().encode(source);
          }
          const png = await map.screenshot({ type: "png", animations: "disabled" });
          return options.format === "png"
            ? png
            : await sharp(png).webp({ lossless: true, effort: 4 }).toBuffer();
        })();
        const filename = `${job.scope}-${job.slug}.${options.format}`;
        const outputPath = join(options.output, filename);
        await Deno.writeFile(outputPath, bytes);
        const image = await sharp(bytes).metadata();
        if (image.width !== options.width || image.height !== options.height) {
          throw new Error(`${filename}: unexpected size ${image.width}x${image.height}`);
        }
        const metadata = {
          snapshotDate: options.snapshotDate,
          generatedAt: new Date().toISOString(),
          scope: job.scope,
          name: job.name,
          prefectureCodes: job.codes,
          layer: options.layer,
          fitMode: options.fitMode,
          fill: options.fill,
          width: image.width,
          height: image.height,
          format: options.format,
          bytes: bytes.byteLength,
          sourceQuery: `?${parameters}`,
          image: filename,
        };
        await Deno.writeTextFile(
          join(options.output, `${job.scope}-${job.slug}.json`),
          `${JSON.stringify(metadata, null, 2)}\n`,
        );
        rendered.push(metadata);
      }
    } finally {
      await browser.close();
    }
    const manifestPath = join(options.output, "manifest.json");
    await Deno.writeTextFile(manifestPath, `${JSON.stringify({ images: rendered }, null, 2)}\n`);
    console.log(JSON.stringify({ output: options.output, images: rendered.length, manifestPath }));
  } finally {
    if (server) {
      try {
        server.kill("SIGTERM");
      } catch {
        // The preview process already exited.
      }
      await server.status;
    }
  }
}

await main();
