import { useEffect, useRef, useState } from "preact/hooks";
import { type BasemapMetadata, loadBasemap } from "./basemap";
import { createPerfCollector, type PerfSample, perfToJson } from "./perf";
import { type Camera, PixiMap } from "./pixi-map";

const NATIONAL_VIEW: Camera = { x: -40, y: -20, k: 1.08 };
const EMPTY_PERF: PerfSample = {
  renderCount: 0,
  averageRenderMs: 0,
  lastRenderMs: 0,
  basemapLoadMs: 0,
  startupMs: 0,
  memoryUsedBytes: null,
};

type Drag = { pointerId: number; x: number; y: number; camera: Camera };

export function App() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<PixiMap | null>(null);
  const cameraRef = useRef<Camera>({ ...NATIONAL_VIEW });
  const dragRef = useRef<Drag | null>(null);
  const perfRef = useRef(createPerfCollector());
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<BasemapMetadata | null>(null);
  const [perf, setPerf] = useState<PerfSample>(EMPTY_PERF);
  const [showMetrics, setShowMetrics] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const started = performance.now();
    let mountedMap: PixiMap | null = null;
    let sampleTimer: number | null = null;
    void (async () => {
      try {
        const host = hostRef.current;
        if (!host) return;
        const loadStarted = performance.now();
        const basemap = await loadBasemap(controller.signal);
        mountedMap = await PixiMap.mount(
          host,
          basemap.svgUrl,
          cameraRef.current,
          (renderMs) => {
            perfRef.current.recordRender(renderMs);
          },
        );
        if (controller.signal.aborted) {
          mountedMap.destroy();
          return;
        }
        mapRef.current = mountedMap;
        perfRef.current.recordBasemapLoad(performance.now() - loadStarted);
        perfRef.current.recordStartup(performance.now() - started);
        setMetadata(basemap.metadata);
        setStatus("ready");
        mountedMap.requestRender();
        sampleTimer = window.setInterval(
          () => setPerf(perfRef.current.sample()),
          500,
        );
      } catch (reason) {
        if (!controller.signal.aborted) {
          setStatus("error");
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    })();
    return () => {
      controller.abort();
      if (sampleTimer !== null) window.clearInterval(sampleTimer);
      mapRef.current = null;
      mountedMap?.destroy();
    };
  }, []);

  const setCamera = (camera: Camera) => {
    cameraRef.current = camera;
    mapRef.current?.setCamera(camera);
  };

  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    const map = mapRef.current;
    if (!map) return;
    const current = cameraRef.current;
    const nextK = Math.max(0.5, Math.min(24, current.k * factor));
    const pointer = clientX === undefined || clientY === undefined
      ? { x: 500, y: 380 }
      : map.clientToViewport(clientX, clientY);
    const worldX = (pointer.x - current.x) / current.k;
    const worldY = (pointer.y - current.y) / current.k;
    setCamera({
      k: nextK,
      x: pointer.x - worldX * nextK,
      y: pointer.y - worldY * nextK,
    });
  };

  const exportMetrics = () => {
    const blob = new Blob([perfToJson(perfRef.current.sample())], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `preact-pixi-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main class="app">
      <header class="header">
        <div>
          <h1>地方旗ビューワー</h1>
          <p>Preact + PixiJS / precomposed SVG prototype</p>
        </div>
        <div class="controls">
          <button type="button" onClick={() => zoomAt(1.3)} aria-label="拡大">
            ＋
          </button>
          <button type="button" onClick={() => zoomAt(0.76)} aria-label="縮小">
            −
          </button>
          <button type="button" onClick={() => setCamera({ ...NATIONAL_VIEW })}>
            全国
          </button>
          <button
            type="button"
            onClick={() => setShowMetrics((value) => !value)}
          >
            {showMetrics ? "計測を隠す" : "計測を表示"}
          </button>
        </div>
      </header>

      <section
        class="map-host"
        ref={hostRef}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            camera: { ...cameraRef.current },
          };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          const map = mapRef.current;
          if (!drag || !map || drag.pointerId !== event.pointerId) return;
          setCamera({
            ...drag.camera,
            x: drag.camera.x + map.screenDeltaToLogical(event.clientX - drag.x),
            y: drag.camera.y + map.screenDeltaToLogical(event.clientY - drag.y),
          });
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null;
          }
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onWheel={(event) => {
          event.preventDefault();
          zoomAt(event.deltaY < 0 ? 1.18 : 0.84, event.clientX, event.clientY);
        }}
      >
        {status === "loading" && (
          <p class="status">SVG textureを読み込んでいます…</p>
        )}
        {status === "error" && <p class="status error">{error}</p>}
        {showMetrics && (
          <Metrics perf={perf} metadata={metadata} onExport={exportMetrics} />
        )}
      </section>

      <footer class="footer">
        <span>ドラッグで移動・ホイールでズーム</span>
        <span>1 texture / on-demand render / WebGL</span>
      </footer>
    </main>
  );
}

function Metrics({
  perf,
  metadata,
  onExport,
}: {
  perf: PerfSample;
  metadata: BasemapMetadata | null;
  onExport: () => void;
}) {
  return (
    <aside class="metrics">
      <strong>Pixi renderer</strong>
      <dl>
        <dt>startup</dt>
        <dd>{perf.startupMs.toFixed(0)} ms</dd>
        <dt>SVG texture</dt>
        <dd>{perf.basemapLoadMs.toFixed(0)} ms</dd>
        <dt>render avg</dt>
        <dd>{perf.averageRenderMs.toFixed(2)} ms</dd>
        <dt>render last</dt>
        <dd>{perf.lastRenderMs.toFixed(2)} ms</dd>
        <dt>sampled renders</dt>
        <dd>{perf.renderCount}</dd>
        <dt>JS heap</dt>
        <dd>
          {perf.memoryUsedBytes === null
            ? "n/a"
            : `${(perf.memoryUsedBytes / 1024 / 1024).toFixed(1)} MB`}
        </dd>
        {metadata && (
          <>
            <dt>SVG size</dt>
            <dd>{(metadata.bytes / 1024 / 1024).toFixed(1)} MB</dd>
            <dt>source</dt>
            <dd>
              {metadata.width}×{metadata.height}
            </dd>
          </>
        )}
      </dl>
      <button type="button" onClick={onExport}>
        JSON export
      </button>
    </aside>
  );
}
