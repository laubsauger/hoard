// T39 — deterministic replay harness (V26). Records a (seed + command/action sequence) script, runs the
// authoritative GameRuntime, and captures the AUTHORITATIVE outcome — entity health/positions, breach
// state, player avatar, nav revision and the IdFactory counters. Re-running the SAME script from the same
// seed must reproduce a byte-identical outcome (V26 determinism). Non-determinism MUST fail the test: the
// harness compares the canonically-serialized outcomes and never smooths a mismatch over (no tolerance,
// no re-seeding, no fallback). It reaches the runtime ONLY through its existing public surface.

import { GameRuntime } from '@/game/runtime';
import { buildTestBlock, type TestBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';
import { createPlayerViewStore, createMapViewStore } from '@/stores';
import type { AnatomyRegion, Command, EntityId } from '@/game/core/contracts';
import type { QualityTier } from '@/config/types';

const TIER: QualityTier = 'desktop-high';

/** One recorded action against the runtime. Entities are referenced by SPAWN ORDER (index), never by a
 *  raw object ref — the same id resolves identically on every replay (V26 explicit-id rule). */
export type ReplayAction =
  | { readonly kind: 'spawnAt'; readonly x: number; readonly y: number; readonly z: number }
  | { readonly kind: 'spawnHorde'; readonly count: number; readonly radius: number }
  | { readonly kind: 'breach' }
  | { readonly kind: 'aim'; readonly dirX: number; readonly dirZ: number }
  | { readonly kind: 'move'; readonly dirX: number; readonly dirZ: number; readonly dt: number }
  | { readonly kind: 'fire'; readonly dirX: number; readonly dirZ: number; readonly region: AnatomyRegion }
  | { readonly kind: 'fireAt'; readonly index: number; readonly region: AnatomyRegion }
  | { readonly kind: 'update'; readonly dt: number }
  | { readonly kind: 'dispatch'; readonly cmd: Command };

export interface ReplayScript {
  /** Deterministic scatter seed for the initial horde (V26). */
  readonly seed: number;
  /** Fresh BASE scene factory (never persisted — rebuilt per run, V9). Default = the GATE-0 test block. */
  readonly scene?: () => TestBlock;
  readonly actions: readonly ReplayAction[];
}

/** Authoritative state of one live entity, captured verbatim (no rounding). */
export interface EntityOutcome {
  readonly entity: number;
  readonly archetype: number;
  readonly health: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly state: number;
  readonly anatomyFlags: number;
  readonly navGroup: number;
  readonly simTier: number;
  readonly renderTier: number;
}

/** The authoritative outcome a replay must reproduce byte-for-byte. */
export interface ReplayOutcome {
  readonly tick: number;
  readonly aliveCount: number;
  readonly navRevision: number;
  readonly idCounters: Record<string, number>;
  readonly player: { readonly x: number; readonly y: number; readonly z: number; readonly heading: number };
  /** Module-local structural cells currently breached (ascending) — the destruction authority's state. */
  readonly breachedCells: readonly number[];
  /** Live entities ordered by stable EntityId (ascending) so the capture is order-independent. */
  readonly entities: readonly EntityOutcome[];
}

function makeRuntime(script: ReplayScript): GameRuntime {
  return new GameRuntime({
    tier: TIER,
    adapter: new InMemoryPersistenceAdapter(),
    scene: (script.scene ?? buildTestBlock)(),
    scatterSeed: script.seed,
    // explicit per-run stores so a replay never touches the app's HUD singletons (V1).
    playerStore: createPlayerViewStore(),
    mapStore: createMapViewStore(),
  });
}

/** Run the script once and capture the authoritative outcome. */
export function runScript(script: ReplayScript): ReplayOutcome {
  const rt = makeRuntime(script);
  const spawned: EntityId[] = [];

  for (const a of script.actions) {
    switch (a.kind) {
      case 'spawnAt':
        spawned.push(rt.spawnZombie({ x: a.x, y: a.y, z: a.z }));
        break;
      case 'spawnHorde':
        spawned.push(...rt.spawnHorde(a.count, a.radius));
        break;
      case 'breach':
        rt.breachWall();
        break;
      case 'aim':
        rt.aim(a.dirX, a.dirZ);
        break;
      case 'move':
        rt.movePlayer(a.dirX, a.dirZ, a.dt);
        break;
      case 'fire':
        rt.fire(a.dirX, a.dirZ, a.region);
        break;
      case 'fireAt': {
        const e = spawned[a.index];
        if (e === undefined) throw new Error(`fireAt references unspawned index ${a.index}`);
        rt.fireAtEntity(e, a.region);
        break;
      }
      case 'update':
        rt.update(a.dt);
        break;
      case 'dispatch': {
        const res = rt.dispatch(a.cmd);
        // A command the script expects to apply must apply on every replay; a silent divergence here
        // would be exactly the kind of non-determinism this layer exists to catch.
        if (!res.ok) throw new Error(`replay command ${a.cmd.kind} failed: ${res.reason}`);
        break;
      }
    }
  }

  return captureOutcome(rt);
}

export function captureOutcome(rt: GameRuntime): ReplayOutcome {
  const wall = rt.scene.wall;
  const breachedCells: number[] = [];
  for (let z = 0; z < wall.sizeZ; z++) {
    const cell = wall.packCell(0, 0, z);
    if (wall.isBreached(cell)) breachedCells.push(cell);
  }

  const pos: [number, number, number] = [0, 0, 0];
  const entities: EntityOutcome[] = [];
  rt.zombies.forEachAlive((slot) => {
    rt.zombies.getPosition(slot, pos);
    entities.push({
      entity: rt.entityOf(slot) as number,
      archetype: rt.zombies.getArchetype(slot),
      health: rt.zombies.getHealth(slot),
      x: pos[0],
      y: pos[1],
      z: pos[2],
      heading: rt.zombies.getHeading(slot),
      state: rt.zombies.getState(slot),
      anatomyFlags: rt.zombies.getAnatomyFlags(slot),
      navGroup: rt.zombies.getNavGroup(slot),
      simTier: rt.zombies.getSimTier(slot),
      renderTier: rt.zombies.getRenderTier(slot),
    });
  });
  entities.sort((a, b) => a.entity - b.entity);

  const p = rt.player();
  return {
    tick: rt.tick,
    aliveCount: rt.aliveCount,
    navRevision: rt.navRevision,
    idCounters: rt.ids.snapshot(),
    player: { x: p.x, y: p.y, z: p.z, heading: rt.playerAim() },
    breachedCells,
    entities,
  };
}

/** Canonical, stable serialization of an outcome (object key order is fixed by construction above). */
export function serializeOutcome(outcome: ReplayOutcome): string {
  return JSON.stringify(outcome);
}

/**
 * Run a script TWICE from the same seed and assert the authoritative outcomes are byte-identical (V26).
 * Returns the serialized outcome (so callers can also assert it is non-trivial). Throws with a precise
 * first-divergence message if the runs disagree — a non-deterministic result FAILS, never smoothed.
 */
export function assertDeterministicReplay(script: ReplayScript): {
  first: ReplayOutcome;
  second: ReplayOutcome;
  serialized: string;
} {
  const first = runScript(script);
  const second = runScript(script);
  const a = serializeOutcome(first);
  const b = serializeOutcome(second);
  if (a !== b) {
    throw new Error(`replay diverged (V26):\n  run#1 = ${a}\n  run#2 = ${b}`);
  }
  return { first, second, serialized: a };
}
