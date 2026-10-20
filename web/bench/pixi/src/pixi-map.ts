import { Application, Assets, Container, Sprite, Texture } from "pixi.js";

export type Camera = { x: number; y: number; k: number };

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 760;

export class PixiMap {
  readonly app: Application;
  readonly world: Container;
  readonly sprite: Sprite;

  private readonly host: HTMLElement;
  private readonly textureUrl: string;
  private readonly resizeObserver: ResizeObserver;
  private camera: Camera;
  private fitScale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private renderFrame: number | null = null;
  private onRender: (renderMs: number) => void;

  private constructor(
    host: HTMLElement,
    app: Application,
    textureUrl: string,
    texture: Texture,
    camera: Camera,
    onRender: (renderMs: number) => void,
  ) {
    this.host = host;
    this.app = app;
    this.textureUrl = textureUrl;
    this.camera = { ...camera };
    this.onRender = onRender;
    this.world = new Container();
    this.world.eventMode = "none";
    this.sprite = new Sprite(texture);
    this.sprite.width = VIEW_WIDTH;
    this.sprite.height = VIEW_HEIGHT;
    this.world.addChild(this.sprite);
    this.app.stage.addChild(this.world);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  static async mount(
    host: HTMLElement,
    textureUrl: string,
    camera: Camera,
    onRender: (renderMs: number) => void,
  ) {
    const app = new Application();
    await app.init({
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      background: "#f5f6f7",
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      preference: "webgl",
    });
    app.ticker.stop();
    app.canvas.className = "pixi-canvas";
    host.appendChild(app.canvas);
    try {
      const texture = await Assets.load<Texture>(textureUrl);
      return new PixiMap(host, app, textureUrl, texture, camera, onRender);
    } catch (error) {
      app.destroy({ removeView: true });
      throw error;
    }
  }

  setCamera(camera: Camera) {
    this.camera = { ...camera };
    this.applyCamera();
    this.requestRender();
  }

  screenDeltaToLogical(delta: number) {
    return delta / this.fitScale;
  }

  clientToViewport(clientX: number, clientY: number) {
    const rect = this.app.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.offsetX) / this.fitScale,
      y: (clientY - rect.top - this.offsetY) / this.fitScale,
    };
  }

  requestRender() {
    if (this.renderFrame !== null) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = null;
      const started = performance.now();
      this.app.render();
      this.onRender(performance.now() - started);
    });
  }

  destroy() {
    if (this.renderFrame !== null) cancelAnimationFrame(this.renderFrame);
    this.resizeObserver.disconnect();
    this.app.destroy({ removeView: true }, { children: true });
    void Assets.unload(this.textureUrl);
  }

  private resize() {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.app.renderer.resize(width, height);
    this.fitScale = Math.min(width / VIEW_WIDTH, height / VIEW_HEIGHT);
    this.offsetX = (width - VIEW_WIDTH * this.fitScale) / 2;
    this.offsetY = (height - VIEW_HEIGHT * this.fitScale) / 2;
    this.applyCamera();
    this.requestRender();
  }

  private applyCamera() {
    this.world.position.set(
      this.offsetX + this.camera.x * this.fitScale,
      this.offsetY + this.camera.y * this.fitScale,
    );
    this.world.scale.set(this.fitScale * this.camera.k);
  }
}
