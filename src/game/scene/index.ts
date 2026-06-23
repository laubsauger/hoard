// T41 — scene lane barrel: the GATE-0 authored test block.

export {
  buildTestBlock,
  isWalkableRadius,
  hasLineOfSight,
  rayDistanceToWall,
  buildingsOf,
  TEST_BLOCK_WORLD_VERSION,
  REGION_ROOM_A,
  REGION_ROOM_B,
  type TestBlock,
  type CellXY,
  type CellRect,
  type Vec3,
  type BuildingFootprint,
  type GroundRect,
  type GroundKind,
  type PropInstance,
  type PropKind,
} from './testBlock';
export { buildCityBlock, CITY_BLOCK_WORLD_VERSION, REGION_STREET } from './cityBlock';
export { buildCityDistrict, CITY_DISTRICT_WORLD_VERSION, type CityDistrict } from './cityDistrict';
