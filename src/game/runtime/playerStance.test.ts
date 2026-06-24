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
});
