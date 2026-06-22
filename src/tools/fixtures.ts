// T34 — test fixtures: well-formed descriptors that pass validation, plus mutation helpers.
// Not a runtime asset; used only by the *.test.ts files in this lane.

import {
  boneCount,
  bytes,
  count,
  degrees,
  meters,
  ratio,
  triangles,
  type BindPose,
  type EnvironmentAssetContract,
  type LodChain,
  type SourceProvenance,
  type ZombieAssetContract,
} from '@/assets';

const provenance: SourceProvenance = {
  sourceUri: 'source://capture/zombie-shambler-001.png',
  generator: 'image-to-3d',
  capturedAtIso: '2026-06-22T10:00:00.000Z',
  license: { id: 'studio-internal-1.0', attribution: '', redistributable: true, commercialUse: true },
};

const RIG_BONES: readonly string[] = [
  'root',
  'pelvis',
  'spine_01',
  'spine_02',
  'neck',
  'head',
  'shoulder_l',
  'upperarm_l',
  'lowerarm_l',
  'hand_l',
  'shoulder_r',
  'upperarm_r',
  'lowerarm_r',
  'hand_r',
  'thigh_l',
  'calf_l',
  'foot_l',
  'thigh_r',
  'calf_r',
  'foot_r',
];

function bindPoseFor(bones: readonly string[]): BindPose {
  const pose: Record<string, BindPose[string]> = {};
  for (const bone of bones) {
    pose[bone] = {
      translation: [meters(0), meters(0), meters(0)],
      rotationEuler: [degrees(0), degrees(0), degrees(0)],
    };
  }
  return pose;
}

const zombieLods: LodChain = {
  levels: [
    { level: 'hero', geometryRef: 'geo://zombie/hero', triangles: triangles(40_000), activationDistanceM: meters(0) },
    { level: 'crowd', geometryRef: 'geo://zombie/crowd', triangles: triangles(10_000), activationDistanceM: meters(8) },
    { level: 'horde', geometryRef: 'geo://zombie/horde', triangles: triangles(2_500), activationDistanceM: meters(25) },
    { level: 'impostor', geometryRef: 'geo://zombie/impostor', triangles: triangles(120), activationDistanceM: meters(60) },
  ],
};

export function makeZombieContract(): ZombieAssetContract {
  return {
    kind: 'zombie',
    id: 'zombie.shambler.001',
    provenance,
    scale: {
      unitsPerMeter: ratio(1),
      upAxis: '+y',
      forwardAxis: '+z',
      handedness: 'right',
      targetHeightM: meters(1.8),
    },
    skeleton: {
      familyId: 'humanoid-zombie',
      bones: [...RIG_BONES],
      bindPose: bindPoseFor(RIG_BONES),
    },
    regions: [
      {
        id: 'head',
        renderSection: 'sec_head',
        bones: ['head', 'neck'],
        detachable: true,
        headFatal: true,
        severThreshold: ratio(0.8),
        woundCapRef: 'cap://head',
        detachedPartRef: 'part://head',
      },
      {
        id: 'arm_l',
        renderSection: 'sec_arm_l',
        bones: ['upperarm_l', 'lowerarm_l', 'hand_l'],
        detachable: true,
        headFatal: false,
        severThreshold: ratio(0.6),
        woundCapRef: 'cap://arm_l',
        detachedPartRef: 'part://arm_l',
      },
      {
        id: 'torso',
        renderSection: 'sec_torso',
        bones: ['spine_01', 'spine_02', 'pelvis'],
        detachable: false,
        headFatal: false,
        severThreshold: ratio(1),
        woundCapRef: null,
        detachedPartRef: null,
      },
    ],
    lods: zombieLods,
    material: { familyId: 'zombie-skin', materialSlots: ['body', 'head', 'clothing'] },
    textures: {
      textures: [
        { id: 'body_albedo', format: 'ktx2-uastc', resolutionPx: count(2048), memoryBytes: bytes(6 * 1024 * 1024) },
        { id: 'body_normal', format: 'ktx2-uastc', resolutionPx: count(2048), memoryBytes: bytes(6 * 1024 * 1024) },
      ],
    },
    geometry: { container: 'glb', drawGroups: count(3) },
    collision: {
      groundFootprintRadiusM: meters(0.45),
      bodyCapsule: { radiusM: meters(0.4), heightM: meters(1.8) },
      anatomicalProxies: [
        { regionId: 'head', radiusM: meters(0.14), heightM: meters(0.24) },
        { regionId: 'arm_l', radiusM: meters(0.08), heightM: meters(0.6) },
      ],
    },
    performance: {
      trianglesByLod: {
        hero: triangles(40_000),
        crowd: triangles(10_000),
        horde: triangles(2_500),
        impostor: triangles(120),
      },
      textureMemoryBytes: bytes(12 * 1024 * 1024),
      boneCount: boneCount(20),
      drawGroups: count(3),
      expectedTiers: ['desktop-high', 'desktop-medium'],
    },
  };
}

export function makeEnvironmentContract(): EnvironmentAssetContract {
  return {
    kind: 'environment',
    id: 'env.wall.brick.001',
    provenance: { ...provenance, sourceUri: 'source://capture/brick-wall.png' },
    scale: {
      unitsPerMeter: ratio(1),
      upAxis: '+y',
      forwardAxis: '+z',
      handedness: 'right',
      targetHeightM: meters(3),
    },
    intactMeshRef: 'geo://wall/intact',
    interiorLayers: [{ id: 'cavity', geometryRef: 'geo://wall/cavity' }],
    fractureFamilies: [
      {
        id: 'breach_lower',
        breachThreshold: ratio(0.5),
        debrisPartRefs: ['part://brick_a', 'part://brick_b'],
        structuralCellIds: ['c0', 'c1'],
      },
    ],
    structuralMapping: { moduleId: 'mod.wall.001', cellIds: ['c0', 'c1', 'c2', 'c3'] },
    lods: {
      levels: [
        { level: 'hero', geometryRef: 'geo://wall/hero', triangles: triangles(30_000), activationDistanceM: meters(0) },
        { level: 'crowd', geometryRef: 'geo://wall/crowd', triangles: triangles(8_000), activationDistanceM: meters(15) },
        { level: 'horde', geometryRef: 'geo://wall/horde', triangles: triangles(2_000), activationDistanceM: meters(40) },
      ],
    },
    material: { familyId: 'masonry', materialSlots: ['brick', 'mortar'] },
    textures: {
      textures: [
        { id: 'wall_albedo', format: 'ktx2-etc1s', resolutionPx: count(2048), memoryBytes: bytes(8 * 1024 * 1024) },
      ],
    },
    geometry: { container: 'glb', drawGroups: count(2) },
    collisionStates: [
      { state: 'intact', proxyRef: 'col://wall/intact' },
      { state: 'breached', proxyRef: 'col://wall/breached' },
      { state: 'rubble', proxyRef: 'col://wall/rubble' },
    ],
    performance: {
      trianglesByLod: {
        hero: triangles(30_000),
        crowd: triangles(8_000),
        horde: triangles(2_000),
        impostor: triangles(0),
      },
      textureMemoryBytes: bytes(8 * 1024 * 1024),
      boneCount: boneCount(0),
      drawGroups: count(2),
      expectedTiers: ['desktop-high', 'desktop-medium', 'desktop-compat'],
    },
  };
}
