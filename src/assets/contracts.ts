// T34 / V7 / V17 / V18 / V24 — asset contract types (the "asset handout").
// These describe the SHAPE every shippable runtime asset must declare. The validator (src/tools)
// checks a concrete descriptor against typed budgets + the skeleton family registry. Nothing here
// invents fallbacks: missing/invalid data is rejected by validation, never silently defaulted (V7).

import type { QualityTier } from '@/config/types';
import type {
  BoneCount,
  Bytes,
  Count,
  Degrees,
  Meters,
  Ratio,
  Triangles,
} from './units';
import type { SourceProvenance } from './provenance';

// ---- Shared sub-contracts ----

/** Signed cardinal axis in the asset's local space. */
export type Axis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

/** Scale + axis convention so the asset imports into the engine at correct size/orientation. */
export interface ScaleContract {
  /** Source units per world meter (e.g. 1 = meters, 100 = centimeters). */
  readonly unitsPerMeter: Ratio;
  readonly upAxis: Axis;
  readonly forwardAxis: Axis;
  readonly handedness: 'right' | 'left';
  /** Authored character/structure height target, used for sanity-checking import scale. */
  readonly targetHeightM: Meters;
}

export type Vec3M = readonly [Meters, Meters, Meters];
export type Vec3Deg = readonly [Degrees, Degrees, Degrees];

export interface BoneTransform {
  readonly translation: Vec3M;
  readonly rotationEuler: Vec3Deg;
}

/** Bind pose: one local transform per named bone. */
export type BindPose = Readonly<Record<string, BoneTransform>>;

/** Skeleton the rig conforms to. Bone names must belong to a registered family (see skeleton.ts). */
export interface SkeletonContract {
  readonly familyId: string;
  /** Bones actually present in this rig (must be a subset of the family's approved bones). */
  readonly bones: readonly string[];
  readonly bindPose: BindPose;
}

/** A named render section + the bones that own it (for hit detection + dismemberment, V17). */
export interface AnatomicalRegion {
  readonly id: string;
  /** Named render section the region maps to in the delivered geometry. */
  readonly renderSection: string;
  /** Bone ownership for hit/sever resolution. */
  readonly bones: readonly string[];
  readonly detachable: boolean;
  /** Head destruction fatal unless an archetype overrides (V17). */
  readonly headFatal: boolean;
  /** Damage fraction (0..1) at which the region severs. */
  readonly severThreshold: Ratio;
  /** Wound-cap geometry shown after sever (V17). Required when detachable. */
  readonly woundCapRef: string | null;
  /** Detached-part asset shown as a pooled prop after sever (V17). Required when detachable. */
  readonly detachedPartRef: string | null;
}

/** LOD tiers: hero (close skinned), crowd (instanced), horde (cheap), impostor (billboard). */
export type LodLevel = 'hero' | 'crowd' | 'horde' | 'impostor';

export const LOD_LEVELS: readonly LodLevel[] = ['hero', 'crowd', 'horde', 'impostor'];

export interface LodEntry {
  readonly level: LodLevel;
  readonly geometryRef: string;
  readonly triangles: Triangles;
  /** Distance at which this LOD activates (nearest first). */
  readonly activationDistanceM: Meters;
}

export interface LodChain {
  readonly levels: readonly LodEntry[];
}

/** Approved material family + the named slots the asset uses. */
export interface MaterialFamilyContract {
  readonly familyId: string;
  readonly materialSlots: readonly string[];
}

/** Texture delivery is GPU-compressed only (KTX2/Basis), per R17 / V7. */
export type TextureFormat = 'ktx2-uastc' | 'ktx2-etc1s' | 'basis';

export const TEXTURE_FORMATS: readonly TextureFormat[] = ['ktx2-uastc', 'ktx2-etc1s', 'basis'];

export interface TextureEntry {
  readonly id: string;
  readonly format: TextureFormat;
  /** Square texture edge length in pixels. */
  readonly resolutionPx: Count;
  readonly memoryBytes: Bytes;
}

