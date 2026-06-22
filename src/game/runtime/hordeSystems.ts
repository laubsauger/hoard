// T41 — HordeSimulation: the per-tick horde systems lifted out of GameRuntime so the runtime stays an
// orchestrator, not a god-object. Owns ONLY the shared-flow movement, sound-attraction lure, perception,
// and tier-assignment steps (V12/V13/V14/V15/V19) plus the lure state they mutate. It reads player +
// targeting state through accessors so GameRuntime remains the single authority over those (V1).

import type { FixedClock, SystemContext } from '@/game/core';
import type { StimulusField } from '@/game/stimulus';
import type { SimulationZombies, TierManager, TierInputs, ZombieSlot } from '@/game/simulation';
import { steer, type FlowFieldCache } from '@/game/navigation';
import { CollisionLayer, layerMask, type SpatialHash } from '@/game/navigation/collision';
import type { combatConfig } from '@/config/domains/combat';
import type { perceptionConfig } from '@/config/domains/perception';
import type { ResolvedDomain } from '@/config/types';
import type { TestBlock, Vec3 } from '@/game/scene';

const MOVEMENT_PROFILE = 'zombie-walk';
const MOVEMENT_MASK = layerMask(CollisionLayer.Movement);

/** Planar (XZ) distance from a zombie slot to the player — shared by the horde steps and snapshots. */
export function planarDistanceToPlayer(
  zombies: SimulationZombies,
  slot: ZombieSlot,
  px: number,
  pz: number,
): number {
  const pos: [number, number, number] = [0, 0, 0];
  zombies.getPosition(slot, pos);
  return Math.hypot(pos[0] - px, pos[2] - pz);
}

export interface HordeSimulationDeps {
  readonly zombies: SimulationZombies;
  readonly spatial: SpatialHash;
  readonly scene: TestBlock;
  readonly flowCache: FlowFieldCache;
  readonly tierManager: TierManager;
  readonly stimulus: StimulusField;
  readonly clock: FixedClock;
  readonly combatCfg: ResolvedDomain<typeof combatConfig>;
  readonly perception: ResolvedDomain<typeof perceptionConfig>;
  /** Player entity id stamped into the SoA stimulus column when a zombie senses the player in range (V14). */
  readonly playerEntityId: number;
  /** Live player position (GameRuntime owns it; the horde only reads it — never the omniscient coord, V14). */
  readonly getPlayerPos: () => Readonly<Vec3>;
  /** Live selected target slot (-1 = none); promotes that slot to hero next tier pass (V13). */
  readonly getTargetSlot: () => ZombieSlot;
  /** Tick of last damage per slot, owned by GameRuntime's combat callbacks; read here for tier recency. */
  readonly lastDamageTick: Map<ZombieSlot, number>;
}

/**
 * The per-tick horde systems. GameRuntime registers thin wrappers that delegate here; all behavior
 * (steering, lure, perception, tiering) lives in this one cohesive unit.
 */
export class HordeSimulation {
  /** Sound-attraction lure: while active the WHOLE horde reroutes to the loudest perceived sound (V15). */
  private soundLureCell: number | null = null;
  private soundLureUntilTick = -1;

  constructor(private readonly d: HordeSimulationDeps) {}

  /** everyTick: shared-flow steering + movement integrate (V12/V15/V19). */
  stepMovement(): void {
    const { zombies, spatial, scene, flowCache, combatCfg, clock } = this.d;
    const targetCell = this.flowTargetCell();
    const field = flowCache.get(scene.navGrid, targetCell, MOVEMENT_PROFILE);
    const dt = clock.tickSeconds;
    const speed = combatCfg.hordeMoveSpeed;
    const sep = combatCfg.steerSeparationMeters;
    const flowWeight = combatCfg.steerFlowWeight;
    const pos: [number, number, number] = [0, 0, 0];

    zombies.forEachAlive((slot) => {
      if (zombies.getNavGroup(slot) < 0) return;
      zombies.getPosition(slot, pos);
      const ids = spatial.query(pos[0], pos[2], sep, MOVEMENT_MASK, { exclude: slot });
      const neighbors = ids.map((id) => {
        const a = spatial.get(id);
        return { dx: a.x - pos[0], dz: a.z - pos[2] };
      });
      const { dirX, dirZ } = steer(field, { x: pos[0], z: pos[2], neighbors, separation: sep, flowWeight });
      if (dirX === 0 && dirZ === 0) {
        zombies.setVelocity(slot, 0, 0, 0);
        return;
      }
      const nx = pos[0] + dirX * speed * dt;
      const nz = pos[2] + dirZ * speed * dt;
      if (scene.isWalkableWorld(nx, nz)) {
        zombies.setPosition(slot, nx, pos[1], nz);
        zombies.setHeading(slot, Math.atan2(dirZ, dirX));
        zombies.setVelocity(slot, dirX * speed, 0, dirZ * speed);
        spatial.update(slot, nx, nz);
      } else {
        zombies.setVelocity(slot, 0, 0, 0);
      }
    });
  }

