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
import { variationHash01, variationTint } from '../crowd/packing';

// Desaturated, decayed-flesh tone — distinct from the live crowd's greenish tint so a body reads as dead.
const CORPSE_BASE_COLOR = new Color(0x3a3026);
// Lift the toppled body so it rests ON the ground/slab (roughly half a torso thickness clears the surface).
const CORPSE_LIE_HEIGHT = 0.18;
// A 90° topple onto the ground plane (the standing figure tips flat), then yawed by the body's last heading.
const CORPSE_TOPPLE_PITCH = Math.PI / 2;
// T122/V87 — per-corpse SIZE + TINT variation (matches the live crowd's variation model so a body keeps reading as
// a varied figure, not a clone). Seeded by the dead entity id (stable, deterministic — V26), NEVER Math.random.
const CORPSE_SCALE_MIN = 0.9;
const CORPSE_SCALE_MAX = 1.1;
const CORPSE_TINT_HUE_SPREAD = 0.1;
const CORPSE_TINT_VALUE_SPREAD = 0.16;
const CORPSE_SCALE_SALT = 0x3333;
const CORPSE_HUE_SALT = 0x4444;
const CORPSE_VAL_SALT = 0x5555;

/**
 * Death-collapse progress 0..1 (T122/V87): how far a fresh corpse has toppled from standing → prone, by tick age.
 * 0 = just died (still upright, matching where the live figure stood); 1 = fully settled flat. Pure/deterministic.
 */
export function collapseProgress(ageTicks: number, collapseTicks: number): number {
  if (collapseTicks <= 0) return 1;
  const t = ageTicks / collapseTicks;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Smoothstep ease for the topple — a soft start + soft landing so the fall reads as a controlled collapse, not a
 *  hard slam or a teleport (T122/V87). Pure. */
export function collapseEase(p: number): number {
  const x = p < 0 ? 0 : p > 1 ? 1 : p;
  return x * x * (3 - 2 * x);
}

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
  /** Ticks a fresh body takes to topple standing → prone (the death collapse, T122/V87). */
  readonly collapseTicks: number;
}

/** Resolve the corpse render capacity + collapse duration for a tier — mirrors the sim corpse pool (V4). */
export function resolveCorpseFieldSettings(tier: QualityTier): CorpseFieldSettings {
  const z = resolveDomain(zombiesConfig, tier);
  return { capacity: z.corpseCapacity, collapseTicks: z.corpseCollapseTicks };
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
  private readonly sclM = new Matrix4();
  private readonly offM = new Matrix4();
  private readonly partM = new Matrix4();
  private readonly zeroM = new Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  private readonly tmp = new Color();
  private readonly tintScratch = new Float32Array(3);

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
   * Mirror the CorpseSystem's live records onto the instanced batches: each body composed as a limbed figure that
   * COLLAPSES standing → prone over `collapseTicks` (T122/V87 — no instant teleport-to-floor), yawed by its last
   * heading + settled on the ground, with any SEVERED part hidden (V17 — persists dismemberment through death).
   * `nowAbsTick` is the absolute sim tick the corpse `bornTick` was stamped in (the runtime's `absoluteTick`): a
   * fresh body (age 0) stands upright where the live figure was; a settled / save-restored one (age ≥ collapse)
   * reads fully prone. Per-corpse size + tint are jittered by the dead entity id (stable, deterministic — V26).
   * Caps at capacity (the sim recycles the oldest). Returns the drawn count.
   */
  update(corpses: readonly Corpse[], nowAbsTick: number): number {
    const n = Math.min(corpses.length, this.settings.capacity);
    const collapseTicks = this.settings.collapseTicks;
    for (let ci = 0; ci < n; ci++) {
      const c = corpses[ci]!;
      // Death collapse: ease the topple pitch 0 → 90° by tick age, pivoting about the feet so the body tips over.
      const progress = collapseProgress(nowAbsTick - c.bornTick, collapseTicks);
      const pitch = collapseEase(progress) * CORPSE_TOPPLE_PITCH;
      // The lift eases from a ground-standing 0 to the prone clearance so the settled body rests ON the surface.
      const lift = CORPSE_LIE_HEIGHT * progress;
      // Per-corpse size variation (stable per entity) — keeps a body reading as a varied figure (T122/V87).
      const sUnit = variationHash01(c.entity >>> 0, CORPSE_SCALE_SALT);
      const scale = CORPSE_SCALE_MIN + (CORPSE_SCALE_MAX - CORPSE_SCALE_MIN) * sUnit;

      // Body transform = T(pos + lift) · RotY(heading) · RotX(pitch) · Scale: stands, topples, yaws + scales.
      this.bodyM.makeTranslation(c.x, c.y + lift, c.z);
      this.rotM.makeRotationY(c.heading);
      this.bodyM.multiply(this.rotM);
      this.rotM.makeRotationX(pitch);
      this.bodyM.multiply(this.rotM);
      this.bodyM.multiply(this.sclM.makeScale(scale, scale, scale));

      // Per-corpse tint (stable per entity) around the decayed-flesh base (T122/V87).
      const hueJit = variationHash01(c.entity >>> 0, CORPSE_HUE_SALT) * 2 - 1;
      const valJit = variationHash01(c.entity >>> 0, CORPSE_VAL_SALT) * 2 - 1;
      variationTint(
        CORPSE_BASE_COLOR.r,
        CORPSE_BASE_COLOR.g,
        CORPSE_BASE_COLOR.b,
        hueJit,
        valJit,
        CORPSE_TINT_HUE_SPREAD,
        CORPSE_TINT_VALUE_SPREAD,
        this.tintScratch,
        0,
      );
      this.tmp.setRGB(this.tintScratch[0]!, this.tintScratch[1]!, this.tintScratch[2]!);

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
