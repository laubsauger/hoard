// T4 / V1 / V11 — store selector firing, snapshot consumption, throttle gate, persistence partition.

import { describe, it, expect } from 'vitest';
import { createUiStore } from './ui';
import { createSessionStore } from './session';
import { createPlayerViewStore as makePlayerView } from './playerView';
import { createSettingsStore } from './settings';
import { createThrottledPublisher } from './throttle';
import type { PlayerViewSnapshot, EntityId } from '../game/core/contracts';

describe('subscribeWithSelector fires only on relevant change (V11)', () => {
  it('does not notify a selector subscription for unrelated state changes', () => {
    const store = createUiStore();
    let calls = 0;
    const unsub = store.subscribe(
      (s) => s.hudVisible,
      () => {
        calls += 1;
      },
    );
    store.getState().setLoadingProgress(0.5); // unrelated
    expect(calls).toBe(0);
    store.getState().setHudVisible(false); // relevant
    expect(calls).toBe(1);
    store.getState().setHudVisible(false); // no value change
    expect(calls).toBe(1);
    unsub();
  });
});

describe('player-view store consumes PlayerViewSnapshot (V1)', () => {
  it('stores the published snapshot and exposes narrow fields', () => {
    const store = makePlayerView();
    const snap: PlayerViewSnapshot = {
      entity: 7 as unknown as EntityId,
      health: 82,
      bleeding: 1,
      pain: 0,
      hunger: 40,
      thirst: 30,
      fatigue: 20,
      stress: 12,
      encumbrance: 5,
    };
    store.getState().applySnapshot(snap);
    expect(store.getState().snapshot?.health).toBe(82);
    store.getState().clear();
    expect(store.getState().snapshot).toBeNull();
  });
});

describe('throttled snapshot publisher (V11)', () => {
  it('emits leading edge, coalesces within interval, flushes pending', () => {
    let t = 0;
    const out: number[] = [];
    const { push, flushPending } = createThrottledPublisher<number>((v) => out.push(v), 100, () => t);
    push(1); // t=0 leading edge -> emit
    push(2); // within interval -> pending
    t = 50;
    push(3); // pending (latest)
    t = 100;
    push(4); // interval elapsed -> emit latest
    expect(out).toEqual([1, 4]);
    t = 120;
    push(5); // within interval -> pending
    t = 300;
    flushPending(); // force deliver coalesced
    expect(out).toEqual([1, 4, 5]);
  });

  it('rejects an invalid interval', () => {
    expect(() => createThrottledPublisher<number>(() => {}, -1)).toThrow();
  });
});

describe('persistence partition (V11 — only settings + session persist)', () => {
  it('session and settings stores expose the persist API', () => {
    expect('persist' in createSessionStore()).toBe(true);
    expect('persist' in createSettingsStore()).toBe(true);
  });

  it('transient view stores do NOT persist', () => {
    expect('persist' in createUiStore()).toBe(false);
    expect('persist' in makePlayerView()).toBe(false);
  });

  it('session persists only identity + slot (not transient phase)', () => {
    const store = createSessionStore();
    const opts = store.persist.getOptions();
    expect(opts.name).toContain('session');
    const partial = opts.partialize?.(store.getState()) as Record<string, unknown>;
    expect(Object.keys(partial).sort()).toEqual(['saveSlot', 'sessionId']);
    expect('phase' in partial).toBe(false);
  });

  it('settings persist under the settings partition', () => {
    const store = createSettingsStore();
    expect(store.persist.getOptions().name).toContain('settings');
  });
});

describe('audio volume buses (master / sound / music) — settings store', () => {
  it('exposes three independent volume primitives; master MUTED by default (headless-safe)', () => {
    const s = createSettingsStore().getState();
    // Sound is off by default (master 0) so headless/CDP + fresh sessions are silent; player raises it.
    expect(s.masterVolume).toBe(0);
    // The bus levels under master are preserved so unmuting restores a sensible mix.
    expect(s.sfxVolume).toBe(0.8);
    expect(s.musicVolume).toBe(0.5);
  });

  it('each setter clamps to 0..1 and writes only its own field', () => {
    const store = createSettingsStore();
    store.getState().setMasterVolume(2);
    store.getState().setSfxVolume(-1);
    store.getState().setMusicVolume(0.33);
    const s = store.getState();
    expect(s.masterVolume).toBe(1);
    expect(s.sfxVolume).toBe(0);
    expect(s.musicVolume).toBe(0.33);
  });

  it('rejects a non-finite volume (no silent fallback)', () => {
    const store = createSettingsStore();
    expect(() => store.getState().setMusicVolume(Number.NaN)).toThrow();
  });
});
