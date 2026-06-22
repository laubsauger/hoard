// T36 — the six §V benchmark scenes wired onto the real GameRuntime (lane X, tests-only). Each scene
// builds authoritative state via the same systems the game ships (SoA store, shared flow field, collision
// hash, combat, structural module, persistence) and returns a SceneRun the harness times tick-by-tick.
//
// Per V10 each scene records exactly WHAT was run: tier (→ tickHz + flow-cache size), the active systems,
// and the headline horde count — so the resulting numbers are reproducible gates, not claims.

import { GameRuntime } from '@/game/runtime';
import { InMemoryPersistenceAdapter, type PersistenceAdapter } from '@/game/persistence';
import { createPlayerViewStore, createMapViewStore } from '@/stores';
import type { TestBlock, CellXY } from '@/game/scene';
import type { QualityTier } from '@/config/types';
import type { CommandId } from '@/game/core/contracts';
import type { BenchmarkScene, SceneRun } from './harness';
import {
  BENCHMARK_SCENES,
  GUNFIRE_CADENCE,
  BREACH_CADENCE_TICKS,
} from './config';
import {
  buildCrowdAvenue,
  buildBreachCascade,
  buildDenseInterior,
  buildStreamingSprint,
  buildCorpseArena,
  buildMobileAvenue,
  BREACH_SECTION_CELLS,
} from './benchScenes';

const SCATTER_SEED = 1; // deterministic spawn ordering (V26)
/** Deterministic sub-cell jitter so co-located bodies do not perfectly stack (still inside the cell). */
const JITTER_METERS = 0.4;

function makeRuntime(tier: QualityTier, scene: TestBlock, adapter: PersistenceAdapter): GameRuntime {
  return new GameRuntime({
    tier,
    scene,
    adapter,
    playerStore: createPlayerViewStore(),
    mapStore: createMapViewStore(),
    scatterSeed: SCATTER_SEED,
  });
}

/**
 * Spawn `count` zombies spread deterministically across the walkable cells of a cell rectangle (real
 * spatial spread down a street / across an arena, rather than a tight scatter). Bodies cycle the walkable
 * cells round-robin with a fixed sub-cell jitter; overlap is fine (the crowd resolves it, V19).
 */
function spawnSpread(rt: GameRuntime, scene: TestBlock, count: number, rect: {
  readonly minCx: number;
  readonly maxCx: number;
  readonly minCy: number;
  readonly maxCy: number;
}): number {
  const cells: CellXY[] = [];
  for (let cy = rect.minCy; cy <= rect.maxCy; cy++) {
    for (let cx = rect.minCx; cx <= rect.maxCx; cx++) {
      const c = scene.cellCenter({ cx, cy });
      if (scene.isWalkableWorld(c.x, c.z)) cells.push({ cx, cy });
    }
  }
  if (cells.length === 0) throw new Error('spawn rect contains no walkable cells');
  for (let i = 0; i < count; i++) {
    const cell = cells[i % cells.length]!;
    const center = scene.cellCenter(cell);
    const ring = Math.floor(i / cells.length);
    const jx = ((ring % 3) - 1) * JITTER_METERS;
    const jz = ((Math.floor(ring / 3) % 3) - 1) * JITTER_METERS;
    const x = center.x + jx;
    const z = center.z + jz;
    rt.spawnZombie({ x: scene.isWalkableWorld(x, z) ? x : center.x, y: 0, z: scene.isWalkableWorld(x, z) ? z : center.z });
  }
  return rt.aliveCount;
}

// =================================================================================================
// 1) Crowd avenue
// =================================================================================================
function crowdAvenueScene(): BenchmarkScene {
  const cfg = BENCHMARK_SCENES.crowdAvenue;
  return {
    name: cfg.name,
    tier: cfg.tier,
    ticks: cfg.ticks,
    warmupTicks: cfg.warmupTicks,
    setup(): SceneRun {
      const scene = buildCrowdAvenue();
      const rt = makeRuntime(cfg.tier, scene, new InMemoryPersistenceAdapter());
      spawnSpread(rt, scene, cfg.hordeCount, { minCx: 50, maxCx: 96, minCy: 1, maxCy: 12 });
      const dt = rt.clock.tickSeconds;
      return {
        step(tickIndex) {
          if (tickIndex % GUNFIRE_CADENCE.crowdAvenueEveryTicks === 0) rt.fire(1, 0, 'torsoUpper');
          rt.update(dt);
        },
        entityCount: () => rt.aliveCount,
      };
    },
  };
}

// =================================================================================================
// 2) Breach cascade
// =================================================================================================
function breachCascadeScene(): BenchmarkScene {
  const cfg = BENCHMARK_SCENES.breachCascade;
  return {
    name: cfg.name,
    tier: cfg.tier,
    ticks: cfg.ticks,
    warmupTicks: cfg.warmupTicks,
    setup(): SceneRun {
      const scene = buildBreachCascade();
      const rt = makeRuntime(cfg.tier, scene, new InMemoryPersistenceAdapter());
      spawnSpread(rt, scene, cfg.hordeCount, { minCx: 2, maxCx: 28, minCy: 2, maxCy: 15 });
      const dt = rt.clock.tickSeconds;
      let nextSection = 0;
      return {
        step(tickIndex) {
          // Drive the cascade: breach the next wall section on cadence (dirties local nav + flow, V5/V18).
          if (tickIndex % BREACH_CADENCE_TICKS === 0 && nextSection < BREACH_SECTION_CELLS) {
            const cell = scene.wall.packCell(0, 0, nextSection);
            rt.dispatch({
              kind: 'modifyStructure',
              id: rt.ids.next<CommandId>('command'),
              module: scene.moduleId,
              cell,
              op: 'breach',
            });
            nextSection += 1;
          }
          rt.update(dt);
        },
        entityCount: () => rt.aliveCount,
      };
    },
  };
}

