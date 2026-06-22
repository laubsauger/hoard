// T8/T10 — simulation lane barrel: SoA entity store + tiered population.

export {
  SimulationZombies,
  SimulationZombie,
  ZombieState,
  resolveCapacity,
  type ZombieSlot,
  type ZombieSpawn,
} from './zombieStore';
export {
  TierManager,
  SimTier,
  type TierInputs,
  type TierAssignment,
} from './tierManager';
