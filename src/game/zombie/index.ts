// Zombie lane barrel — T20 behaviour + T21 archetypes.

export {
  defineArchetype,
  ArchetypeRegistry,
  type ZombieArchetype,
  type BodyFamily,
  type LocomotionKind,
  type LocomotionProfile,
  type PerceptionProfile,
  type AttackProfile,
  type AnatomyProfile,
  type DurabilityProfile,
} from './archetype';
export { buildArchetypes, buildArchetypeRegistry } from './archetypes';
export {
  perceive,
  type PerceptionConfig,
  type PerceivedStimulus,
  type PerceptionResult,
} from './perception';
export {
  decide,
  applyDecision,
  newMemory,
  type BehaviorConfig,
  type BehaviorMemory,
  type BehaviorDecision,
} from './behavior';
export {
  summarizeHorde,
  groupAttraction,
  BarricadePressure,
  type HordeMember,
  type MemberAttractor,
  type HordeSummary,
  type BarricadeSink,
} from './horde';
