import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";

type Backend = "css" | "canvas";
type AssetKind = "svg" | "webp";
type MapScope = "national" | "tokyo";

type Camera = {
  x: number;
  y: number;
  k: number;
};

type AssetMetrics = {
  loadMs: number;
  encodedBytes: number | null;
  width: number;
  height: number;
};

type BenchmarkMetrics = {
  frames: number;
  durationMs: number;
  averageFrameMs: number;
  p95FrameMs: number;
  over20ms: number;
  estimatedFps: number;
};

type DragState = {
  pointerX: number;
  pointerY: number;
  cameraX: number;
  cameraY: number;
};

const ASSET_PATHS: Record<MapScope, Record<AssetKind, string>> = {
  national: {
    svg: "/map-assets/national-japan.svg",
    webp: "/map-assets/national-japan.webp",
  },
  tokyo: {
    svg: "/map-assets/prefecture-13.svg",
    webp: "/map-assets/prefecture-13.webp",
  },
};
const INITIAL_CAMERA: Camera = { x: 0, y: 0, k: 1 };
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 8;
const BENCHMARK_FRAMES = 240;

function initialAssetKind(): AssetKind {
  return new URLSearchParams(window.location.search).get("asset") === "webp" ? "webp" : "svg";
}

function initialMapScope(): MapScope {
  return new URLSearchParams(window.location.search).get("scope") === "national"
    ? "national"
    : "tokyo";
}