// =================================================================================================
// 3) Dense interior
// =================================================================================================
function denseInteriorScene(): BenchmarkScene {
  const cfg = BENCHMARK_SCENES.denseInterior;
  return {
    name: cfg.name,
    tier: cfg.tier,
    ticks: cfg.ticks,
    warmupTicks: cfg.warmupTicks,
    setup(): SceneRun {
      const scene = buildDenseInterior();
      const rt = makeRuntime(cfg.tier, scene, new InMemoryPersistenceAdapter());
      spawnSpread(rt, scene, cfg.hordeCount, { minCx: 1, maxCx: 8, minCy: 1, maxCy: 26 });
      const dt = rt.clock.tickSeconds;
      return {
        step(tickIndex) {
          if (tickIndex % GUNFIRE_CADENCE.denseInteriorEveryTicks === 0) rt.fire(-1, 0, 'torsoUpper');
          rt.update(dt);
        },
        entityCount: () => rt.aliveCount,
      };
    },
  };
}

// =================================================================================================
// 4) Streaming sprint
// =================================================================================================
function streamingSprintScene(): BenchmarkScene {
  const cfg = BENCHMARK_SCENES.streamingSprint;
  return {
    name: cfg.name,
    tier: cfg.tier,
    ticks: cfg.ticks,
    warmupTicks: cfg.warmupTicks,
    setup(): SceneRun {
      const scene = buildStreamingSprint();
      const rt = makeRuntime(cfg.tier, scene, new InMemoryPersistenceAdapter());
      spawnSpread(rt, scene, cfg.hordeCount, { minCx: 48, maxCx: 72, minCy: 1, maxCy: 22 });
      const dt = rt.clock.tickSeconds;
      return {
        step() {
          // Player sprints +x across the whole map each tick: crossing cell/tile/sector boundaries shifts
          // the shared flow-field target, forcing recomputes as the horde re-tracks the moving target.
          rt.movePlayer(1, 0, dt);
          rt.update(dt);
        },
        entityCount: () => rt.aliveCount,
      };
    },
  };
}

// =================================================================================================
// 5) Corpse accumulation
// =================================================================================================
function corpseAccumulationScene(): BenchmarkScene {
  const cfg = BENCHMARK_SCENES.corpseAccumulation;
  const SPAWN_RECT = { minCx: 1, maxCx: 82, minCy: 1, maxCy: 42 } as const;
  return {
    name: cfg.name,
    tier: cfg.tier,
    ticks: cfg.ticks,
    warmupTicks: cfg.warmupTicks,
    setup(): SceneRun {
      const adapter = new InMemoryPersistenceAdapter();
      let scene = buildCorpseArena();
      let rt = makeRuntime(cfg.tier, scene, adapter);
      spawnSpread(rt, scene, cfg.hordeCount, SPAWN_RECT);
      const dt = rt.clock.tickSeconds;
      let lastSaveReloadMs = 0;
      let cycles = 0;
      return {
        step() {
          rt.update(dt);
        },
        async maintain(tickIndex) {
          // Repeated save → evict → reload of the whole settled population (the persistence headline cost).
          if (tickIndex > 0 && tickIndex % cfg.saveReloadEveryTicks === 0) {
            const t0 = performance.now();
            await rt.save();
            const fresh = buildCorpseArena();
            const reloaded = makeRuntime(cfg.tier, fresh, adapter);
            await reloaded.loadFrom();
            lastSaveReloadMs = performance.now() - t0;
            scene = fresh;
            rt = reloaded;
            cycles += 1;
          }
        },
        entityCount: () => rt.aliveCount,
        extra: () => ({ saveReloadMs: lastSaveReloadMs, saveReloadCycles: cycles }),
      };
    },
  };
}

// =================================================================================================
// 6) Mobile capability
// =================================================================================================
function mobileCapabilityScene(): BenchmarkScene {
  const cfg = BENCHMARK_SCENES.mobileCapability;
  return {
    name: cfg.name,
    tier: cfg.tier,
    ticks: cfg.ticks,
    warmupTicks: cfg.warmupTicks,
    setup(): SceneRun {
      const scene = buildMobileAvenue();
      const rt = makeRuntime(cfg.tier, scene, new InMemoryPersistenceAdapter());
      spawnSpread(rt, scene, cfg.hordeCount, { minCx: 40, maxCx: 78, minCy: 1, maxCy: 12 });
      const dt = rt.clock.tickSeconds;
      return {
        step(tickIndex) {
          if (tickIndex % GUNFIRE_CADENCE.crowdAvenueEveryTicks === 0) rt.fire(1, 0, 'torsoUpper');
          rt.update(dt);
        },
        entityCount: () => rt.aliveCount,
      };
    },
  };
}

/** All six benchmark scenes, in §V-gates declaration order. */
export function allBenchmarkScenes(): readonly BenchmarkScene[] {
  return [
    crowdAvenueScene(),
    breachCascadeScene(),
    denseInteriorScene(),
    streamingSprintScene(),
    corpseAccumulationScene(),
    mobileCapabilityScene(),
  ];
}
