// V86 — player CROUCH stance: the sneak key lowers the player eye height, which the see-over sight model
// (V85) consumes as its dynamic threshold so a crouched player sees over LESS and is symmetrically hidden
// behind low cover. This drives the REAL GameRuntime wiring (setCrouch → playerEyeHeight). The full
// crouched-behind-a-fence occlusion is exercised in-browser; the height DECISION is unit-tested in
// propSolidity.test.ts (propOccludesSight at standing vs crouch eye heights).
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildCityBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { resolveDomain } from '@/config/registry';
import { perceptionConfig } from '@/config/domains/perception';

const TIER = 'desktop-high' as const;

function makeRuntime(): GameRuntime {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildCityBlock() });
}

describe('player crouch stance + eye height (V86)', () => {
  it('playerEyeHeight drops to the crouch height while crouched and returns to standing when released', () => {
    const rt = makeRuntime();
    const p = resolveDomain(perceptionConfig, TIER);
    expect(p.crouchEyeHeightMeters).toBeLessThan(p.eyeHeightMeters); // config sanity — crouch is lower

    expect(rt.playerEyeHeight()).toBeCloseTo(p.eyeHeightMeters); // standing by default

    rt.setCrouch(true);
    expect(rt.playerEyeHeight()).toBeCloseTo(p.crouchEyeHeightMeters); // crouched → lower eye
    expect(rt.playerEyeHeight()).toBeLessThan(p.eyeHeightMeters);

    rt.setCrouch(false);
    expect(rt.playerEyeHeight()).toBeCloseTo(p.eyeHeightMeters); // released → back to standing
  });

  it('crouching below the sill HIDES the player through a glassed window; standing is seen (V87)', () => {
    const rt = makeRuntime();
    // Approach the window nearest the spawn, then clear it to a see-through glassless hole.
    const spawn = rt.player();
    let win = rt.windowViews()[0]!;
    let best = Infinity;
    for (const w of rt.windowViews()) {
      const d = Math.hypot(w.x - spawn.x, w.z - spawn.z);
      if (d < best) { best = d; win = w; }
    }
    for (let i = 0; i < 2000; i++) {
      const pp = rt.player();
      const dx = win.x - pp.x;
      const dz = win.z - pp.z;
      if (Math.hypot(dx, dz) <= 2.0) break;
      rt.movePlayer(dx, dz, 0.05);
    }
    while (rt.unboardNearestWindow()) {
      /* strip every board → a glassless opening */
    }
    rt.smashNearestWindow(); // ensure the pane is gone (no-op if already broken) — unambiguously see-through

    // STANDING: eye (1.6) is within the window opening band → see THROUGH the window.
    rt.setCrouch(false);
    expect(rt.isWindowSeeThrough(win.cx, win.cy)).toBe(true);
    // CROUCHED: eye drops BELOW the sill → the wall below the window hides the player (V87).
    rt.setCrouch(true);
    expect(rt.isWindowSeeThrough(win.cx, win.cy)).toBe(false);
    // back up to standing → seen again (no latching).
    rt.setCrouch(false);
    expect(rt.isWindowSeeThrough(win.cx, win.cy)).toBe(true);
  });
});
