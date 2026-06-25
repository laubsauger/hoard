// T127 — the RIGGED player avatar: a loaded GLB SkinnedMesh (`char1`, 24 bones) driven by an AnimationMixer
// + a small animation state machine, replacing the old procedural capsule body (playerBuilder). The avatar
// OWNS a synchronous root Group (positioned/faced each frame by BlockScene) and swaps the SkinnedMesh + mixer
// in when the GLB resolves (the scene builds synchronously; GLTFLoader is async — V24 tracks all GPU
// resources for disposal). State-machine decisions are PURE (selectClip + OneShotController) so they unit-test
// without a GPU; the class wires them onto three's AnimationMixer. A render-only view (V1/V2): it reads the
// runtime's stance/aim/move signals but never writes world state back.

import {
  AnimationMixer,
  Box3,
  Group,
  LoopOnce,
  LoopRepeat,
  Vector3,
  type AnimationAction,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type SkinnedMesh,
  type Texture,
} from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Disposable, ResourceKind } from '../engine/resources';
import { buildWeaponMeshes, buildFlashlightMesh, weaponVisualForItem, type WeaponVisual } from './weaponMesh';

/** Held-weapon seat in the RIGHT-HAND bone, in WORLD meters (counter-scaled by the bone's world scale on attach,
 *  so a meter-built mesh renders at meter size regardless of the rig's internal scale). Reasonable defaults — the
 *  exact palm seat / aim alignment may want a small visual tweak against the ranger rig (T141). */
const WEAPON_HOLD_OFFSET = { x: 0.0, y: -0.02, z: 0.0 };
const WEAPON_HOLD_EULER = { x: 0, y: 0, z: 0 };

/** The Ranger clips this avatar drives (a subset of the 9 in `ranger.glb`). */
export type RangerClip =
  | 'Idle_3'
  | 'Walking'
  | 'Running'
  | 'Crouch_Walk_with_Torch'
  | 'Hit_Reaction_1'
  | 'push_up'
  | 'Dead';

/** Clips that play ONCE then clamp (one-shots + the held death pose), vs the looping locomotion clips. */
const CLAMPED_CLIPS = new Set<string>(['Hit_Reaction_1', 'push_up', 'Dead']);

/** Crossfade durations (seconds): locomotion blends smoothly; one-shots snap in faster so a hit reads. */
const LOCOMOTION_FADE = 0.2;
const ONE_SHOT_FADE = 0.12;

/**
 * Y-rotation offset baked onto the avatar root so its mesh forward axis points along `playerAim()`.
 * playerAim() = atan2(dirZ, dirX), and root.rotation.y = -aim + OFFSET. The Ranger bind pose faces local
 * +Z, so OFFSET = +π/2 (a +Z-forward mesh rotated by π/2 - aim points its face along the aim/flashlight-nose
 * direction; cf. V41 single-sourced heading). Verified in the in-browser CDP check (the face tracks the
 * flashlight cone), NOT an ad-hoc per-mesh guess.
 */
export const RANGER_FORWARD_YAW_OFFSET = Math.PI / 2;

/** The pure inputs the clip selector maps to a clip (locomotion stance + the two one-shot flags + death). */
export interface AvatarSelectInputs {
  readonly moving: boolean;
  readonly sprinting: boolean;
  readonly crouching: boolean;
  readonly dead: boolean;
  readonly hitActive: boolean;
  readonly emoteActive: boolean;
}

/** The per-frame locomotion stance (the one-shot flags are owned by the controller, merged in `update`). */
export interface AvatarLocomotion {
  readonly moving: boolean;
  readonly sprinting: boolean;
  readonly crouching: boolean;
  readonly dead: boolean;
}

/**
 * PURE state → clip mapping (unit-tested). Precedence (highest first): dead holds `Dead`; the push-up emote;
 * the hit reaction; crouch-walk / crouch-idle (no crouch-idle clip → reuse Idle_3); run; walk; else idle.
 */
