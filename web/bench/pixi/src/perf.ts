export type PerfSample = {
  renderCount: number;
  averageRenderMs: number;
  lastRenderMs: number;
  basemapLoadMs: number;
  startupMs: number;
  memoryUsedBytes: number | null;
};

type MemoryInfo = { usedJSHeapSize: number };

export function createPerfCollector() {
  const renderTimes: number[] = [];
  let basemapLoadMs = 0;
  let startupMs = 0;

  return {
    recordRender(ms: number) {
      renderTimes.push(ms);
      if (renderTimes.length > 120) renderTimes.shift();
    },
    recordBasemapLoad(ms: number) {
      basemapLoadMs = ms;
    },
    recordStartup(ms: number) {
      startupMs = ms;
    },
    sample(): PerfSample {
      const memory =
        (performance as Performance & { memory?: MemoryInfo }).memory;
      const total = renderTimes.reduce((sum, value) => sum + value, 0);
      return {
        renderCount: renderTimes.length,
        averageRenderMs: renderTimes.length ? total / renderTimes.length : 0,
        lastRenderMs: renderTimes.at(-1) ?? 0,
        basemapLoadMs,
        startupMs,
        memoryUsedBytes: memory?.usedJSHeapSize ?? null,
      };
    },
  };
}

export type PerfCollector = ReturnType<typeof createPerfCollector>;

export function perfToJson(sample: PerfSample) {
  return JSON.stringify(
    { timestamp: new Date().toISOString(), ...sample },
    null,
    2,
  );
}