  /**
   * Sound attraction (V14/V15): retire decayed stimuli, then read the loudest SOUND reaching the horde's
   * cluster from the shared field — NOT the player coordinate directly. If one is heard, lure the whole
   * horde to its source for the configured investigate window; the lure expires back to tracking the
   * player. Because every agent shares ONE flow field, retargeting reroutes the entire horde at once.
   */
  stepSound(ctx: SystemContext): void {
    const { stimulus, scene, perception } = this.d;
    stimulus.update(ctx.tick);
    const here = scene.cellCenter(scene.spawnCenterCell);
    const hits = stimulus.query(here.x, here.z, ctx.tick);
    let bestX = 0;
    let bestZ = 0;
    let bestIntensity = 0;
    for (const h of hits) {
      if (h.stimulus.kind !== 'sound') continue;
      if (h.intensity > bestIntensity) {
        bestIntensity = h.intensity;
        bestX = h.stimulus.x;
        bestZ = h.stimulus.z;
      }
    }
    if (bestIntensity > 0 && scene.isWalkableWorld(bestX, bestZ)) {
      const c = scene.navGrid.worldToCell(bestX, bestZ);
      this.soundLureCell = scene.navGrid.index(c.cx, c.cy);
      this.soundLureUntilTick = ctx.tick + perception.investigateTicks;
    }
  }

  /** The shared flow-field target this tick: the active sound lure if any, else the live player cell. */
  flowTargetCell(): number {
    const { scene, clock, getPlayerPos } = this.d;
    if (this.soundLureCell !== null && clock.tick <= this.soundLureUntilTick) {
      return this.soundLureCell;
    }
    this.soundLureCell = null;
    const p = getPlayerPos();
    const c = scene.navGrid.worldToCell(p.x, p.z);
    return scene.navGrid.index(c.cx, c.cy);
  }

  /** interval: stimulus-driven perception (V14) — a zombie senses the player only within sight range. */
  stepPerception(): void {
    const { zombies, perception, playerEntityId, getPlayerPos } = this.d;
    const p = getPlayerPos();
    const sight = perception.sightRange;
    zombies.forEachAlive((slot) => {
      const dist = planarDistanceToPlayer(zombies, slot, p.x, p.z);
      zombies.setStimulus(slot, dist <= sight ? playerEntityId : -1);
    });
  }

  /** interval: tier assignment (V13), phase-offset so it never shares a tick with perception. */
  stepTiers(ctx: SystemContext): void {
    const { zombies, perception, combatCfg, tierManager, getPlayerPos, getTargetSlot, lastDamageTick } = this.d;
    const p = getPlayerPos();
    const target = getTargetSlot();
    const sight = perception.sightRange;
    const window = combatCfg.recentDamageWindowTicks;
    zombies.forEachAlive((slot) => {
      const dist = planarDistanceToPlayer(zombies, slot, p.x, p.z);
      const visible = dist <= sight;
      const damagedAt = lastDamageTick.get(slot);
      const recentDamage = damagedAt !== undefined && ctx.tick - damagedAt <= window;
      const inputs: TierInputs = {
        distance: dist,
        visible,
        threat: visible ? perception.visibleThreatWeight : 0,
        cameraImportance: 0,
        targeted: slot === target,
        recentDamage,
        currentAttack: false,
        perfBudget: combatCfg.perfBudget,
      };
      tierManager.update(zombies, slot, inputs);
    });
  }
}
