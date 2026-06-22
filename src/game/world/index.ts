// T14 / T40 — world lane barrel: chunk streaming lifecycle + district model + decisive horde event.

export {
  ChunkStreamer,
  CHUNK_STATES,
  isValidTransition,
  type ChunkState,
  type DisposeFn,
  type StreamingSettings,
} from './chunkStreaming';

export {
  DistrictModel,
  resolveDistrictSettings,
  type SectorDescriptor,
  type SectorPromotion,
  type SectorEviction,
  type StreamingPlan,
  type SectorPopulationSave,
  type DistrictSettings,
} from './district';

export {
  HordeEvent,
  evaluateHordeEvent,
  resolveHordeEventSettings,
  routeStatesFromModule,
  type RouteState,
  type HordeEventInput,
  type HordeEventOutcome,
  type HordeEventResult,
  type RoutePressure,
  type HordeEventSettings,
  type HordeEventPhase,
} from './hordeEvent';
