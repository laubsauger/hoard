// PLAYER PERCEPTION v2 (V62/V63) — reveal combination + recently-seen memory (render-side, no sim state).
// Covers: near-proximity awareness (req 2), recently-seen memory fade (req 3), noise awareness (req 4), and the
// CRITICAL invariant that the reveal is gated on STRUCTURAL line-of-sight, never mesh opacity (req 7).

import { describe, it, expect } from 'vitest';
import { instantaneousReveal, PerceptionMemory, type RevealParams } from './perceptionMemory';

const HALF = Math.PI / 4; // 45° half-angle forward wedge (heading +x)

// Player at origin facing +x. A clear-LOS world by default; pass `block` to make every LOS test return false.
function params(over: Partial<RevealParams> = {}, block = false): RevealParams {
  return {
    px: 0,
    pz: 0,
    heading: 0,
    fovHalf: HALF,
    range: 18,
    edgeBandMeters: 3,
    edgeBandRadians: 0.2,
    nearRadiusMeters: 4,
    hearingRange: 40,
    soundWallOcclusion: 0.3,
    lineOfSight: () => !block,
    ...over,
  };
}

describe('near-proximity awareness (V62 req 2)', () => {
  it('reveals a zombie 2m BEHIND the player (outside the cone) with clear LOS', () => {
    // (-2,0) is directly behind a +x-facing player → outside the forward wedge, but within the 4m near radius.
    const r = instantaneousReveal(-2, 0, false, params());
    expect(r).toBeGreaterThan(0);
    expect(r).toBe(1); // full near reveal
  });

  it('does NOT reveal the same close-but-behind zombie when a wall blocks LOS', () => {
    expect(instantaneousReveal(-2, 0, false, params({}, true))).toBe(0);
  });

  it('does NOT reveal a behind zombie beyond the near radius (no cone, no noise)', () => {
    expect(instantaneousReveal(-6, 0, false, params())).toBe(0);
  });
});

describe('noise awareness (V62 req 4)', () => {
  it('gives a loud (pursuing) zombie just behind a wall within hearing a non-zero HEARD reveal', () => {
    // Behind the player AND wall-occluded (LOS blocked) — cone+near are 0, but it is LOUD and within hearing.
    const r = instantaneousReveal(-10, 0, true, params({}, true));
    expect(r).toBeGreaterThan(0);
    // Occluded → attenuated by soundWallOcclusion; strictly below the same heard reveal in the open.
    const open = instantaneousReveal(-10, 0, true, params());
    expect(r).toBeLessThan(open);
  });

  it('does NOT reveal a silent idle zombie beyond hearing range', () => {
    expect(instantaneousReveal(-60, 0, false, params())).toBe(0);
  });

  it('a silent idle zombie within hearing but behind a wall is NOT heard (only loud ones make noise)', () => {
    expect(instantaneousReveal(-10, 0, false, params({}, true))).toBe(0);
  });
});

describe('STRUCTURAL LOS gates the reveal, never mesh opacity (V63 req 7)', () => {
  it('an in-cone, in-range zombie is CULLED when structural LOS is blocked (faded wall still blocks)', () => {
    // (10,0) is dead-ahead and well within range → cone would reveal it, but a structurally-intact wall blocks LOS.
    expect(instantaneousReveal(10, 0, false, params())).toBeGreaterThan(0); // clear LOS → revealed
    expect(instantaneousReveal(10, 0, false, params({}, true))).toBe(0); // blocked LOS → culled
  });

  it('reveals a zombie seen through an OPEN gap (LOS callback returns clear) — the existing hasLineOfSight semantics', () => {
    // The reveal only ever consults the injected LOS callback (structural), so an open door/breach (clear path)
    // reveals while an intact wall does not. No coupling to render opacity exists in this code path.
    const open = instantaneousReveal(10, 0, false, params({ lineOfSight: () => true }));
    expect(open).toBeGreaterThan(0);
  });
});

describe('recently-seen memory fade (V62 req 3)', () => {
  it('keeps a once-revealed zombie revealed (fading) for < memorySeconds, then drops to 0', () => {
    const mem = new PerceptionMemory(4);
    const slot = 1;
    const memSeconds = 3;
    // Frame 0: fully revealed.
    expect(mem.step(slot, 1, 0.1, memSeconds)).toBe(1);
    // It leaves view (inst=0). It must still read > 0 while inside the memory window...
    const mid = mem.step(slot, 0, 1, memSeconds); // age = 1s of 3s
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    const later = mem.step(slot, 0, 1, memSeconds); // age = 2s of 3s
    expect(later).toBeGreaterThan(0);
    expect(later).toBeLessThan(mid); // ramps down monotonically
    // ...and 0 once the window has fully elapsed.
    const expired = mem.step(slot, 0, 2, memSeconds); // age = 4s > 3s
    expect(expired).toBe(0);
  });

  it('REFRESHES the memory when the zombie is seen again (brighter instantaneous reveal wins)', () => {
    const mem = new PerceptionMemory(2);
    mem.step(0, 1, 0.1, 3);
    mem.step(0, 0, 2, 3); // decayed partway
    expect(mem.step(0, 1, 0.1, 3)).toBe(1); // back in view → snaps to full
  });

  it('memorySeconds = 0 disables memory (no lingering reveal)', () => {
    const mem = new PerceptionMemory(1);
    mem.step(0, 1, 0.1, 0);
    expect(mem.step(0, 0, 0.001, 0)).toBe(0);
  });
});
