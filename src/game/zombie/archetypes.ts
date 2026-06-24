// T21 / V7 — data-composed archetype roster: shambler / runner / crawler (baseline) plus the tiered
// ecology grounded variants armored / decayed / burned / bloated. Every archetype differs ONLY by data
// drawn from typed config (zombies + perception domains) — there is no per-archetype subclass or branch.
// Anatomical + combat variation is expressed via the anatomy profile (severThresholdScale +
// severableRegions + initial sever state), durability, attack cadence and the gore palette key, proving
// the spec's "data-composed, not hardcoded classes" requirement (§I/V7).

import { resolveDomain } from '@/config/registry';
import { zombiesConfig } from '@/config/domains/zombies';
import { perceptionConfig } from '@/config/domains/perception';
import type { QualityTier } from '@/config/types';
import { regionBit } from '@/game/combat';
import { SimTier } from '@/game/simulation';
import type { AnatomyRegion } from '@/game/core/contracts';
import { ArchetypeRegistry, defineArchetype, type ZombieArchetype } from './archetype';

const ALL_LIMBS: readonly AnatomyRegion[] = ['head', 'neck', 'armLeft', 'armRight', 'legLeft', 'legRight'];
const ARMS_AND_HEAD: readonly AnatomyRegion[] = ['head', 'neck', 'armLeft', 'armRight'];
const REFERENCE_TIER: QualityTier = 'desktop-high';