export function selectClip(s: AvatarSelectInputs): RangerClip {
  if (s.dead) return 'Dead';
  if (s.emoteActive) return 'push_up';
  if (s.hitActive) return 'Hit_Reaction_1';
  if (s.crouching && s.moving) return 'Crouch_Walk_with_Torch';
  if (s.crouching) return 'Idle_3';
  if (s.sprinting && s.moving) return 'Running';
  if (s.moving) return 'Walking';
  return 'Idle_3';
}

/** Which one-shot is active (`hit` reaction or `emote` push-up); mutually exclusive — a fresh request wins. */
export type OneShotKind = 'hit' | 'emote';

/**
 * Tiny one-shot controller (PURE, unit-tested): a hit or emote plays ONCE then returns to locomotion. A fresh
 * request overrides any active one-shot and bumps `version` so the avatar re-triggers it even when the same
 * kind is requested again (e.g. a second hit while already flinching). The avatar calls `finish(kind)` from the
 * mixer's `finished` event to clear it; `flags` feeds the pure clip selector.
 */
export class OneShotController {
  private active: OneShotKind | null = null;
  private seq = 0;

  request(kind: OneShotKind): void {
    this.active = kind;
    this.seq += 1;
  }

  /** Clear the active one-shot when its action finishes (ignored if a newer request already replaced it). */
  finish(kind: OneShotKind): void {
    if (this.active === kind) this.active = null;
  }

  get current(): OneShotKind | null {
    return this.active;
  }

  /** Monotonic request counter — the avatar restarts a one-shot when this changes (re-trigger same kind). */
  get version(): number {
    return this.seq;
  }

  get flags(): { hitActive: boolean; emoteActive: boolean } {
    return { hitActive: this.active === 'hit', emoteActive: this.active === 'emote' };
  }
}

/** Register a GLB-owned GPU resource for V24 disposal (geometry / material / texture). */
export type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;

export interface PlayerAvatarOptions {
  /** Target standing height (m) — the GLB is measured + scaled so the avatar stands this tall, feet at y=0. */
  readonly heightMeters: number;
}

/**
 * The rigged player avatar. The `root` Group exists from construction (BlockScene positions + faces it every
 * frame); the SkinnedMesh + mixer attach when the GLB resolves. `update(dt, locomotion)` advances the mixer +
 * runs the state machine (crossfading locomotion, one-shotting hit/emote). Tagged `userData.isPlayerAvatar`
 * so the blood/decal surface raycast excludes it (the rigged mesh has no CapsuleGeometry to key off — T127).
 */
export class PlayerAvatar {
  /** Positioned at the player + yaw-faced to the aim each frame by BlockScene. Tagged for the raycast exclusion. */
  readonly root = new Group();

  private readonly controller = new OneShotController();
  private readonly actions = new Map<RangerClip, AnimationAction>();
  private mixer: AnimationMixer | null = null;
  private currentClip: RangerClip | null = null;
  private lastOneShotVersion = 0;
  private loaded = false;
  private readonly heightMeters: number;

  // T141 — held weapon: the right-hand bone, prebuilt per-visual meshes (one parented at a time), and the
  // counter-scale that cancels the rig's world scale so a meter-built weapon renders at meter size.
  private handBone: Object3D | null = null;
  private invHandScale = 1;
  private weaponMeshes: Record<WeaponVisual, Object3D> | null = null;
  private currentWeaponVisual: WeaponVisual | null = null;
  private desiredWeaponItem: number | null = null;
  // T141 — off-hand (left) flashlight prop: parented to the left-hand bone, shown only while the beam is lit.
  private offHandLightMesh: Object3D | null = null;
  private offhandLightOn = false;

