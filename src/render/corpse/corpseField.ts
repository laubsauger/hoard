// T55 / V18 / V24 / V33 — pooled instanced CORPSE field. A killed zombie (V18 / B9) is rendered as the SAME
// block-limbed humanoid as the live crowd (head/torso/arms/legs), but TOPPLED flat on the ground — so a body
// reads as a dead version of the thing that was walking, NOT a generic box. ONE shared InstancedMesh PER BODY
// PART (mirroring CrowdLimbs), composed per corpse into a lying pose. DISMEMBERMENT PERSISTS THROUGH DEATH
// (V17): a part whose region bit is set in the corpse's `severedFlags` is hidden (degenerate matrix), so a
// one-armed zombie leaves a one-armed corpse. Pure render view (V2): mirrors the sim corpse list each frame,
// never feeds back. r184 binding-safe (V33): solid box geo + pre-created instanceColor, dynamic-usage matrices,
// capped at the configured corpse capacity. Every GPU resource is tracked for disposal (V24).

import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  type Scene,
  type Object3D,
} from 'three';
import { resolveDomain } from '../../config/registry';
import { zombiesConfig } from '../../config/domains/zombies';
import { CROWD_LIMB_PARTS } from '../../config/domains/rendering';
import { regionBit } from '../../game/combat/anatomy';
import type { AnatomyRegion } from '../../game/core/contracts/events';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import type { Corpse } from '../../game/zombie';

// Desaturated, decayed-flesh tone — distinct from the live crowd's greenish tint so a body reads as dead.
const CORPSE_BASE_COLOR = new Color(0x3a3026);
// Lift the toppled body so it rests ON the ground/slab (roughly half a torso thickness clears the surface).
const CORPSE_LIE_HEIGHT = 0.18;
// A 90° topple onto the ground plane (the standing figure tips flat), then yawed by the body's last heading.
const CORPSE_TOPPLE_PITCH = Math.PI / 2;

// Render part id -> SoA anatomy region for the sever-hide (V17). Torso is never severable → null (always shown).
const PART_REGION: Readonly<Record<string, AnatomyRegion | null>> = {
  torso: null,
  head: 'head',
  armLeft: 'armLeft',
  armRight: 'armRight',
  legLeft: 'legLeft',
  legRight: 'legRight',
};

export interface CorpseFieldSettings {
  readonly capacity: number;
}

/** Resolve the corpse render capacity for a tier — mirrors the sim corpse pool (V4, no literal cap). */
export function resolveCorpseFieldSettings(tier: QualityTier): CorpseFieldSettings {
  return { capacity: resolveDomain(zombiesConfig, tier).corpseCapacity };
}

export class CorpseField {
  readonly settings: CorpseFieldSettings;

  /** One InstancedMesh per body part (same part order as CROWD_LIMB_PARTS), each capped at corpse capacity. */
  private readonly partMeshes: InstancedMesh[] = [];
  /** Per-part sever bit (0 = torso, never hidden) + local center offset from the feet origin. */
  private readonly partSeverBit: number[] = [];
  private readonly partOffset: [number, number, number][] = [];

  // Scratch transforms (no per-corpse/per-part allocation, V24).
  private readonly bodyM = new Matrix4();
  private readonly rotM = new Matrix4();
  private readonly offM = new Matrix4();
  private readonly partM = new Matrix4();
  private readonly zeroM = new Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  private readonly tmp = new Color();

  constructor(settings: CorpseFieldSettings, registry: ResourceRegistry) {
    this.settings = settings;
    const cap = Math.max(1, settings.capacity);

    for (const part of CROWD_LIMB_PARTS) {
      const geo = registry.track(
        new BoxGeometry(part.size[0], part.size[1], part.size[2]),
        'geometry',
        `corpse.limbGeo.${part.id}`,
      );
      const mat = registry.track(
        new MeshStandardMaterial({ name: `corpse.limb.${part.id}`, roughness: 0.95, metalness: 0 }),
        'material',
        `corpse.limbMat.${part.id}`,
      );
      const mesh = registry.track(new InstancedMesh(geo, mat, cap), 'buffer', `corpse.limbMesh.${part.id}`);
      // r184 binding-safe: dynamic-usage matrices + a PRE-CREATED instanceColor binding; start with 0 drawn.
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      const colors = new Float32Array(cap * 3).fill(1);
      mesh.instanceColor = new InstancedBufferAttribute(colors, 3);
      mesh.instanceColor.setUsage(DynamicDrawUsage);
      mesh.frustumCulled = false; // bodies span large bounds; cheap, capped count
      // T45/V36/B13: settled bodies cast + receive the directional shadow so they read as grounded, not floating.
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      this.partMeshes.push(mesh);

      const region = PART_REGION[part.id] ?? null;
      this.partSeverBit.push(region ? regionBit(region) : 0);
      this.partOffset.push([part.offset[0], part.offset[1], part.offset[2]]);
    }
  }

  /** The per-body-part instanced meshes (same order as CROWD_LIMB_PARTS) — exposed for tests/diagnostics. */
  get meshes(): readonly InstancedMesh[] {
    return this.partMeshes;
  }

  /** Add every corpse part mesh to the scene graph (parent owns membership; registry owns disposal — V24). */
  attachTo(scene: Scene | Object3D): void {
    for (const m of this.partMeshes) scene.add(m);
  }

  /**
   * Mirror the CorpseSystem's live records onto the instanced batches: each body composed as a toppled limbed
   * figure (yawed by its last heading, settled on the ground), with any SEVERED part hidden (V17 — persists
   * dismemberment through death). Caps at capacity (the sim recycles the oldest). Returns the drawn count.
   */
  update(corpses: readonly Corpse[]): number {
    const n = Math.min(corpses.length, this.settings.capacity);
    for (let ci = 0; ci < n; ci++) {
      const c = corpses[ci]!;
      // Body transform = T(pos + lie) · RotY(heading) · RotX(topple): the standing figure tips flat + yaws.
      this.bodyM.makeTranslation(c.x, c.y + CORPSE_LIE_HEIGHT, c.z);
      this.rotM.makeRotationY(c.heading);
      this.bodyM.multiply(this.rotM);
      this.rotM.makeRotationX(CORPSE_TOPPLE_PITCH);
      this.bodyM.multiply(this.rotM);

      for (let p = 0; p < this.partMeshes.length; p++) {
        const mesh = this.partMeshes[p]!;
        const bit = this.partSeverBit[p]!;
        const severed = bit !== 0 && (c.severedFlags & bit) !== 0;
        if (severed) {
          mesh.setMatrixAt(ci, this.zeroM); // V17 — the part was shot off; it stays gone on the corpse
        } else {
          const o = this.partOffset[p]!;
          this.partM.multiplyMatrices(this.bodyM, this.offM.makeTranslation(o[0], o[1], o[2]));
          mesh.setMatrixAt(ci, this.partM);
        }
        this.tmp.setRGB(CORPSE_BASE_COLOR.r, CORPSE_BASE_COLOR.g, CORPSE_BASE_COLOR.b);
        mesh.setColorAt(ci, this.tmp);
      }
    }
    for (const mesh of this.partMeshes) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    return n;
  }
}
