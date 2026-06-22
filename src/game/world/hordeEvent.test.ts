// T40 / §G — the decisive horde event PROVABLY plays differently based on what the player changed. This
// is the central-promise test: identical event machinery, different structural-modification state ->
// different routes, pressure and outcome. Also covers the derivation from a live StructuralModule.

import { describe, it, expect } from 'vitest';
import {
  evaluateHordeEvent,
  resolveHordeEventSettings,
  routeStatesFromModule,
  HordeEvent,
  type RouteState,
} from './hordeEvent';
import { StructuralModule } from '@/game/destruction';
import type { ModuleId } from '@/game/core/contracts';

const TIER = 'desktop-high' as const;
const S = resolveHordeEventSettings(TIER);

function routes(states: Array<Partial<RouteState>>): RouteState[] {
  return states.map((s, i) => ({ id: i, open: false, reinforced: false, burning: false, ...s }));
}

const REF = 100; // reference horde mass

describe('decisive horde event: same event, different player-shaped outcome (§G)', () => {
  it('all routes breached open -> OVERRUN; all reinforced -> CONTAINED', () => {
    const breachedAll = evaluateHordeEvent(
      { routes: routes([{ open: true }, { open: true }, { open: true }, { open: true }]), hordeSize: REF, referenceHordeSize: REF },
      S,
    );
    const reinforcedAll = evaluateHordeEvent(
      { routes: routes([{ reinforced: true }, { reinforced: true }, { reinforced: true }, { reinforced: true }]), hordeSize: REF, referenceHordeSize: REF },
      S,
    );

    expect(breachedAll.outcome).toBe('overrun');
    expect(reinforcedAll.outcome).toBe('contained');
    // The SAME machinery yields a strictly higher pressure for the breached layout — proves it differs.
    expect(breachedAll.totalPressure).toBeGreaterThan(reinforcedAll.totalPressure);
    expect(breachedAll.openRouteCount).toBe(4);
    expect(reinforcedAll.reinforcedRouteCount).toBe(4);
  });

  it('fire on an open breach reroutes the mass: lower pressure than the same breach unburnt', () => {
    const open = evaluateHordeEvent({ routes: routes([{ open: true }]), hordeSize: REF, referenceHordeSize: REF }, S);
    const openBurning = evaluateHordeEvent({ routes: routes([{ open: true, burning: true }]), hordeSize: REF, referenceHordeSize: REF }, S);
    expect(openBurning.totalPressure).toBeLessThan(open.totalPressure);
    expect(open.routePressures[0]!.flows).toBe(true); // mass flows through the open breach
    expect(openBurning.routePressures[0]!.flows).toBe(false); // fire reroutes it away
  });

  it('the dominant route is the open breach, not the reinforced wall', () => {
    const r = evaluateHordeEvent(
      { routes: routes([{ reinforced: true }, { open: true }, {}, { reinforced: true }]), hordeSize: REF, referenceHordeSize: REF },
      S,
    );
    expect(r.dominantRouteId).toBe(1);
  });

  it('a smaller horde mass scales pressure down (same layout)', () => {
    const full = evaluateHordeEvent({ routes: routes([{ open: true }]), hordeSize: REF, referenceHordeSize: REF }, S);
    const half = evaluateHordeEvent({ routes: routes([{ open: true }]), hordeSize: REF / 2, referenceHordeSize: REF }, S);
    expect(half.totalPressure).toBeLessThan(full.totalPressure);
  });
});

describe('decisive horde event: derivation from live structural state + lifecycle', () => {
  function moduleWith(cells: number): StructuralModule {
    const m = new StructuralModule({ id: 1 as ModuleId, sizeX: 1, sizeY: 1, sizeZ: cells, seed: 11 });
    for (let z = 0; z < cells; z++) m.addCell({ x: 0, y: 0, z, material: 'brick', family: 0, strength: 100 });
    return m;
  }

  it('reads open/reinforced/burning directly off the module the player modified', () => {
    const m = moduleWith(3);
    const hooks = { nextEventId: () => 0 as never, emit: () => {} };
    m.applyDamage(m.packCell(0, 0, 0), 1000, hooks); // breach cell 0
    m.reinforce(m.packCell(0, 0, 1), 50); // reinforce cell 1 above base
    const burning = new Set<number>([m.packCell(0, 0, 2)]);

    const rs = routeStatesFromModule(m, {
      cellCount: 3,
      packCell: (z) => m.packCell(0, 0, z),
      isBurning: (cell) => burning.has(cell),
    });
    expect(rs[0]!.open).toBe(true);
    expect(rs[1]!.reinforced).toBe(true);
    expect(rs[2]!.burning).toBe(true);
  });

  it('the lifecycle builds then resolves a terminal outcome', () => {
    const ev = new HordeEvent(S);
    expect(ev.currentPhase).toBe('idle');
    ev.arm(0);
    expect(ev.currentPhase).toBe('building');
    expect(ev.shouldResolve(0)).toBe(false);
    expect(ev.shouldResolve(S.buildupTicks)).toBe(true);
    const result = ev.resolve({ routes: routes([{ open: true }, { open: true }, { open: true }, { open: true }]), hordeSize: REF, referenceHordeSize: REF });
    expect(ev.currentPhase).toBe('resolved');
    expect(result.outcome).toBe('overrun');
    expect(ev.resolvedResult).toBe(result);
  });
});