  constructor(opts: PlayerAvatarOptions) {
    this.heightMeters = opts.heightMeters;
    this.root.name = 'player.avatar';
    // T127: tag the WHOLE avatar so effectViews excludes it from the static-structure blood/decal raycast
    // (the old code keyed on CapsuleGeometry — the rigged mesh has none, so a tag is the stable signal).
    this.root.userData.isPlayerAvatar = true;
  }

  /** Whether the GLB has been swapped in (the mixer + skinned mesh are live). */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Swap the loaded GLB in: measure + scale to `heightMeters` (feet at y=0), stand it upright, track every GPU
   * resource for disposal (V24), and build the AnimationMixer + clip actions (one-shots clamp on finish).
   * Idempotent — a second call is ignored (one player, loaded once).
   */
  attachGltf(gltf: GLTF, track: TrackFn): void {
    if (this.loaded) return;
    const model = gltf.scene;

    // Measure the GLB as authored (the Armature carries a 0.01 cm→m scale), then scale uniformly so the avatar
    // stands `heightMeters` tall and re-seat so the feet rest on y=0 (the root sits at the player's ground point).
    const box = new Box3().setFromObject(model);
    const size = box.getSize(new Vector3());
    const factor = size.y > 0 ? this.heightMeters / size.y : 1;
    model.scale.multiplyScalar(factor);
    const seated = new Box3().setFromObject(model);
    model.position.y -= seated.min.y;

    // Collect unique GPU resources (one skinned mesh + one material here, but de-dup defensively — the registry
    // throws on a double-track). A skinned mesh's bind-pose bbox makes frustum culling wrong → disable it.
    const geos = new Set<Disposable>();
    const mats = new Set<Disposable>();
    const texs = new Set<Disposable>();
    model.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      if (mesh.geometry) geos.add(mesh.geometry as unknown as Disposable);
      const matList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of matList) {
        if (!m) continue;
        mats.add(m as unknown as Disposable);
        collectTextures(m as MeshStandardMaterial, texs); // track BEFORE normalize drops the emissive map (V24)
        normalizeRangerMaterial(m as MeshStandardMaterial);
      }
    });
    let i = 0;
    for (const g of geos) track(g, 'geometry', `player.ranger.geo.${i++}`);
    i = 0;
    for (const m of mats) track(m, 'material', `player.ranger.mat.${i++}`);
    i = 0;
    for (const t of texs) track(t, 'texture', `player.ranger.tex.${i++}`);

    this.root.add(model);

    // Mixer + per-clip actions. Locomotion clips loop; one-shots + Dead play once and clamp on the last frame.
    this.mixer = new AnimationMixer(model);
    for (const clip of gltf.animations) {
      const action = this.mixer.clipAction(clip);
      if (CLAMPED_CLIPS.has(clip.name)) {
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(LoopRepeat, Infinity);
      }
      this.actions.set(clip.name as RangerClip, action);
    }
    this.mixer.addEventListener('finished', this.onActionFinished);

    // T141: resolve the right-hand bone + prebuild the held-weapon meshes (tracked for V24), then seat whatever
    // weapon was requested before the GLB resolved.
    this.setupWeaponRig(model, track);
    this.loaded = true;
    this.applyWeapon();
  }

  /** Find the RIGHT-HAND bone, capture the inverse of its world scale (to render meter-built weapons at size),
   *  and build the per-visual weapon meshes (detached until `applyWeapon` parents the active one). */
  private setupWeaponRig(model: Object3D, track: TrackFn): void {
    let skinned: SkinnedMesh | undefined;
    model.traverse((o) => {
      if (!skinned && (o as SkinnedMesh).isSkinnedMesh) skinned = o as SkinnedMesh;
    });
    const bones = skinned?.skeleton.bones ?? [];
    this.handBone = bones.find((b) => b.name === 'RightHand') ?? null;
    model.updateWorldMatrix(true, true);
    if (this.handBone) {
      const s = this.handBone.getWorldScale(new Vector3());
      this.invHandScale = s.x > 0 ? 1 / s.x : 1;
    }
    this.weaponMeshes = buildWeaponMeshes(track);

    // T141: off-hand flashlight prop — parent to the LEFT-hand bone (counter-scaled), hidden until lit.
    const offBone = bones.find((b) => b.name === 'LeftHand') ?? null;
    if (offBone) {
      const inv = offBone.getWorldScale(new Vector3());
      const invScale = inv.x > 0 ? 1 / inv.x : 1;
      const mesh = buildFlashlightMesh(track);
      mesh.scale.setScalar(invScale);
      mesh.position.set(WEAPON_HOLD_OFFSET.x * invScale, WEAPON_HOLD_OFFSET.y * invScale, WEAPON_HOLD_OFFSET.z * invScale);
      mesh.visible = this.offhandLightOn; // apply any request made before the GLB attached
      offBone.add(mesh);
      this.offHandLightMesh = mesh;
    }
  }

  /** T141: show/hide the off-hand flashlight prop (the SpotLight beam itself lives in the scene's FlashlightSystem).
   *  Toggling a MESH's visibility is cheap (no pipeline recompile — unlike toggling a light, cf. the freeze fix). */
  setOffhandLight(on: boolean): void {
    this.offhandLightOn = on;
    if (this.offHandLightMesh) this.offHandLightMesh.visible = on;
  }

  /**
   * T141: show the equipped item's weapon mesh in the avatar's hand — `item` is the runtime's `equippedItem()`
   * (null = unarmed → no mesh). Cheap no-op when the visual is unchanged; if called before the GLB attaches it
   * records the request + applies on load. Drives off the SLOT/active-weapon source of truth (V102).
   */
  setWeapon(item: number | null): void {
    this.desiredWeaponItem = item;
    this.applyWeapon();
  }

  /** Parent the desired weapon visual to the hand bone (swapping out any previous), counter-scaled + seated. */
  private applyWeapon(): void {
    if (!this.handBone || !this.weaponMeshes) return; // rig not attached yet — re-applied from attachGltf
    const visual = this.desiredWeaponItem !== null ? weaponVisualForItem(this.desiredWeaponItem) : null;
    if (visual === this.currentWeaponVisual) return;
    if (this.currentWeaponVisual) this.handBone.remove(this.weaponMeshes[this.currentWeaponVisual]);
    if (visual) {
      const mesh = this.weaponMeshes[visual];
      mesh.scale.setScalar(this.invHandScale);
      mesh.position.set(
        WEAPON_HOLD_OFFSET.x * this.invHandScale,
        WEAPON_HOLD_OFFSET.y * this.invHandScale,
        WEAPON_HOLD_OFFSET.z * this.invHandScale,
      );
      mesh.rotation.set(WEAPON_HOLD_EULER.x, WEAPON_HOLD_EULER.y, WEAPON_HOLD_EULER.z);
      this.handBone.add(mesh);
    }
    this.currentWeaponVisual = visual;
  }

  /** Trigger the push-up emote (a single one-shot; returns to locomotion when it finishes). */
  triggerEmote(): void {
    this.controller.request('emote');
  }

  /** Trigger the hit-reaction flinch (a single one-shot; fired on a fresh player-damage signal). */
  triggerHit(): void {
    this.controller.request('hit');
  }

  /** Face the aim heading (radians) — the avatar's forward axis tracks `playerAim()` (V41). */
  faceAim(aimRadians: number): void {
    this.root.rotation.y = -aimRadians + RANGER_FORWARD_YAW_OFFSET;
  }

  /**
   * Advance the mixer + run the state machine for this frame. Locomotion stance comes from `loc`; the one-shot
   * flags come from the controller. A locomotion change crossfades; a one-shot snaps in (and restarts when
   * re-triggered). No-op before the GLB has attached (the root is still positioned/faced by BlockScene).
   */
  update(dtSeconds: number, loc: AvatarLocomotion): void {
    if (!this.mixer) return;
    this.mixer.update(Math.max(0, dtSeconds));
    const flags = this.controller.flags;
    const clip = selectClip({ ...loc, hitActive: flags.hitActive, emoteActive: flags.emoteActive });
    const isOneShot = clip === 'Hit_Reaction_1' || clip === 'push_up';
    const version = this.controller.version;
    const reTriggered = isOneShot && version !== this.lastOneShotVersion;
    this.lastOneShotVersion = version;
    if (clip !== this.currentClip) {
      this.playClip(clip, isOneShot ? ONE_SHOT_FADE : LOCOMOTION_FADE);
    } else if (reTriggered) {
      this.playClip(clip, ONE_SHOT_FADE); // re-fire the same one-shot from the top (e.g. a second hit)
    }
  }

  /** Stop the mixer + drop listeners. GPU resources are owned by the registry → freed on host dispose (V24). */
  dispose(): void {
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this.onActionFinished);
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    this.actions.clear();
    this.currentClip = null;
    this.loaded = false;
    // T141: drop weapon refs (the GPU resources are registry-owned → freed on host dispose, V24).
    this.handBone = null;
    this.weaponMeshes = null;
    this.currentWeaponVisual = null;
    this.offHandLightMesh = null;
  }

  /** Crossfade from the current action to `clip` (or restart it if re-firing the same one-shot). */
  private playClip(clip: RangerClip, fade: number): void {
    const next = this.actions.get(clip);
    if (!next) return;
    const prev = this.currentClip ? this.actions.get(this.currentClip) : undefined;
    next.reset();
    next.enabled = true;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.play();
    if (prev && prev !== next) next.crossFadeFrom(prev, fade, false);
    this.currentClip = clip;
  }

  /** A clamped action reached its end: clear the matching one-shot so the avatar returns to locomotion. */
  private readonly onActionFinished = (e: { action: AnimationAction }): void => {
    if (e.action === this.actions.get('Hit_Reaction_1')) this.controller.finish('hit');
    else if (e.action === this.actions.get('push_up')) this.controller.finish('emote');
    // 'Dead' finishing is a no-op — it stays clamped on the last frame (the held death pose).
  };
}

