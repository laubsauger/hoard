// T40 — the DIEGETIC radio objective loop on the GameRuntime: scavenge parts into the pack → install them at the
// world radio → channel the repair (time passes) → call evacuation (arms the climax). This replaces the old
// debug-button path (objective.collectPart/repair/advance) with the real install/repair/call methods the
// interaction wheel drives (V1). Proves the loop is solvable end-to-end with the runtime-seeded parts.

import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildCityDistrict } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { ITEM } from '@/game/inventory';

const TIER = 'desktop-high' as const;

function makeRuntime() {
  const district = buildCityDistrict(TIER);
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: district.block, sectors: district.sectors });
}

/** Pull every runtime-seeded Radio Part out of the world containers into the player's pack (the "scavenge" step). */
function scavengeParts(rt: GameRuntime): number {
  for (const c of rt.inventorySnapshot()) {
    if (c.container === 'player' || c.equipSlot) continue;
    if (c.slots.some((s) => s.item === ITEM.RadioPart)) rt.transferItem(c.container, 'player', ITEM.RadioPart);
  }
  const player = rt.inventorySnapshot().find((c) => c.container === 'player');
  return player?.slots.find((s) => s.item === ITEM.RadioPart)?.count ?? 0;
}

/** Advance sim time until `done()` or a step budget runs out. */
function stepUntil(rt: GameRuntime, done: () => boolean, maxSteps = 2000): void {
  for (let i = 0; i < maxSteps && !done(); i++) rt.update(0.05);
}

describe('T40 diegetic radio objective loop', () => {
  it('seeds the radio hub + at least the required parts in the world', () => {
    const rt = makeRuntime();
    const required = rt.objective.snapshot(0).partsRequired;

    const radio = rt.interactables().find((t) => t.kind === 'radio');
    expect(radio).toBeDefined();
    expect(radio!.radioStage).toBe('collect');

    expect(scavengeParts(rt)).toBeGreaterThanOrEqual(required);
  });

  it('installs parts → repairs (channeled, time passes) → calls evacuation (arms the climax)', () => {
    const rt = makeRuntime();
    const required = rt.objective.snapshot(0).partsRequired;
    expect(scavengeParts(rt)).toBeGreaterThanOrEqual(required);

    // INSTALL: the player stands at the radio (anchored nearest spawn) and installs every required part. The last
    // install auto-advances the FSM to the repair phase.
    for (let i = 0; i < required; i++) expect(rt.installRadioPart()).toBe(true);
    expect(rt.objective.currentPhase).toBe('repairRadio');
    // No more parts to install once past the collect stage.
    expect(rt.installRadioPart()).toBe(false);

    // REPAIR: a channel (the player carries a hammer from the starter loadout). Progress accrues only while time
    // passes — one toggle then ticks, NOT an instant button.
    expect(rt.isRepairing()).toBe(false);
    expect(rt.toggleRadioRepair()).toBe(true);
    expect(rt.isRepairing()).toBe(true);
    stepUntil(rt, () => rt.objective.currentPhase === 'callEvacuation');
    expect(rt.objective.currentPhase).toBe('callEvacuation');
    expect(rt.isRepairing()).toBe(false); // the channel ended when the work completed

    // CALL: arms the decisive horde event + starts the evacuation countdown (the climax).
    expect(rt.hordeEvent.currentPhase).toBe('idle');
    expect(rt.callEvacuation()).toBe(true);
    expect(rt.objective.currentPhase).toBe('evacuating');
    expect(rt.hordeEvent.currentPhase).toBe('building');
  });

  it('refuses to install with no part carried, and to repair before parts are in', () => {
    const rt = makeRuntime();
    expect(rt.installRadioPart()).toBe(false); // nothing carried yet
    expect(rt.toggleRadioRepair()).toBe(false); // still in the collect stage
    expect(rt.callEvacuation()).toBe(false); // not yet at the call stage
  });
});