function formatBytes(bytes: number | null) {
  if (bytes === null) return "取得不可";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function metric(value: number | undefined, digits = 1) {
  return value === undefined ? "—" : value.toFixed(digits);
}

export function App() {
  const [backend, setBackend] = useState<Backend>("css");
  const [assetKind, setAssetKind] = useState<AssetKind>(initialAssetKind);
  const [mapScope, setMapScope] = useState<MapScope>(initialMapScope);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [assetMetrics, setAssetMetrics] = useState<AssetMetrics | null>(null);
  const [benchmark, setBenchmark] = useState<BenchmarkMetrics | null>(null);
  const [status, setStatus] = useState("合成済みSVGを読み込んでいます…");
  const [running, setRunning] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageHostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<Camera>({ ...INITIAL_CAMERA });
  const dragRef = useRef<DragState | null>(null);
  const animationRef = useRef<number | null>(null);
  const assetPath = ASSET_PATHS[mapScope][assetKind];

  const resizeCanvas = useCallback(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return null;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, stage.clientWidth);
    const height = Math.max(1, stage.clientHeight);
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    return { width, height, ratio };
  }, []);

  const renderCamera = useCallback(
    (camera: Camera) => {
      cameraRef.current = camera;
      if (backend === "css") {
        if (image) {
          image.style.transform = `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.k})`;
        }
        return;
      }
      const canvas = canvasRef.current;
      const dimensions = resizeCanvas();
      const context = canvas?.getContext("2d");
      if (!canvas || !dimensions || !context || !image) return;
      const { width, height, ratio } = dimensions;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.setTransform(
        ratio * camera.k,
        0,
        0,
        ratio * camera.k,
        ratio * (width / 2 + camera.x),
        ratio * (height / 2 + camera.y),
      );
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, -width / 2, -height / 2, width, height);
    },
    [backend, image, resizeCanvas],
  );

  const resetCamera = useCallback(() => {
    renderCamera({ ...INITIAL_CAMERA });
  }, [renderCamera]);

  useEffect(() => {
    let active = true;
    const startedAt = performance.now();
    const nextImage = new Image();
    nextImage.className = "precomposed-map";
    nextImage.alt = mapScope === "national" ? "全国市区町村旗マップ" : "東京都市区町村旗マップ";
    nextImage.draggable = false;
    setImage(null);
    setAssetMetrics(null);
    setBenchmark(null);
    setStatus(`${assetKind.toUpperCase()}をdecodeしています…`);
    nextImage.src = assetPath;
    nextImage
      .decode()
      .then(() => {
        if (!active) return;
        const absoluteUrl = new URL(assetPath, window.location.href).href;
        const resourceEntries = performance
          .getEntriesByName(absoluteUrl)
          .filter((entry): entry is PerformanceResourceTiming => "encodedBodySize" in entry);
        const resource = resourceEntries[resourceEntries.length - 1];
        setImage(nextImage);
        setAssetMetrics({
          loadMs: performance.now() - startedAt,
          encodedBytes: resource?.encodedBodySize || null,
          width: nextImage.naturalWidth,
          height: nextImage.naturalHeight,
        });
        setStatus("準備完了。ドラッグ・ホイール・自動計測を試せます。");
      })
      .catch(() => {
        if (active) setStatus("画像を読み込めませんでした。生成済みmap renderを確認してください。");
      });
    return () => {
      active = false;
      nextImage.src = "";
    };
  }, [assetKind, assetPath, mapScope]);

  useEffect(() => {
    const host = imageHostRef.current;
    if (backend !== "css" || !host || !image) return;
    host.replaceChildren(image);
    return () => {
      if (image.parentElement === host) host.removeChild(image);
    };
  }, [backend, image]);

  useEffect(() => {
    resetCamera();
  }, [backend, image, resetCamera]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => renderCamera(cameraRef.current));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [renderCamera]);

  useEffect(
    () => () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    },
    [],
  );

  const runBenchmark = () => {
    if (!image || running) return;
    setRunning(true);
    setBenchmark(null);
    setStatus("240フレームのパン・ズームを計測しています…");
    const frameDurations: number[] = [];
    const startedAt = performance.now();
    let previousAt = startedAt;
    let frame = 0;
    const tick = (now: number) => {
      if (frame > 0) frameDurations.push(now - previousAt);
      previousAt = now;
      const progress = frame / (BENCHMARK_FRAMES - 1);
      const angle = progress * Math.PI * 4;
      renderCamera({
        x: Math.sin(angle) * 150,
        y: Math.sin(angle * 0.7) * 82,
        k: 1 + (Math.sin(angle - Math.PI / 2) + 1) * 0.9,
      });
      frame += 1;
      if (frame < BENCHMARK_FRAMES) {
        animationRef.current = requestAnimationFrame(tick);
        return;
      }
      const sorted = [...frameDurations].sort((left, right) => left - right);
      const durationMs = now - startedAt;
      const averageFrameMs =
        frameDurations.reduce((total, duration) => total + duration, 0) /
        Math.max(1, frameDurations.length);
      setBenchmark({
        frames: BENCHMARK_FRAMES,
        durationMs,
        averageFrameMs,
        p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        over20ms: frameDurations.filter((duration) => duration > 20).length,
        estimatedFps: 1000 / Math.max(averageFrameMs, 0.01),
      });
      animationRef.current = null;
      setRunning(false);
      setStatus("計測が完了しました。");
      resetCamera();
    };
    animationRef.current = requestAnimationFrame(tick);
  };

  const setZoom = (factor: number) => {
    const current = cameraRef.current;
    renderCamera({
      ...current,
      k: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.k * factor)),
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      cameraX: cameraRef.current.x,
      cameraY: cameraRef.current.y,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || running) return;
    renderCamera({
      ...cameraRef.current,
      x: drag.cameraX + event.clientX - drag.pointerX,
      y: drag.cameraY + event.clientY - drag.pointerY,
    });
  };

  return (
    <main className="experiment-app">
      <header className="app-header">
        <div>
          <h1>事前合成SVG 描画実験</h1>
          <p>自治体・旗・境界を1画像へまとめ、ブラウザ実行時の描画負荷を比較します。</p>
        </div>
        <div className="header-status" aria-live="polite">
          <span className={image ? "status-dot is-ready" : "status-dot"} />
          {status}
        </div>
      </header>

      <section className="workspace">
        <div
          ref={stageRef}
          className={`map-stage is-${backend}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => {
            dragRef.current = null;
          }}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
          onWheel={(event: WheelEvent<HTMLDivElement>) => {
            event.preventDefault();
            if (!running) setZoom(event.deltaY < 0 ? 1.15 : 0.87);
          }}
        >
          {backend === "css" && <div ref={imageHostRef} className="precomposed-image-host" />}
          {backend === "canvas" && (
            <canvas
              ref={canvasRef}
              className="precomposed-canvas"
              aria-label={
                mapScope === "national" ? "全国市区町村旗マップ" : "東京都市区町村旗マップ"
              }
            />
          )}
          {!image && <div className="loading-map">画像を準備しています…</div>}
          <div className="map-hint">ドラッグで移動 · ホイールで拡大縮小</div>
          <div className="zoom-controls" aria-label="地図操作">
            <button type="button" aria-label="拡大" onClick={() => setZoom(1.3)} disabled={running}>
              ＋
            </button>
            <button
              type="button"
              aria-label="縮小"
              onClick={() => setZoom(0.76)}
              disabled={running}
            >
              −
            </button>
            <button type="button" onClick={resetCamera} disabled={running}>
              全体
            </button>
          </div>
        </div>

        <aside className="control-panel">
          <section>
            <h2>合成単位</h2>
            <div className="segmented-control">
              <button
                type="button"
                className={mapScope === "national" ? "is-active" : ""}
                aria-pressed={mapScope === "national"}
                onClick={() => setMapScope("national")}
                disabled={running}
              >
                全国1枚（17MB）
              </button>
              <button
                type="button"
                className={mapScope === "tokyo" ? "is-active" : ""}
                aria-pressed={mapScope === "tokyo"}
                onClick={() => setMapScope("tokyo")}
                disabled={running}
              >
                東京都1枚
              </button>
            </div>
          </section>

          <section>
            <h2>描画方式</h2>
            <div className="segmented-control">
              <button
                type="button"
                className={backend === "css" ? "is-active" : ""}
                aria-pressed={backend === "css"}
                onClick={() => setBackend("css")}
                disabled={running}
              >
                CSS transform
              </button>
              <button
                type="button"
                className={backend === "canvas" ? "is-active" : ""}
                aria-pressed={backend === "canvas"}
                onClick={() => setBackend("canvas")}
                disabled={running}
              >
                Canvas drawImage
              </button>
            </div>
          </section>

          <section>
            <h2>入力画像</h2>
            <div className="segmented-control">
              <button
                type="button"
                className={assetKind === "svg" ? "is-active" : ""}
                aria-pressed={assetKind === "svg"}
                onClick={() => setAssetKind("svg")}
                disabled={running}
              >
                SVG 1枚
              </button>
              <button
                type="button"
                className={assetKind === "webp" ? "is-active" : ""}
                aria-pressed={assetKind === "webp"}
                onClick={() => setAssetKind("webp")}
                disabled={running}
              >
                WebP比較
              </button>
            </div>
          </section>

          <section>
            <div className="section-heading">
              <h2>読み込み</h2>
              <span>{assetKind.toUpperCase()}</span>
            </div>
            <dl className="metrics-list">
              <div>
                <dt>decode完了</dt>
                <dd>{assetMetrics ? `${metric(assetMetrics.loadMs)} ms` : "—"}</dd>
              </div>
              <div>
                <dt>転送サイズ</dt>
                <dd>{formatBytes(assetMetrics?.encodedBytes ?? null)}</dd>
              </div>
              <div>
                <dt>画像寸法</dt>
                <dd>{assetMetrics ? `${assetMetrics.width} × ${assetMetrics.height}` : "—"}</dd>
              </div>
            </dl>
          </section>

          <section>
            <div className="section-heading">
              <h2>自動パン・ズーム</h2>
              <span>{BENCHMARK_FRAMES} frames</span>
            </div>
            <button
              className="benchmark-button"
              type="button"
              onClick={runBenchmark}
              disabled={!image || running}
            >
              {running ? "計測中…" : "ベンチマークを実行"}
            </button>
            <dl className="metrics-grid">
              <div>
                <dt>平均</dt>
                <dd>{metric(benchmark?.averageFrameMs)} ms</dd>
              </div>
              <div>
                <dt>p95</dt>
                <dd>{metric(benchmark?.p95FrameMs)} ms</dd>
              </div>
              <div>
                <dt>推定FPS</dt>
                <dd>{metric(benchmark?.estimatedFps, 0)}</dd>
              </div>
              <div>
                <dt>&gt; 20ms</dt>
                <dd>{benchmark?.over20ms ?? "—"}</dd>
              </div>
            </dl>
            {benchmark && (
              <p className="benchmark-note">
                {benchmark.frames}フレームを{(benchmark.durationMs / 1000).toFixed(2)}秒で描画
              </p>
            )}
          </section>

          <p className="experiment-note">
            この画面はヒットテストや詳細LODを持たず、事前合成画像の移動・拡大縮小だけを測ります。
          </p>
        </aside>
      </section>
    </main>
  );
}
