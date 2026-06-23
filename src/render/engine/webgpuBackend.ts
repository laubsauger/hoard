// T5 / R4 — the ONLY place that constructs `new WebGPURenderer()`. Isolated so tests never touch a GPU.
// Implements the RendererBackend boundary consumed by RendererHost. Device-loss is wired to the real
// GPUDevice.lost promise (V23) via a narrow, documented accessor on three's backend.

import { PCFSoftShadowMap, type Camera, type Scene } from 'three';
import {
  WebGPURenderer,
  type ComputeNode,
  ACESFilmicToneMapping,
  AgXToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  type ToneMapping,
} from 'three/webgpu';
import type { RendererBackend, RendererBackendFactory, ToneMappingMode } from './renderer';

/** Map the engine's tone-mapping mode onto three's tone-mapping constant (B6). Isolated to the GPU backend. */
const TONE_MAPPING: Record<ToneMappingMode, ToneMapping> = {
  aces: ACESFilmicToneMapping,
  agx: AgXToneMapping,
  neutral: NeutralToneMapping,
  none: NoToneMapping,
};

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
    // B13/V36: enable the shadow map so the directional key actually casts. Without this every
    // `castShadow`/`receiveShadow` flag in the scene is inert and the street renders unlit/flat.
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer = renderer;
  }

  render(scene: Scene, camera: Camera): void {
    // render() may return a Promise in some paths; we drive it fire-and-forget within the frame loop.
    void this.requireRenderer().render(scene, camera);
  }

  setToneMapping(mode: ToneMappingMode, exposure: number): void {
    const renderer = this.requireRenderer();
    renderer.toneMapping = TONE_MAPPING[mode];
    renderer.toneMappingExposure = exposure;
  }

  compute(node: ComputeNode): void {
    // Synchronous compute (computeAsync deprecated since r181); the renderer is initialized in init().
    this.requireRenderer().compute(node);
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
