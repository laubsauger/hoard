// T5 / V24 — resource ownership/disposal registry: disposes everything + detects leaks.

import { describe, it, expect } from 'vitest';
import { ResourceRegistry, type Disposable } from './resources';

function fake(): Disposable & { disposed: number } {
  return {
    disposed: 0,
    dispose() {
      this.disposed += 1;
    },
  };
}

describe('ResourceRegistry (V24)', () => {
  it('tracks and disposes a single resource, then stops tracking it', () => {
    const reg = new ResourceRegistry();
    const r = fake();
    reg.track(r, 'geometry', 'g0');
    expect(reg.size).toBe(1);
    reg.dispose(r);
    expect(r.disposed).toBe(1);
    expect(reg.size).toBe(0);
  });

  it('disposeAll disposes every tracked resource', () => {
    const reg = new ResourceRegistry();
    const a = fake();
    const b = fake();
    reg.track(a, 'texture', 'a');
    reg.track(b, 'material', 'b');
    reg.disposeAll();
    expect(a.disposed).toBe(1);
    expect(b.disposed).toBe(1);
    expect(reg.size).toBe(0);
  });

  it('reports leaks and assertNoLeaks throws while resources remain', () => {
    const reg = new ResourceRegistry();
    reg.track(fake(), 'buffer', 'leaky');
    expect(reg.leaks()).toEqual(['buffer:leaky']);
    expect(() => reg.assertNoLeaks()).toThrow(/resource leak/);
    reg.disposeAll();
    expect(() => reg.assertNoLeaks()).not.toThrow();
  });

  it('rejects double-tracking the same instance', () => {
    const reg = new ResourceRegistry();
    const r = fake();
    reg.track(r, 'geometry', 'g');
    expect(() => reg.track(r, 'geometry', 'g-again')).toThrow(/already tracked/);
  });

  it('counts resources per kind for diagnostics', () => {
    const reg = new ResourceRegistry();
    reg.track(fake(), 'geometry', 'g1');
    reg.track(fake(), 'geometry', 'g2');
    reg.track(fake(), 'texture', 't1');
    expect(reg.counts().geometry).toBe(2);
    expect(reg.counts().texture).toBe(1);
    expect(reg.counts().material).toBe(0);
  });
});
