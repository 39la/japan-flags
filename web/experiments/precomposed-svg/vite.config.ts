import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const experimentRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(experimentRoot, "../../..");
const snapshotDate = process.env.SNAPSHOT_DATE ?? "20260101";
const renderDirectory = resolve(repositoryRoot, "data", "derived", "map-renders", snapshotDate);
const assets = {
  "/map-assets/national-japan.svg": resolve(renderDirectory, "national-japan.svg"),
  "/map-assets/national-japan.webp": resolve(renderDirectory, "national-japan.webp"),
  "/map-assets/prefecture-13.svg": resolve(renderDirectory, "prefecture-13-prefecture.svg"),
  "/map-assets/prefecture-13.webp": resolve(renderDirectory, "prefecture-13-prefecture.webp"),
} as const;

function precomposedMapAssets(): Plugin {
  return {
    name: "precomposed-map-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split("?", 1)[0] as keyof typeof assets | undefined;
        const assetPath = pathname ? assets[pathname] : undefined;
        if (!assetPath) {
          next();
          return;
        }
        response.setHeader(
          "Content-Type",
          pathname?.endsWith(".svg") ? "image/svg+xml" : "image/webp",
        );
        response.setHeader("Cache-Control", "no-cache");
        response.end(readFileSync(assetPath));
      });
    },
    generateBundle() {
      for (const [publicPath, assetPath] of Object.entries(assets)) {
        this.emitFile({
          type: "asset",
          fileName: publicPath.replace(/^\//, ""),
          source: readFileSync(assetPath),
        });
      }
    },
  };
}

export default defineConfig({
  root: experimentRoot,
  publicDir: false,
  plugins: [react(), precomposedMapAssets()],
  build: {
    outDir: resolve(experimentRoot, "../../dist-precomposed-svg"),
    emptyOutDir: true,
  },
});
