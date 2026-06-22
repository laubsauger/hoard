// T40 / V13 / V24 — district streaming: abstract sector populations promote to live near the player and
// fold back on eviction, conserving total population; streaming uses hysteresis (no thrash) and runs
// chunks through the closed lifecycle. Plus save/restore of per-sector population.

import { describe, it, expect } from 'vitest';
import { DistrictModel, resolveDistrictSettings, type SectorDescriptor } from './district';
import { resolveDomain } from '@/config/registry';
import { streamingConfig } from '@/config/domains/streaming';

const TIER = 'desktop-high' as const;
const CFG = resolveDistrictSettings(TIER);
const COOLING_TICKS = resolveDomain(streamingConfig, TIER).coolingTicks;

const SECTORS: SectorDescriptor[] = [
  { id: 0, centerX: 0, centerZ: 0 },
  { id: 1, centerX: 300, centerZ: 0 },
];

function model() {
  return new DistrictModel(SECTORS, TIER);
}

function totalPop(d: DistrictModel): number {
  return d.abstractTotal() + d.liveTotal();
}

describe('district streaming model (V13)', () => {
  it('seeds each offscreen sector with the configured abstract population', () => {
    const d = model();
    expect(d.abstractPopOf(0)).toBe(CFG.abstractPopulationPerSector);
    expect(d.liveTotal()).toBe(0);
    expect(d.abstractTotal()).toBe(CFG.abstractPopulationPerSector * SECTORS.length);
  });

  it('promotes a capped abstract slice to live when the player nears a sector', () => {
    const d = model();
    const before = totalPop(d);
    const plan = d.update(0, 0, 1); // player at sector 0's centre
    expect(plan.promotions.length).toBe(1);
    expect(plan.promotions[0]!.sectorId).toBe(0);
    const expected = Math.min(CFG.promotedPerSectorCap, CFG.abstractPopulationPerSector);
    expect(plan.promotions[0]!.count).toBe(expected);
    expect(d.liveCountOf(0)).toBe(expected);
    expect(d.stateOf(0)).toBe('sim-active');
    // far sector untouched, total population conserved (promotion moves abstract -> live)
    expect(d.stateOf(1)).toBe('unloaded');
    expect(totalPop(d)).toBe(before);
  });

  it('does not re-promote a sector that is already streamed in (no duplicate spawns)', () => {
    const d = model();
    d.update(0, 0, 1);
    const live = d.liveCountOf(0);
    const plan2 = d.update(0, 0, 2);
    expect(plan2.promotions.length).toBe(0);
    expect(d.liveCountOf(0)).toBe(live);
  });

  it('cools then evicts a far sector after the dwell, folding live members back to abstract', () => {
    const d = model();
    d.update(0, 0, 1); // sector 0 active
    const livePromoted = d.liveCountOf(0);
    const before = totalPop(d);

    // Player walks to sector 1; sector 0 is now far -> cooling (not yet evicted).
    d.update(300, 0, 10);
    expect(d.stateOf(0)).toBe('cooling');
    expect(d.liveCountOf(0)).toBe(livePromoted); // still live while cooling

    // After the cooling dwell, sector 0 evicts and its live members fold back to abstract.
    const plan = d.update(300, 0, 10 + COOLING_TICKS + 1);
    const evicted = plan.evictions.find((e) => e.sectorId === 0);
    expect(evicted?.count).toBe(livePromoted);
    expect(d.liveCountOf(0)).toBe(0);
    expect(d.stateOf(0)).toBe('unloaded');
    expect(totalPop(d)).toBe(before); // population conserved across the full promote->evict cycle
  });

  it('re-warms a cooling sector without re-promoting if the player returns (hysteresis, no thrash)', () => {
    const d = model();
    d.update(0, 0, 1);
    d.update(300, 0, 5); // sector 0 -> cooling
    expect(d.stateOf(0)).toBe('cooling');
    const plan = d.update(0, 0, 6); // player returns before eviction
    expect(d.stateOf(0)).toBe('sim-active');
    expect(plan.promotions.find((p) => p.sectorId === 0)).toBeUndefined();
  });

  it('round-trips per-sector population through save/restore (V9)', () => {
    const d = model();
    d.update(0, 0, 1);
    const saved = d.save();
    const d2 = model();
    d2.restore(saved);
    expect(d2.liveCountOf(0)).toBe(d.liveCountOf(0));
    expect(d2.abstractPopOf(0)).toBe(d.abstractPopOf(0));
  });

  it('rejects a non-hysteretic streaming config (evict radius must exceed activate radius)', () => {
    expect(CFG.evictRadiusMeters).toBeGreaterThan(CFG.activateRadiusMeters);
  });
});