/**
 * Correct the Ranger GLB's broken PBR export so it is LIT BY THE SCENE instead of glowing flat ("statically
 * lit"). Meshy bakes the ALBEDO into the EMISSIVE channel at full strength (`emissiveFactor [1,1,1]` + the
 * albedo as `emissiveMap`) AND leaves metalness at the glTF default 1.0 — so the character renders full-bright,
 * self-illuminated, ignoring the sun/ambient/flashlight, and would read as a dark metal once the emissive is
 * removed. Fix at the ROOT (the asset's material setup is wrong for a lit scene, not a render hack): drop the
 * self-illumination so the baseColor `map` is the lit albedo, and make the clothed/skin body a DIELECTRIC.
 */
function normalizeRangerMaterial(m: MeshStandardMaterial): void {
  if (!m.isMeshStandardMaterial) return;
  m.emissive.setScalar(0); // no self-illumination — the directional/ambient/flashlight light it like everything else
  m.emissiveMap = null; // the baked albedo-as-emissive map (its texture is already tracked for disposal)
  m.emissiveIntensity = 1;
  m.metalness = 0; // a person is not metal — glTF left this at the default 1, which kills diffuse lighting
  m.needsUpdate = true;
}

/** Gather the standard texture-map slots a GLB MeshStandardMaterial may carry, for V24 disposal tracking. */
function collectTextures(m: MeshStandardMaterial, out: Set<Disposable>): void {
  const slots: (Texture | null | undefined)[] = [
    m.map,
    m.normalMap,
    m.roughnessMap,
    m.metalnessMap,
    m.emissiveMap,
    m.aoMap,
    m.alphaMap,
  ];
  for (const t of slots) if (t) out.add(t as unknown as Disposable);
}
