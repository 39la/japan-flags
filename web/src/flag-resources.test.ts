import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type LoadHandler = (() => void | Promise<void>) | null;

class FakeImage {
  static instances: FakeImage[] = [];

  decoding = "";
  naturalWidth = 120;
  naturalHeight = 80;
  onload: LoadHandler = null;
  onerror: LoadHandler = null;
  private source = "";

  constructor() {
    FakeImage.instances.push(this);
  }

  set src(value: string) {
    this.source = value;
  }

  get src() {
    return this.source;
  }

  succeed() {
    return this.onload?.();
  }

  fail() {
    return this.onerror?.();
  }
}

describe("flag resource batches", () => {
  beforeEach(() => {
    vi.resetModules();
    FakeImage.instances = [];
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() =>
        Promise.resolve({
          close: vi.fn(),
        } as unknown as ImageBitmap),
      ),
    );
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("settles once after both raster and SVG requests finish", async () => {
    const { requestFlagResources } = await import("./flag-resources");
    const batch = requestFlagResources(
      [
        {
          key: "/flags/a.svg@64",
          path: "/flags/a.svg",
          bucket: 64,
        },
      ],
      ["/flags/b.svg"],
    );

    expect(batch).not.toBeNull();
    expect(FakeImage.instances).toHaveLength(2);

    let settled = false;
    void batch?.then(() => {
      settled = true;
    });

    await FakeImage.instances.find((image) => image.src === "/flags/b.svg")?.succeed();
    await Promise.resolve();
    expect(settled).toBe(false);

    await FakeImage.instances.find((image) => image.src === "/flags/a.svg")?.succeed();
    await expect(batch).resolves.toBe(true);
    expect(settled).toBe(true);

    expect(
      requestFlagResources(
        [
          {
            key: "/flags/a.svg@64",
            path: "/flags/a.svg",
            bucket: 64,
          },
        ],
        ["/flags/b.svg"],
      ),
    ).toBeNull();
  });

  it("settles canceled queued resources without committing them", async () => {
    vi.useFakeTimers();
    const { requestFlagResources } = await import("./flag-resources");
    const oldBatch = requestFlagResources([], ["/a.svg", "/b.svg", "/c.svg", "/d.svg", "/e.svg"]);
    const currentBatch = requestFlagResources([], ["/current.svg"]);

    expect(FakeImage.instances).toHaveLength(4);
    await Promise.all(FakeImage.instances.map((image) => image.succeed()));
    await vi.runAllTimersAsync();

    const current = FakeImage.instances.find((image) => image.src === "/current.svg");
    expect(current).toBeDefined();
    await current?.succeed();

    await expect(oldBatch).resolves.toBe(false);
    await expect(currentBatch).resolves.toBe(true);
  });

  it("settles a failed batch without requesting a redraw", async () => {
    const { requestFlagResources } = await import("./flag-resources");
    const batch = requestFlagResources([], ["/broken.svg"]);

    await FakeImage.instances[0].fail();

    await expect(batch).resolves.toBe(false);
  });

  it("does not cancel a prefetched resource when an active batch starts", async () => {
    const { prefetchFlagResources, requestFlagResources, cachedFlagSvg } =
      await import("./flag-resources");
    const prefetched = prefetchFlagResources([], ["/prefetch.svg"]);
    const active = requestFlagResources([], ["/active.svg"]);

    expect(FakeImage.instances).toHaveLength(2);
    await FakeImage.instances.find((image) => image.src === "/active.svg")?.succeed();
    await FakeImage.instances.find((image) => image.src === "/prefetch.svg")?.succeed();

    await expect(active).resolves.toBe(true);
    await expect(prefetched).resolves.toBe(true);
    expect(cachedFlagSvg("/prefetch.svg")).not.toBeNull();
  });
});
