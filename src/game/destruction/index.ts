// T13/T25/T26 — destruction lane barrel: sparse StructuralModule + breach pipeline + modification
// classes (board/reinforce/lock/breach/obstruct/support/utility) + fire system.

export {
  StructuralModule,
  type Material,
  type StructuralCell,
  type CellDelta,
  type FractureFamily,
  type StructuralHooks,
  type StructuralModuleOptions,
  type BreachResult,
} from './structuralModule';

export {
  StructureModifier,
  type ModifierDeps,
  type AccessState,
  type FunctionalDelta,
  type DestructionSettings,
} from './modifications';

export {
  FireSim,
  type FireDeps,
  type BurningCell,
  type FireSettings,
} from './fire';