/** Compose the full archetype roster from resolved config for a quality tier (V4). */
export function buildArchetypes(tier: QualityTier = REFERENCE_TIER): ZombieArchetype[] {
  const z = resolveDomain(zombiesConfig, tier);
  const p = resolveDomain(perceptionConfig, tier);

  const shambler: ZombieArchetype = {
    id: 'shambler',
    bodyFamily: 'humanoid',
    skeletonFamily: 'biped-standard',
    locomotion: { kind: 'shamble', moveSpeed: z.shamblerMoveSpeed, moveSpeedScale: z.shamblerMoveSpeedScale },
    spawnWeight: z.shamblerSpawnWeight,
    perception: { sightRange: z.shamblerSightRange, hearingRange: z.shamblerHearingRange },
    attack: { damage: z.shamblerAttackDamage, rangeMeters: p.attackRangeMeters, cooldownSeconds: z.shamblerAttackCooldownSeconds },
    anatomy: {
      severThresholdScale: z.shamblerSeverScale,
      severableRegions: ALL_LIMBS,
      headFatal: true,
      initialAnatomyFlags: 0,
    },
    durability: { health: z.shamblerHealth, armor: z.shamblerArmor },
    gore: 'blood',
    burstsOnDeath: false,
    allowedSimTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
    allowedRenderTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
  };

  const runner: ZombieArchetype = {
    id: 'runner',
    bodyFamily: 'humanoid-light',
    skeletonFamily: 'biped-standard',
    locomotion: { kind: 'run', moveSpeed: z.runnerMoveSpeed, moveSpeedScale: z.runnerMoveSpeedScale },
    spawnWeight: z.runnerSpawnWeight,
    perception: { sightRange: z.runnerSightRange, hearingRange: z.runnerHearingRange },
    attack: { damage: z.runnerAttackDamage, rangeMeters: p.attackRangeMeters, cooldownSeconds: z.runnerAttackCooldownSeconds },
    anatomy: {
      severThresholdScale: z.runnerSeverScale, // fragile — lower scale = severs more easily
      severableRegions: ALL_LIMBS,
      headFatal: true,
      initialAnatomyFlags: 0,
    },
    durability: { health: z.runnerHealth, armor: z.runnerArmor },
    gore: 'blood',
    burstsOnDeath: false,
    // a runner is never abstracted while in a loaded sector — its speed makes it always relevant.
    allowedSimTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde],
    allowedRenderTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
  };

  const crawler: ZombieArchetype = {
    id: 'crawler',
    bodyFamily: 'humanoid-heavy',
    skeletonFamily: 'biped-legless',
    locomotion: { kind: 'crawl', moveSpeed: z.crawlerMoveSpeed, moveSpeedScale: z.crawlerMoveSpeedScale },
    spawnWeight: z.crawlerSpawnWeight,
    perception: { sightRange: z.crawlerSightRange, hearingRange: z.crawlerHearingRange },
    attack: { damage: z.crawlerAttackDamage, rangeMeters: p.attackRangeMeters, cooldownSeconds: z.crawlerAttackCooldownSeconds },
    anatomy: {
      severThresholdScale: z.crawlerSeverScale, // tough torso/arms — higher scale = severs less easily
      severableRegions: ARMS_AND_HEAD, // legs already gone — not severable
      headFatal: true,
      initialAnatomyFlags: regionBit('legLeft') | regionBit('legRight'), // spawns legless → crawling
    },
    durability: { health: z.crawlerHealth, armor: z.crawlerArmor },
    gore: 'blood',
    burstsOnDeath: false,
    allowedSimTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
    allowedRenderTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
  };

  // armored (emergency-personnel) — slow, very tanky body + flat armor. Head stays fatal so a body-only
  // assault stalls: forces headshots / armor penetration. Tough body = high sever-threshold scale.
  const armored: ZombieArchetype = {
    id: 'armored',
    bodyFamily: 'humanoid-heavy',
    skeletonFamily: 'biped-standard',
    locomotion: { kind: 'shamble', moveSpeed: z.armoredMoveSpeed, moveSpeedScale: z.armoredMoveSpeedScale },
    spawnWeight: z.armoredSpawnWeight,
    perception: { sightRange: z.armoredSightRange, hearingRange: z.armoredHearingRange },
    attack: { damage: z.armoredAttackDamage, rangeMeters: p.attackRangeMeters, cooldownSeconds: z.armoredAttackCooldownSeconds },
    anatomy: {
      severThresholdScale: z.armoredSeverScale, // gear-protected limbs — very hard to sever
      severableRegions: ALL_LIMBS,
      headFatal: true, // body very tanky, but a destroyed head still drops it
      initialAnatomyFlags: 0,
    },
    durability: { health: z.armoredHealth, armor: z.armoredArmor },
    gore: 'blood',
    burstsOnDeath: false,
    allowedSimTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
    allowedRenderTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
  };

  // decayed — far-gone corpse: low health, falls apart easily (very low sever threshold), shambles.
  const decayed: ZombieArchetype = {
    id: 'decayed',
    bodyFamily: 'humanoid-light',
    skeletonFamily: 'biped-standard',
    locomotion: { kind: 'shamble', moveSpeed: z.decayedMoveSpeed, moveSpeedScale: z.decayedMoveSpeedScale },
    spawnWeight: z.decayedSpawnWeight,
    perception: { sightRange: z.decayedSightRange, hearingRange: z.decayedHearingRange },
    attack: { damage: z.decayedAttackDamage, rangeMeters: p.attackRangeMeters, cooldownSeconds: z.decayedAttackCooldownSeconds },
    anatomy: {
      severThresholdScale: z.decayedSeverScale, // rotted — limbs come off with little force
      severableRegions: ALL_LIMBS,
      headFatal: true,
      initialAnatomyFlags: 0,
    },
    durability: { health: z.decayedHealth, armor: z.decayedArmor },
    gore: 'ichor', // rotted fluids, not fresh blood
    burstsOnDeath: false,
    allowedSimTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
    allowedRenderTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
  };

  // burned — charred: brittle flesh, emits ash (the `burned` gore type) rather than blood. Moderate stats.
  const burned: ZombieArchetype = {
    id: 'burned',
    bodyFamily: 'humanoid',
    skeletonFamily: 'biped-standard',
    locomotion: { kind: 'shamble', moveSpeed: z.burnedMoveSpeed, moveSpeedScale: z.burnedMoveSpeedScale },
    spawnWeight: z.burnedSpawnWeight,
    perception: { sightRange: z.burnedSightRange, hearingRange: z.burnedHearingRange },
    attack: { damage: z.burnedAttackDamage, rangeMeters: p.attackRangeMeters, cooldownSeconds: z.burnedAttackCooldownSeconds },
    anatomy: {
      severThresholdScale: z.burnedSeverScale, // charred + brittle — slightly easier to sever
      severableRegions: ALL_LIMBS,
      headFatal: true,
      initialAnatomyFlags: 0,
    },
    durability: { health: z.burnedHealth, armor: z.burnedArmor },
    gore: 'burned', // charred — emits ash, little-to-no blood (render branches on this)
    burstsOnDeath: false,
    allowedSimTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
    allowedRenderTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
  };

  // bloated — swollen + slow; taut skin splits easily and bursts on death (death-effect data flag only).
  const bloated: ZombieArchetype = {
    id: 'bloated',
    bodyFamily: 'humanoid-heavy',
    skeletonFamily: 'biped-standard',
    locomotion: { kind: 'shamble', moveSpeed: z.bloatedMoveSpeed, moveSpeedScale: z.bloatedMoveSpeedScale },
    spawnWeight: z.bloatedSpawnWeight,
    perception: { sightRange: z.bloatedSightRange, hearingRange: z.bloatedHearingRange },
    attack: { damage: z.bloatedAttackDamage, rangeMeters: p.attackRangeMeters, cooldownSeconds: z.bloatedAttackCooldownSeconds },
    anatomy: {
      severThresholdScale: z.bloatedSeverScale, // distended skin splits easily
      severableRegions: ALL_LIMBS,
      headFatal: true,
      initialAnatomyFlags: 0,
    },
    durability: { health: z.bloatedHealth, armor: z.bloatedArmor },
    gore: 'ichor',
    burstsOnDeath: true, // death effect hook — render hooks on it later (data flag only)
    allowedSimTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
    allowedRenderTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
  };

  // validate + freeze at build time (V4/V7 — invalid composed content throws here, never silent).
  return [shambler, runner, crawler, armored, decayed, burned, bloated].map(defineArchetype);
}

/** Build a registry with every roster archetype registered at stable indices. */
export function buildArchetypeRegistry(tier: QualityTier = REFERENCE_TIER): ArchetypeRegistry {
  const reg = new ArchetypeRegistry();
  for (const a of buildArchetypes(tier)) reg.register(a);
  return reg;
}
