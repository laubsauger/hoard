// Phase 3 (GameViewport decomposition): renderer-host lifecycle for the world viewport.
// Owns RendererHost construction, the guarded async init (device-loss recovery count from config),
// the window resize listener, and the dev-only stats.js perf meter. The host is constructed and
// assigned by the caller BEFORE init is awaited, so the effect's cleanup can always dispose it — the
// same lifecycle the single effect had inline (V24).

import Stats from 'stats.js';
import { RendererHost, createWebGpuBackendFactory, type CameraRig } from '../../render/engine';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import { sessionStore } from '../../stores/session';

/**
 * Dev-only real-time perf meter (FPS / frame-ms / heap) over the live WebGPU frame loop. Established
 * stats.js panel, mounted top-right; click the panel to cycle FPS↔MS↔MB. Never ships to players
 * (gated on `import.meta.env.DEV`). True GPU-timestamp timing needs the engine to expose its
 * `WebGPURenderer`; until then this measures the real per-frame wall-clock of update+compute+render.
 */
export function createDevStats(): Stats | null {
  if (!import.meta.env.DEV) return null;
  const stats = new Stats();
  stats.showPanel(0); // 0 = fps, 1 = ms, 2 = mb
  const dom = stats.dom;
  // z-index BELOW the UI modals (HUD 20 / pause 60 / settings 80) so the dev meter never overlaps a panel's
  // controls (e.g. the settings close button, top-right). Visible during play; any open modal covers it.
  dom.style.cssText = 'position:fixed;top:8px;right:8px;left:auto;z-index:15;cursor:pointer;';
  document.body.appendChild(dom);
  return stats;
}

/** Construct the renderer host behind the isolated WebGPU backend boundary (no init yet). */
export function createRendererHost(canvas: HTMLCanvasElement, tier: QualityTier): RendererHost {
  return new RendererHost({
    factory: createWebGpuBackendFactory({ canvas }),
    maxRecoveries: resolve(renderingConfig.deviceLossMaxRecoveries, tier),
  });
}

/**
 * Await the guarded host init. Returns true when the host is ready to drive frames. On failure it
 * reports cleanly (session phase → error + onError) unless the effect was already cancelled; on a
 * cancel that races a successful init it disposes the freshly-initialised host. The caller must have
 * already assigned `host` to its outer binding so unmount cleanup can dispose it (V24).
 */
export async function startRendererHost(
  host: RendererHost,
  opts: { onError?: ((message: string) => void) | undefined; isCancelled: () => boolean },
): Promise<boolean> {
  try {
    await host.init();
  } catch (err) {
    if (opts.isCancelled()) return false;
    sessionStore.getState().setPhase('error');
    opts.onError?.(`WebGPU renderer failed to initialise: ${(err as Error).message}`);
    return false;
  }
  if (opts.isCancelled()) {
    host.dispose();
    return false;
  }
  return true;
}

/**
 * Install the window resize listener (also fired once immediately): host backbuffer size + clamped
 * pixel ratio + camera aspect. Returns the cleanup that removes the listener.
 */
export function attachResize(
  canvas: HTMLCanvasElement,
  host: RendererHost,
  camera: CameraRig,
  tier: QualityTier,
): () => void {
  const resize = (): void => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    host.setSize(w, h);
    host.setPixelRatio(Math.min(window.devicePixelRatio, resolve(renderingConfig.pixelRatioMax, tier)));
    camera.setAspect(w / h);
  };
  resize();
  window.addEventListener('resize', resize);
  return () => window.removeEventListener('resize', resize);
}
