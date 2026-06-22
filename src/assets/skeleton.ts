// T34 / V7 / V17 — approved skeleton families.
// A rig is only valid if its family is registered here and every required bone is present. The
// validator rejects unapproved bone names so dismemberment region ownership stays consistent.

export interface SkeletonFamily {
  readonly id: string;
  readonly rootBone: string;
  /** Bones that MUST exist in every rig of this family. */
  readonly requiredBones: readonly string[];
  /** Full set of allowed bone names (superset of requiredBones; extras are optional). */
  readonly approvedBones: readonly string[];
}

const HUMANOID_REQUIRED: readonly string[] = [
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

const HUMANOID_OPTIONAL: readonly string[] = [
  'jaw',
  'spine_03',
  'toe_l',
  'toe_r',
  'finger_l',
  'finger_r',
];

const HUMANOID_ZOMBIE: SkeletonFamily = {
  id: 'humanoid-zombie',
  rootBone: 'root',
  requiredBones: HUMANOID_REQUIRED,
  approvedBones: [...HUMANOID_REQUIRED, ...HUMANOID_OPTIONAL],
};

const FAMILIES: Readonly<Record<string, SkeletonFamily>> = {
  [HUMANOID_ZOMBIE.id]: HUMANOID_ZOMBIE,
};

export function getSkeletonFamily(id: string): SkeletonFamily | undefined {
  return FAMILIES[id];
}

export function skeletonFamilyIds(): readonly string[] {
  return Object.keys(FAMILIES);
}
