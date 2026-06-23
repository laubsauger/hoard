// T55 / V18 / V24 / V33 — pooled instanced CORPSE field. The killed-zombie bodies the CorpseSystem holds
// (V18 / B9) are rendered as ONE shared InstancedMesh of toppled, settled bodies lying on the ground — no
// per-corpse object/material. Pure render view (V2): it MIRRORS the sim's public corpse list each frame and
// never feeds the sim back. r184 binding-safe (V33): SOLID box geometry + a PRE-CREATED instanceColor
// InstancedBufferAttribute (no lazy setColorAt on an unallocated binding), dynamic-usage matrices, capped at
// the configured corpse capacity. Every GPU resource is tracked for disposal (V24). Dismemberment carried on
// the corpse (severed-region bitfield) darkens the body so a dismembered corpse reads as one.

import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  type Scene,
} from 'three';
import { resolveDomain } from '../../config/registry';
import { zombiesConfig } from '../../config/domains/zombies';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import type { Corpse } from '../../game/zombie';

// Desaturated, decayed-flesh tone — clearly distinct from the live crowd's greenish tint so a body reads as
// dead, not active. Per-instance brightness drops with dismemberment (severed-region count).
const CORPSE_BASE_COLOR = new Color(0x3a3026);
// Toppled body box (a flattened humanoid, mirroring the crowd's capsule-ish box, laid on its back/side).
const CORPSE_BODY_WIDTH = 0.55;
const CORPSE_BODY_HEIGHT = 1.8;
const CORPSE_BODY_DEPTH = 0.4;
// Lift the toppled body so it rests ON the ground (half its post-rotation thickness clears the floor).
const CORPSE_LIE_HEIGHT = 0.2;
// Pitched flat (a 90° topple onto the ground plane), then yawed by the body's last heading.
const CORPSE_TOPPLE_PITCH = Math.PI / 2;
// Each severed region darkens the body by this fraction, floored so a fully dismembered corpse stays visible.
const CORPSE_SEVER_DARKEN = 0.12;
const CORPSE_MIN_BRIGHTNESS = 0.4;
const SEVER_FLAG_BITS = 8; // anatomyFlags occupies the low 8 region bits (head..legRight) — see combat/anatomy.

export interface CorpseFieldSettings {
  readonly capacity: number;
}

/** Resolve the corpse render capacity for a tier — mirrors the sim corpse pool (V4, no literal cap). */
export function resolveCorpseFieldSettings(tier: QualityTier): CorpseFieldSettings {
  return { capacity: resolveDomain(zombiesConfig, tier).corpseCapacity };
}

/** Count set region bits in the low 8 bits of the anatomyFlags sever bitfield (how many limbs/head gone). */
function severedCount(flags: number): number {
  let n = 0;
  for (let b = 0; b < SEVER_FLAG_BITS; b++) if ((flags & (1 << b)) !== 0) n += 1;
  return n;
}

export class CorpseField {
  readonly mesh: InstancedMesh;
  readonly settings: CorpseFieldSettings;

  private readonly geometry: BoxGeometry;
  private readonly material: MeshStandardMaterial;
  private readonly dummy = new Object3D();
  private readonly tmp = new Color();

  constructor(settings: CorpseFieldSettings, registry: ResourceRegistry) {
    this.settings = settings;
    const cap = Math.max(1, settings.capacity);

    this.geometry = registry.track(
      new BoxGeometry(CORPSE_BODY_WIDTH, CORPSE_BODY_HEIGHT, CORPSE_BODY_DEPTH),
      'geometry',
      'corpse.geometry',
    );
    this.material = registry.track(
      new MeshStandardMaterial({ name: 'corpse.material', roughness: 0.95, metalness: 0 }),
      'material',
      'corpse.material',
    );
    this.mesh = registry.track(new InstancedMesh(this.geometry, this.material, cap), 'buffer', 'corpse.instancedMesh');

    // r184 binding-safe: dynamic-usage matrices + a PRE-CREATED instanceColor binding; start with 0 drawn.
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    const colors = new Float32Array(cap * 3).fill(1);
    this.mesh.instanceColor = new InstancedBufferAttribute(colors, 3);
    this.mesh.instanceColor.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false; // corpses span large bounds; cheap, capped count
    // T45/V36/B13: settled bodies cast + receive the directional shadow so they read as grounded, not floating.
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
  }

  /** Add the corpse mesh to the scene graph (parent owns graph membership; registry owns disposal — V24). */
  attachTo(scene: Scene | Object3D): void {
    scene.add(this.mesh);
  }

  /**
   * Mirror the CorpseSystem's live records onto the instanced batch: each body toppled flat, yawed by its
   * last heading, settled on the ground, and darkened by how many regions were severed. Caps at capacity
   * (the sim already recycles the oldest, so an over-cap list is not expected). Returns the drawn count.
   */
  update(corpses: readonly Corpse[]): number {
    const n = Math.min(corpses.length, this.settings.capacity);
    for (let i = 0; i < n; i++) {
      const c = corpses[i]!;
      this.dummy.position.set(c.x, CORPSE_LIE_HEIGHT, c.z);
      this.dummy.rotation.set(CORPSE_TOPPLE_PITCH, c.heading, 0);
      this.dummy.scale.setScalar(1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);

      const dim = Math.max(CORPSE_MIN_BRIGHTNESS, 1 - severedCount(c.severedFlags) * CORPSE_SEVER_DARKEN);
      this.tmp.setRGB(CORPSE_BASE_COLOR.r * dim, CORPSE_BASE_COLOR.g * dim, CORPSE_BASE_COLOR.b * dim);
      this.mesh.setColorAt(i, this.tmp);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return n;
  }
}
