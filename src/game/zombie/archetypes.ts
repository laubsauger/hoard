// T21 / V7 — three data-composed archetypes: shambler / runner / crawler.
// They differ ONLY by data drawn from typed config (zombies + perception domains) — there is no
// per-archetype subclass or branch. Anatomical damage variation is expressed via the anatomy
// profile (severThresholdScale + severableRegions + initial sever state), proving the spec's
// "data-composed, not hardcoded classes" requirement (§I/V7).

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

/** Compose the three reference archetypes from resolved config for a quality tier (V4). */
export function buildArchetypes(tier: QualityTier = REFERENCE_TIER): ZombieArchetype[] {
  const z = resolveDomain(zombiesConfig, tier);
  const p = resolveDomain(perceptionConfig, tier);

  const shambler: ZombieArchetype = {
    id: 'shambler',
    bodyFamily: 'humanoid',
    skeletonFamily: 'biped-standard',
    locomotion: { kind: 'shamble', moveSpeed: z.shamblerMoveSpeed },
    perception: { sightRange: z.shamblerSightRange, hearingRange: z.shamblerHearingRange },
    attack: { damage: z.shamblerAttackDamage, rangeMeters: p.attackRangeMeters },
    anatomy: {
      severThresholdScale: z.shamblerSeverScale,
      severableRegions: ALL_LIMBS,
      headFatal: true,
      initialAnatomyFlags: 0,
    },
    durability: { health: z.shamblerHealth, armor: z.shamblerArmor },
    allowedSimTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
    allowedRenderTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
  };

  const runner: ZombieArchetype = {
    id: 'runner',
    bodyFamily: 'humanoid-light',
    skeletonFamily: 'biped-standard',
    locomotion: { kind: 'run', moveSpeed: z.runnerMoveSpeed },
    perception: { sightRange: z.runnerSightRange, hearingRange: z.runnerHearingRange },
    attack: { damage: z.runnerAttackDamage, rangeMeters: p.attackRangeMeters },
    anatomy: {
      severThresholdScale: z.runnerSeverScale, // fragile — lower scale = severs more easily
      severableRegions: ALL_LIMBS,
      headFatal: true,
      initialAnatomyFlags: 0,
    },
    durability: { health: z.runnerHealth, armor: z.runnerArmor },
    // a runner is never abstracted while in a loaded sector — its speed makes it always relevant.
    allowedSimTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde],
    allowedRenderTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
  };

  const crawler: ZombieArchetype = {
    id: 'crawler',
    bodyFamily: 'humanoid-heavy',
    skeletonFamily: 'biped-legless',
    locomotion: { kind: 'crawl', moveSpeed: z.crawlerMoveSpeed },
    perception: { sightRange: z.crawlerSightRange, hearingRange: z.crawlerHearingRange },
    attack: { damage: z.crawlerAttackDamage, rangeMeters: p.attackRangeMeters },
    anatomy: {
      severThresholdScale: z.crawlerSeverScale, // tough torso/arms — higher scale = severs less easily
      severableRegions: ARMS_AND_HEAD, // legs already gone — not severable
      headFatal: true,
      initialAnatomyFlags: regionBit('legLeft') | regionBit('legRight'), // spawns legless → crawling
    },
    durability: { health: z.crawlerHealth, armor: z.crawlerArmor },
    allowedSimTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
    allowedRenderTiers: [SimTier.Hero, SimTier.ActiveCrowd, SimTier.VisibleHorde, SimTier.Abstract],
  };

  // validate + freeze at build time (V4/V7 — invalid composed content throws here, never silent).
  return [shambler, runner, crawler].map(defineArchetype);
}

/** Build a registry with the three reference archetypes registered at stable indices. */
export function buildArchetypeRegistry(tier: QualityTier = REFERENCE_TIER): ArchetypeRegistry {
  const reg = new ArchetypeRegistry();
  for (const a of buildArchetypes(tier)) reg.register(a);
  return reg;
}
