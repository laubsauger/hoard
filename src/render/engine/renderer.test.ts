// T5 / V23 / V24 — renderer host lifecycle: device-loss recovery within budget then session-safe shutdown.
// Uses a fake backend so no GPU is constructed (the boundary that makes the host testable).

import { describe, it, expect } from 'vitest';
import { RendererHost, type RendererBackend } from './renderer';
import type { Camera, Scene } from 'three';

class FakeBackend implements RendererBackend {
  initCalls = 0;
  renderCalls = 0;
  disposed = false;
  lossCb: ((reason: string) => void) | null = null;
  async init(): Promise<void> {
    this.initCalls += 1;
  }
  render(): void {
    this.renderCalls += 1;
  }
  toneMappingCalls = 0;
  setToneMapping(): void {
    this.toneMappingCalls += 1;
  }
  setSize(): void {}
  setPixelRatio(): void {}
  onDeviceLost(cb: (reason: string) => void): () => void {
    this.lossCb = cb;
    return () => {
      this.lossCb = null;
    };
  }
  dispose(): void {
    this.disposed = true;
  }
}

const scene = {} as Scene;
const camera = {} as Camera;

describe('RendererHost (V23/V24)', () => {
  it('initializes a backend and becomes ready', async () => {
    const backends: FakeBackend[] = [];
    const host = new RendererHost({
      factory: () => {
        const b = new FakeBackend();
        backends.push(b);
        return b;
      },
      maxRecoveries: 2,
    });
    await host.init();
    expect(host.status).toBe('ready');
    expect(backends[0]!.initCalls).toBe(1);
  });

  it('skips render while not ready (controlled path, V23)', () => {
    const host = new RendererHost({ factory: () => new FakeBackend(), maxRecoveries: 1 });
    host.render(scene, camera); // not initialized
    expect(host.status).toBe('created');
  });

  it('recovers from device loss within budget, then shuts down session-safely', async () => {
    const backends: FakeBackend[] = [];
    const host = new RendererHost({
      factory: () => {
        const b = new FakeBackend();
        backends.push(b);
        return b;
      },
      maxRecoveries: 2,
    });
    let fatal = '';
    let recoveries = 0;
    host.on('recovered', (n) => (recoveries = n));
    host.on('fatal', (r) => (fatal = r));
    await host.init();

    await host.handleDeviceLost('loss-1');
    expect(host.status).toBe('ready');
    expect(host.recoveries).toBe(1);

    await host.handleDeviceLost('loss-2');
    expect(host.status).toBe('ready');
    expect(host.recoveries).toBe(2);
    expect(recoveries).toBe(2);

    await host.handleDeviceLost('loss-3'); // budget exhausted
    expect(host.status).toBe('shutdown');
    expect(fatal).toMatch(/recovery budget/);
  });

  it('disposes the resource registry on device loss (V24)', async () => {
    const host = new RendererHost({ factory: () => new FakeBackend(), maxRecoveries: 1 });
    await host.init();
    let disposed = 0;
    host.resources.track({ dispose: () => (disposed += 1) }, 'buffer', 'frame-buffer');
    await host.handleDeviceLost('loss');
    expect(disposed).toBe(1);
    expect(host.resources.size).toBe(0);
  });

  it('rejects an invalid recovery budget', () => {
    expect(() => new RendererHost({ factory: () => new FakeBackend(), maxRecoveries: -1 })).toThrow();
  });
});
