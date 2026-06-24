// T41 — scene lane barrel: the GATE-0 authored test block.

export {
  buildTestBlock,
  isWalkableRadius,
  levelNavOf,
  gridWalkableWorld,
  gridWalkableRadius,
  segmentCrossesWall,
  hasLineOfSight,
  gridHasLineOfSight,
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
  type PlacedFurniture,
} from './testBlock';
export {
  furnishRoom,
  furnitureFits,
  furnitureLeavesPathClear,
  pieceCells,
  type FurniturePiece,
  type FurnitureKind,
  type FurnishRoomArgs,
  type RoomWindow,
} from './furnishRoom';
export { furnishHouse } from './furnishHouse';
export {
  FURNITURE_SOLIDITY,
  isFurnitureSolid,
  furnitureBlockedCells,
  setFurnitureSolid,
} from './furnitureSolidity';
export { buildCityBlock, CITY_BLOCK_WORLD_VERSION, REGION_STREET } from './cityBlock';
export { buildCityDistrict, CITY_DISTRICT_WORLD_VERSION, type CityDistrict } from './cityDistrict';
export {
  placeHouse,
  isSingleStorey,
  type PlacedHouse,
  type PlacedRoomCell,
  type PlacedDoor,
  type PlacedWindow,
  type WallEdge,
  type WallKind,
} from './placeHouse';
export {
  HOUSE_TEMPLATES,
  tileCheck,
  doorGraphConnected,
  reachableFromExterior,
  doorPlacementValid,
  windowOnExterior,
  inFootprint,
  cellInRoom,
  roomCells,
  type HouseTemplate,
  type FloorPlan,
  type Footprint,
  type Room,
  type RoomType,
  type Door,
  type WindowSpec,
  type Edge,
  type Cell,
} from './houseTemplates';
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
