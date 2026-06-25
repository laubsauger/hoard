// T5 / R4 — the ONLY place that constructs `new WebGPURenderer()`. Isolated so tests never touch a GPU.
// Implements the RendererBackend boundary consumed by RendererHost. Device-loss is wired to the real
// GPUDevice.lost promise (V23) via a narrow, documented accessor on three's backend.

import { PCFSoftShadowMap, type Camera, type Scene } from 'three';
import {
  WebGPURenderer,
  type ComputeNode,
  type PostProcessing,
  ACESFilmicToneMapping,
  AgXToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  type ToneMapping,
} from 'three/webgpu';
import type { RendererBackend, RendererBackendFactory, ToneMappingMode } from './renderer';
import { buildAoPostProcessing, type AoSettings } from './postFx';

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
  /**
   * GTAO ambient-occlusion config, resolved per tier (V4). Absent → no AO path is ever built (the isolated
   * devtools scenes pass no AO). `enabled` is the per-tier base (false on the lowest tier); a live runtime
   * flag (setAoEnabled) gates it further. Effective AO = enabled && runtimeFlag.
   */
  ao?: { enabled: boolean } & AoSettings;
}

class WebGpuRendererBackend implements RendererBackend {
  private renderer: WebGPURenderer | null = null;
  private readonly options: WebGpuBackendOptions;
  /**
   * Lazily-built GTAO pipeline (scene+camera are stable refs from the render loop). Built on the first
   * AO-enabled frame; null while AO is off or before the first such frame. Rebuilt automatically after a
   * device-loss recovery because the host constructs a FRESH backend instance.
   */
  private aoPipeline: PostProcessing | null = null;
  /** Runtime AO toggle (the `ao` debug flag); ANDed with the per-tier config base in options.ao.enabled. */
  private aoRuntimeEnabled = true;

  constructor(options: WebGpuBackendOptions) {
    this.options = options;
  }

  /** Effective AO state: config base (per tier) AND the live runtime flag. False when no AO config was passed. */
  private aoActive(): boolean {
    return this.options.ao?.enabled === true && this.aoRuntimeEnabled;
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
    const renderer = this.requireRenderer();
    if (this.aoActive()) {
      // Build the GTAO pipeline lazily on the first AO frame (scene+camera are stable refs). The pass
      // auto-tracks the renderer size/pixelRatio each frame, so resize needs no extra plumbing here.
      // render() may return a Promise in some paths; we drive it fire-and-forget within the frame loop —
      // mirroring the direct path's `void` (the host's controlled-render guard already gates device loss).
      if (!this.aoPipeline) {
        // options.ao is present whenever aoActive() is true (it gates on options.ao?.enabled).
        this.aoPipeline = buildAoPostProcessing(renderer, scene, camera, this.options.ao!);
      }
      void this.aoPipeline.render();
      return;
    }
    // AO off → the direct, zero-post-process path.
    void renderer.render(scene, camera);
  }

  /** Live `ao` debug-flag toggle (plumbed from debugViewStore through RendererHost). Combined with the
   *  per-tier config base; turning AO off keeps the built pipeline cached so re-enabling is cheap. */
  setAoEnabled(enabled: boolean): void {
    this.aoRuntimeEnabled = enabled;
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
    this.aoPipeline?.dispose();
    this.aoPipeline = null;
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
