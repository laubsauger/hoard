// T5 / V23 / V24 — WebGPU renderer lifecycle behind a thin boundary so logic is testable WITHOUT a GPU.
// The real `new WebGPURenderer()` call lives in ./webgpuBackend.ts and is reached ONLY through an injected
// factory. Tests pass a fake backend; this host never constructs a GPU object itself.

import type { Camera, Scene } from 'three';
import type { ComputeNode } from 'three/webgpu';
import { ResourceRegistry } from './resources';

/** Output tone-mapping operator (B6). Mapped to three's tone-mapping constants inside the WebGPU backend. */
export type ToneMappingMode = 'aces' | 'agx' | 'neutral' | 'none';

/** Minimal renderer surface the host needs. The real WebGPU backend adapts three's WebGPURenderer. */
export interface RendererBackend {
  /** Async device/adapter init (R4). */
  init(): Promise<void>;
  render(scene: Scene, camera: Camera): void;
  /** Set the output tone-mapping operator + exposure (B6). The exposure is updated per frame for the
   *  interior/night compensation; the operator rarely changes. */
  setToneMapping(mode: ToneMappingMode, exposure: number): void;
  /** Run a TSL compute node before rendering (e.g. the crowd transform/animation pass). Optional so the
   *  non-GPU test fake need not implement it; the WebGPU backend forwards to renderer.compute(). */
  compute?(node: ComputeNode): void;
  setSize(width: number, height: number): void;
  setPixelRatio(ratio: number): void;
  /** Register a device-loss listener; returns an unsubscribe fn (V23). */
  onDeviceLost(cb: (reason: string) => void): () => void;
  dispose(): void;
}

export type RendererBackendFactory = () => RendererBackend;

export type HostStatus = 'created' | 'initializing' | 'ready' | 'recovering' | 'shutdown';

export interface HostEvents {
  status: (status: HostStatus) => void;
  deviceLost: (reason: string) => void;
  recovered: (recoveryCount: number) => void;
  /** Session-safe shutdown after exhausting recovery budget (V23). */
  fatal: (reason: string) => void;
}

type Listener<E extends keyof HostEvents> = HostEvents[E];

/**
 * Owns the renderer backend lifecycle + the resource registry (V24) + device-loss recovery (V23).
 * `maxRecoveries` from rendering config (V4). No magic numbers.
 */
export class RendererHost {
  readonly resources = new ResourceRegistry();
  private backend: RendererBackend | null = null;
  private readonly factory: RendererBackendFactory;
  private readonly maxRecoveries: number;
  private _status: HostStatus = 'created';
  private recoveryCount = 0;
  private unsubLoss: (() => void) | null = null;
  private readonly listeners: { [K in keyof HostEvents]: Set<Listener<K>> } = {
    status: new Set(),
    deviceLost: new Set(),
    recovered: new Set(),
    fatal: new Set(),
  };

  constructor(opts: { factory: RendererBackendFactory; maxRecoveries: number }) {
    if (!Number.isInteger(opts.maxRecoveries) || opts.maxRecoveries < 0) {
      throw new Error(`maxRecoveries must be a non-negative integer, got ${opts.maxRecoveries}`);
    }
    this.factory = opts.factory;
    this.maxRecoveries = opts.maxRecoveries;
  }

  get status(): HostStatus {
    return this._status;
  }

  on<E extends keyof HostEvents>(event: E, cb: HostEvents[E]): () => void {
    this.listeners[event].add(cb);
    return () => this.listeners[event].delete(cb);
  }

  private emitStatus(status: HostStatus): void {
    this._status = status;
    for (const cb of this.listeners.status) cb(status);
  }

  async init(): Promise<void> {
    if (this._status === 'ready' || this._status === 'initializing') return;
    this.emitStatus('initializing');
    this.backend = this.factory();
    await this.backend.init();
    this.unsubLoss = this.backend.onDeviceLost((reason) => {
      void this.handleDeviceLost(reason);
    });
    this.emitStatus('ready');
  }

  render(scene: Scene, camera: Camera): void {
    if (this._status !== 'ready' || !this.backend) return; // controlled: skip frames while recovering
    this.backend.render(scene, camera);
  }

  /** Run a TSL compute pass (e.g. crowd transform assembly) before the frame's render. Skipped while not
   *  ready, mirroring render()'s controlled device-loss handling (V23). */
  compute(node: ComputeNode): void {
    if (this._status !== 'ready' || !this.backend) return;
    this.backend.compute?.(node);
  }

  setSize(width: number, height: number): void {
    this.backend?.setSize(width, height);
  }

  /** Apply the output tone-mapping operator + exposure (B6). No-op until a backend is ready. */
  setToneMapping(mode: ToneMappingMode, exposure: number): void {
    this.backend?.setToneMapping(mode, exposure);
  }

  setPixelRatio(ratio: number): void {
    this.backend?.setPixelRatio(ratio);
  }

  /**
   * Controlled device-loss recovery (V23): dispose the dead backend, re-init a fresh one up to the
   * configured budget. GPU resources are owned per-frame by their producers and re-tracked on recreate;
   * the registry is cleared so re-created resources do not double-count. Exhausting the budget triggers
   * a session-safe fatal shutdown instead of an unpredictable drop.
   */
  async handleDeviceLost(reason: string): Promise<void> {
    for (const cb of this.listeners.deviceLost) cb(reason);
    this.emitStatus('recovering');
    this.unsubLoss?.();
    this.unsubLoss = null;
    this.backend?.dispose();
    this.backend = null;
    this.resources.disposeAll();

    if (this.recoveryCount >= this.maxRecoveries) {
      this.emitStatus('shutdown');
      for (const cb of this.listeners.fatal) cb(`device lost; recovery budget (${this.maxRecoveries}) exhausted: ${reason}`);
      return;
    }
    this.recoveryCount += 1;
    this.backend = this.factory();
    await this.backend.init();
    this.unsubLoss = this.backend.onDeviceLost((r) => {
      void this.handleDeviceLost(r);
    });
    this.emitStatus('ready');
    for (const cb of this.listeners.recovered) cb(this.recoveryCount);
  }

  get recoveries(): number {
    return this.recoveryCount;
  }

  dispose(): void {
    this.unsubLoss?.();
    this.unsubLoss = null;
    this.backend?.dispose();
    this.backend = null;
    this.resources.disposeAll();
    this.emitStatus('shutdown');
  }
}
