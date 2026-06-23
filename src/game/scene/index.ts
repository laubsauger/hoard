// T41 — scene lane barrel: the GATE-0 authored test block.

export {
  buildTestBlock,
  isWalkableRadius,
  hasLineOfSight,
  rayDistanceToWall,
  castVisibilityFan,
  seesWithinFan,
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
export {
  DoorSystem,
  doorAxis,
  isDoorCell,
  type DoorAccess,
  type DoorView,
} from './doors';
export {
  lootableContainerCells,
  type ContainerPlacement,
} from './containers';
export {
  WindowSystem,
  windowPlacements,
  featureBuildingIndexOf,
  houseStyleForBuilding,
  type WindowGlass,
  type WindowView,
  type WindowPlacement,
  type WindowPlacementOptions,
  type WindowSystemConfig,
} from './windows';
export {
  authorHouseStyle,
  resolveHouseVariation,
  windowState,
  roofHoles,
  hash01,
  type HouseStyle,
  type HouseVariationParams,
  type RoofShape,
  type WindowState,
  type RoofHole,
} from './houseStyle';
