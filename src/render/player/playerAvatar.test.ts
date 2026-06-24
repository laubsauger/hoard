// T127 — the rigged player avatar's PURE decision layer: the state→clip mapping + the one-shot controller.
// No GPU/DOM (the AnimationMixer wiring is exercised in the in-browser CDP check, not here).

import { describe, it, expect } from 'vitest';
import {
  selectClip,
  OneShotController,
  RANGER_FORWARD_YAW_OFFSET,
  type AvatarSelectInputs,
} from './playerAvatar';

const base: AvatarSelectInputs = {
  moving: false,
  sprinting: false,
  crouching: false,
  dead: false,
  hitActive: false,
  emoteActive: false,
};

describe('selectClip — state → clip mapping (T127)', () => {
  it('idles when standing still', () => {
    expect(selectClip(base)).toBe('Idle_3');
  });

  it('walks when moving, runs when sprinting + moving', () => {
    expect(selectClip({ ...base, moving: true })).toBe('Walking');
    expect(selectClip({ ...base, moving: true, sprinting: true })).toBe('Running');
    // sprint key held but not moving → still idle (no run-in-place)
    expect(selectClip({ ...base, sprinting: true })).toBe('Idle_3');
  });

  it('crouch-walks when crouching + moving, idles when crouching + still (no crouch-idle clip)', () => {
    expect(selectClip({ ...base, crouching: true, moving: true })).toBe('Crouch_Walk_with_Torch');
    expect(selectClip({ ...base, crouching: true })).toBe('Idle_3');
    // crouch takes precedence over sprint (you cannot sprint crouched)
    expect(selectClip({ ...base, crouching: true, moving: true, sprinting: true })).toBe('Crouch_Walk_with_Torch');
  });

  it('hit reaction overrides locomotion', () => {
    expect(selectClip({ ...base, hitActive: true })).toBe('Hit_Reaction_1');
    expect(selectClip({ ...base, hitActive: true, moving: true, sprinting: true })).toBe('Hit_Reaction_1');
  });

  it('emote overrides hit + locomotion', () => {
    expect(selectClip({ ...base, emoteActive: true })).toBe('push_up');
    expect(selectClip({ ...base, emoteActive: true, hitActive: true, moving: true })).toBe('push_up');
  });

  it('dead holds Dead above everything', () => {
    expect(selectClip({ ...base, dead: true })).toBe('Dead');
    expect(selectClip({ ...base, dead: true, emoteActive: true, hitActive: true, moving: true, sprinting: true })).toBe('Dead');
  });
});

describe('OneShotController — one-shot lifecycle (T127)', () => {
  it('starts idle (no active one-shot)', () => {
    const c = new OneShotController();
    expect(c.current).toBeNull();
    expect(c.flags).toEqual({ hitActive: false, emoteActive: false });
  });

  it('requesting hit/emote sets the matching flag', () => {
    const c = new OneShotController();
    c.request('hit');
    expect(c.current).toBe('hit');
    expect(c.flags).toEqual({ hitActive: true, emoteActive: false });
    c.request('emote');
    expect(c.current).toBe('emote');
    expect(c.flags).toEqual({ hitActive: false, emoteActive: true });
  });

  it('finishing the active one-shot clears it; finishing a stale kind does not', () => {
    const c = new OneShotController();
    c.request('emote');
    c.finish('hit'); // stale — emote is active
    expect(c.current).toBe('emote');
    c.finish('emote');
    expect(c.current).toBeNull();
    expect(c.flags).toEqual({ hitActive: false, emoteActive: false });
  });

  it('a fresh request overrides an active one-shot and bumps version (re-trigger)', () => {
    const c = new OneShotController();
    const v0 = c.version;
    c.request('hit');
    const v1 = c.version;
    expect(v1).toBeGreaterThan(v0);
    c.request('hit'); // same kind re-triggered
    expect(c.version).toBeGreaterThan(v1);
    expect(c.current).toBe('hit');
  });

  it('a hit during an emote overrides to the hit', () => {
    const c = new OneShotController();
    c.request('emote');
    c.request('hit');
    expect(c.current).toBe('hit');
    expect(c.flags.hitActive).toBe(true);
  });
});

describe('forward yaw offset', () => {
  it('is a quarter turn (the Ranger bind pose faces +Z; V41 single-sourced heading)', () => {
    expect(RANGER_FORWARD_YAW_OFFSET).toBeCloseTo(Math.PI / 2, 6);
  });
});
