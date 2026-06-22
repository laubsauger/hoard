// T5 / R4 — the ONLY place that constructs `new WebGPURenderer()`. Isolated so tests never touch a GPU.
// Implements the RendererBackend boundary consumed by RendererHost. Device-loss is wired to the real
// GPUDevice.lost promise (V23) via a narrow, documented accessor on three's backend.

import type { Camera, Scene } from 'three';
import { WebGPURenderer } from 'three/webgpu';
import type { RendererBackend, RendererBackendFactory } from './renderer';

/** three's base Backend type does not surface `device`; the WebGPU backend does. Narrow accessor. */
interface WithGpuDevice {
  device?: GPUDevice;
}

export interface WebGpuBackendOptions {
  canvas: HTMLCanvasElement;
  /** WebGL fallback path only if it does not distort core arch (§C). */
  forceWebGL?: boolean;
}

class WebGpuRendererBackend implements RendererBackend {
  private renderer: WebGPURenderer | null = null;
  private readonly options: WebGpuBackendOptions;

  constructor(options: WebGpuBackendOptions) {
    this.options = options;
  }

  async init(): Promise<void> {
    const renderer = new WebGPURenderer({
      canvas: this.options.canvas,
      antialias: true,
      ...(this.options.forceWebGL !== undefined ? { forceWebGL: this.options.forceWebGL } : {}),
    });
    await renderer.init();
    this.renderer = renderer;
  }

  render(scene: Scene, camera: Camera): void {
    // render() may return a Promise in some paths; we drive it fire-and-forget within the frame loop.
    void this.requireRenderer().render(scene, camera);
  }

  setSize(width: number, height: number): void {
    this.requireRenderer().setSize(width, height, false);
  }

  setPixelRatio(ratio: number): void {
    this.requireRenderer().setPixelRatio(ratio);
  }

  onDeviceLost(cb: (reason: string) => void): () => void {
    const device = (this.requireRenderer().backend as unknown as WithGpuDevice).device;
    if (!device) {
      throw new Error('WebGPU device not available after init; cannot wire device-loss recovery (V23)');
    }
    let active = true;
    void device.lost.then((info) => {
      if (active) cb(`${info.reason}: ${info.message}`);
    });
    return () => {
      active = false;
    };
  }

  dispose(): void {
    this.renderer?.dispose();
    this.renderer = null;
  }

  private requireRenderer(): WebGPURenderer {
    if (!this.renderer) throw new Error('WebGPU backend used before init()');
    return this.renderer;
  }
}

/** Factory for RendererHost. Construction of WebGPURenderer is deferred to init() inside the backend. */
export function createWebGpuBackendFactory(options: WebGpuBackendOptions): RendererBackendFactory {
  return () => new WebGpuRendererBackend(options);
}