export interface TextureDeliveryContract {
  readonly textures: readonly TextureEntry[];
}

/** Geometry delivery container (glTF/GLB), per R7. */
export type GeometryContainer = 'gltf' | 'glb';

export interface GeometryDeliveryContract {
  readonly container: GeometryContainer;
  readonly drawGroups: Count;
}

export interface CapsuleProxy {
  readonly radiusM: Meters;
  readonly heightM: Meters;
}

export interface AnatomicalCollisionProxy {
  readonly regionId: string;
  readonly radiusM: Meters;
  readonly heightM: Meters;
}

/** Collision is separate from visual mesh (V6). A missing proxy is a hard error, never silent (V7). */
export interface CollisionContract {
  readonly groundFootprintRadiusM: Meters;
  readonly bodyCapsule: CapsuleProxy;
  /** One proxy per detachable region so dismembered hits still resolve. */
  readonly anatomicalProxies: readonly AnatomicalCollisionProxy[];
}

/** Per-asset performance metadata used by the validator + downstream tier scheduling. */
export interface PerformanceMetadata {
  readonly trianglesByLod: Readonly<Record<LodLevel, Triangles>>;
  readonly textureMemoryBytes: Bytes;
  readonly boneCount: BoneCount;
  readonly drawGroups: Count;
  readonly expectedTiers: readonly QualityTier[];
}

// ---- Zombie asset contract ----

export interface ZombieAssetContract {
  readonly kind: 'zombie';
  readonly id: string;
  readonly provenance: SourceProvenance;
  readonly scale: ScaleContract;
  readonly skeleton: SkeletonContract;
  readonly regions: readonly AnatomicalRegion[];
  readonly lods: LodChain;
  readonly material: MaterialFamilyContract;
  readonly textures: TextureDeliveryContract;
  readonly geometry: GeometryDeliveryContract;
  readonly collision: CollisionContract;
  readonly performance: PerformanceMetadata;
}

// ---- Environment asset contract ----

export interface InteriorLayer {
  readonly id: string;
  readonly geometryRef: string;
}

/** A fracture family + the structural cells it maps to (V18 / V30: breach hides cell shape). */
export interface FractureFamily {
  readonly id: string;
  /** Structural-damage fraction (0..1) that triggers this breach. */
  readonly breachThreshold: Ratio;
  readonly debrisPartRefs: readonly string[];
  /** Structural cell ids this family fractures — must map into the module's structural mapping. */
  readonly structuralCellIds: readonly string[];
}

/** Maps the asset onto a `StructuralModule`'s sparse occupancy cells (I.structs). */
export interface StructuralMapping {
  readonly moduleId: string;
  readonly cellIds: readonly string[];
}

export type CollisionState = 'intact' | 'breached' | 'rubble';

export interface EnvironmentCollisionState {
  readonly state: CollisionState;
  readonly proxyRef: string;
}

export interface EnvironmentAssetContract {
  readonly kind: 'environment';
  readonly id: string;
  readonly provenance: SourceProvenance;
  readonly scale: ScaleContract;
  readonly intactMeshRef: string;
  readonly interiorLayers: readonly InteriorLayer[];
  readonly fractureFamilies: readonly FractureFamily[];
  readonly structuralMapping: StructuralMapping;
  readonly lods: LodChain;
  readonly material: MaterialFamilyContract;
  readonly textures: TextureDeliveryContract;
  readonly geometry: GeometryDeliveryContract;
  /** Collision proxy per structural state (V6 separate collision, V18 same state feeds all systems). */
  readonly collisionStates: readonly EnvironmentCollisionState[];
  readonly performance: PerformanceMetadata;
}

/** Discriminated union of every shippable asset descriptor. */
export type AssetContract = ZombieAssetContract | EnvironmentAssetContract;

export type AssetKind = AssetContract['kind'];
