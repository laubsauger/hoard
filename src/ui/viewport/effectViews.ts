// Phase 3 (GameViewport decomposition): the render-lane EFFECT views + their shared surface projector.
// Pooled, capped, registry-tracked (V24), event-driven mirrors of the sim (V2): blood, gib, structure
// impact, weather, fire, the active-interactable highlight, and the lingering-corpse field.
//
// FRAGILE — preserve EXACTLY:
//   • The static-structure exclusion list. The blood/impact surface projector raycasts ONLY the static
//     structure. The list is assembled ONCE by EXCLUDING the dynamic objects: the crowd
//     (scene.crowd.mesh + children), the player avatar (the scene's only CapsuleGeometry → its whole
//     group), the gizmo overlay, and every gore/effect mesh by material-name prefix
//     (`blood.` / `gib.` / `impact.` / `combat.`).
//   • The CORPSE field is created + attached AFTER the structure list is built, so it is never treated
//     as a blood projection surface.
//   • bloodView.sim.setBodyAnchors (Bug A) reads the LIVE runtime binding via getRuntime() so a reload
//     re-targets automatically.

import { Mesh, type Material, type Object3D } from 'three';
import type { ResourceRegistry } from '../../render/engine';
import { BloodView, resolveBloodSettings } from '../../render/effects/bloodView';
import { RaycastSurfaceProjector } from '../../render/effects/surfaceProjector';
import { ImpactView, resolveImpactSettings } from '../../render/effects/impactView';
import { GibView, resolveGibSettings } from '../../render/effects/gibView';
import { WeatherView, resolveRainSettings } from '../../render/effects/weatherView';
import { FireView, resolveFireSettings } from '../../render/effects/fireView';
import { HighlightView, resolveHighlightSettings } from '../../render/effects/highlightView';
import { CorpseField, resolveCorpseFieldSettings } from '../../render/corpse';
import { weaponsConfig } from '../../config/domains/weapons';
import { resolveDomain } from '../../config/registry';
import type { QualityTier } from '../../config/types';
import type { BlockScene } from '../../render/scene';
import type { GameRuntime } from '../../game/runtime';
import type { EntityId } from '../../game/core/contracts';

/** The bundle of render-lane effect views, shared by the input handlers and the frame loop. */
export interface EffectViews {
  readonly bloodView: BloodView;
  readonly gibView: GibView;
  readonly impactView: ImpactView;
  readonly weatherView: WeatherView;
  readonly fireView: FireView;
  readonly highlightView: HighlightView;
  readonly corpseField: CorpseField;
  /** Read-only projector over the static structure (shared blood floor/wall + impact wall-finder). */
  readonly surfaceProjector: RaycastSurfaceProjector;
  /** Clean-miss tracer length = firearm range; stop < range ⇒ structure-impact branch (V57). */
  readonly firearmRangeMeters: number;
}

export interface CreateEffectViewsArgs {
  readonly tier: QualityTier;
  readonly registry: ResourceRegistry;
  readonly scene: BlockScene;
  /** The dev-tools gizmo overlay group — excluded from the structure raycast surface. */
  readonly gizmosGroup: Object3D;
  /** Live runtime accessor (reassigned on reload) — used by the blood body-anchor resolver (Bug A). */
  readonly getRuntime: () => GameRuntime;
}

export function createEffectViews(args: CreateEffectViewsArgs): EffectViews {
  const { tier, registry, scene, gizmosGroup, getRuntime } = args;

  // T75/T76 (V51/V52): pooled BLOOD (arcing droplets -> drying directional floor decals + bloody
  // footsteps) + GIB (flung faceted meat chunks) systems. Event-driven (V2), pooled + capped (V24),
  // r184 binding-safe (V33). They SUPERSEDE the basic combat-feedback blood spray (now retired there).
  // Resources are tracked in the host registry so host.dispose() frees them on unmount (V24).
  const bloodView = new BloodView(resolveBloodSettings(tier), registry);
  const gibView = new GibView(resolveGibSettings(tier), registry);
  // T80/T81 (V57): DISTINCT, clearly NON-RED structure-impact response — a spark burst + persistent
  // bullet-hole decal on a WALL hit, and dark wound marks on struck BODIES — so a wall hit / clean miss
  // never reads like "blood beyond range". Wired directly here (NOT via blockScene.fireFeedback) like
  // blood/gib; the ShotResult branch in onClick decides wall (spark+hole) vs body (wound). Pooled+capped,
  // tracked in the registry for disposal (V24).
  const impactView = new ImpactView(resolveImpactSettings(tier), registry);
  // Precipitation atmosphere (RENDER lane WeatherView): instanced rain streaks in a camera-following box,
  // ramped in/out per the active weather profile (gated off in clear). Reads the runtime's weather each
  // frame; the existing fog/grade (blockScene/lighting) is untouched. Resources tracked → freed on unmount.
  const weatherView = new WeatherView(resolveRainSettings(tier), registry);
  // FIRE visuals (RENDER lane FireView): additive billboard flame columns + a pooled flickering light set
  // + faint smoke at the cells the sim reports burning. Pure visual mirror (V2) — fed the drained
  // `fireIgnited` WorldEvents (mapped to world positions) + the runtime's live `isRouteBurning` truth each
  // frame; never touches the sim. Resources tracked → freed on unmount (V24).
  const fireView = new FireView(resolveFireSettings(tier), registry);
  // T60/V29: the ACTIVE-interactable highlight — one colour-coded glowing outline on the nearest
  // interactable in reach (the target the prompt + wheel act on). Tracked in the host registry → freed on
  // unmount (V24). Driven each frame off runtime.nearestInteractableHighlight() in the loop.
  const highlightView = new HighlightView(resolveHighlightSettings(tier), registry);
  bloodView.attachTo(scene.scene);
  gibView.attachTo(scene.scene);
  impactView.attachTo(scene.scene);
  weatherView.attachTo(scene.scene);
  fireView.attachTo(scene.scene);
  highlightView.attachTo(scene.scene);

  // T77/V54: give the pooled BLOOD system a render-side surface projector so landing droplets project
  // onto the REAL structure — interior floor slabs (which sit above the street, the indoors fix) at
  // their true height + walls behind a struck body for vertical splats. The projector raycasts ONLY the
  // static structure meshes: we assemble that list by EXCLUDING the dynamic objects — the crowd
  // (scene.crowd.mesh), the player avatar (the scene's only CapsuleGeometry → its whole group), the
  // gizmo overlay, and every gore/effect mesh (blood./gib./combat. material names). Structure never
  // moves, so the list is built once. Read-only (V2); raycasts are bounded by the sim (per hit, pooled).
  const structures: Object3D[] = [];
  {
    const sceneRoot = scene.scene;
    const exclude = new Set<Object3D>();
    scene.crowd.mesh.traverse((o) => exclude.add(o)); // crowd box + its limbed-figure children (T72) are dynamic, not blood surfaces
    gizmosGroup.traverse((o) => exclude.add(o));
    // T127: EXCLUDE the rigged player avatar by its stable `userData.isPlayerAvatar` tag (the old code keyed on
    // CapsuleGeometry, which the rigged mesh no longer has → it would be raycast as structure and blood/decals
    // would project onto the player). The avatar's SkinnedMesh swaps in ASYNC, AFTER this static list is built,
    // so it is excluded by absence too; the tag check is the robust signal (`hasPlayerAvatarAncestor` below also
    // skips any tagged descendant, so a synchronous build would still exclude the whole avatar subtree).
    sceneRoot.traverse((o) => {
      if (o.userData?.isPlayerAvatar) o.traverse((c) => exclude.add(c));
    });
    sceneRoot.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh || exclude.has(o) || hasPlayerAvatarAncestor(o)) return;
      const matName = (m.material as Material | undefined)?.name ?? '';
      if (matName.startsWith('blood.') || matName.startsWith('gib.') || matName.startsWith('impact.') || matName.startsWith('combat.')) return;
      structures.push(o);
    });
  }
  // One read-only surface projector over the static structures, shared by the blood floor/wall projector
  // (T77/V54) and the impact wall-finder (T80/V57). Structure never moves → built once (V2 read-only).
  const surfaceProjector = new RaycastSurfaceProjector(structures);
  bloodView.sim.setProjector(surfaceProjector);
  // Bug A activation: feed zombie body-gore the struck body's live transform each frame so blood rides the
  // body down to the corpse instead of hanging mid-air. `runtime` is reassigned on load — the arrow reads
  // the live binding, so a reload re-targets automatically. null ⇒ the body is gone → that gore fades.
  // V90: resolve the struck body's transform AND its current crowd REVEAL (0..1), so body-anchored gore fades
  // WITH a vision-culled/faded zombie instead of floating at full opacity. The reveal is a render value (per
  // crowd slot) looked up via the entity→slot map; a non-zombie / gone body resolves to 1 (a corpse fades by age).
  const bodyAnchorWithReveal = (entity: number) => {
    const rt = getRuntime();
    const a = rt.bodyAnchor(entity as unknown as EntityId);
    if (!a) return null;
    const slot = rt.slotOf(entity as unknown as EntityId);
    (a as { reveal?: number }).reveal = slot !== undefined ? scene.crowdRevealOf(slot) : 1;
    return a;
  };
  bloodView.sim.setBodyAnchors({ resolve: bodyAnchorWithReveal });
  // Same body-anchor (+ reveal) for dark WOUND marks (T81 surface-stick) so they ride the struck body + corpse, not float.
  impactView.setBodyAnchors({ resolve: bodyAnchorWithReveal });
  // Firearm range = the clean-miss tracer length. stopDistance < range ⇒ the shot stopped on structure
  // (a wall), not a clean miss to max range — that is the STRUCTURE-impact branch (V57). Range carries no
  // tier overrides, so resolving at the render tier matches the sim's authoritative value.
  const firearmRangeMeters = resolveDomain(weaponsConfig, tier).firearmRangeMeters;

  // T55/B9: pooled instanced CORPSE field — mirrors the runtime's lingering corpses (killed bodies do not
  // vanish). Attached AFTER the static-structure list is assembled so it is never treated as a blood
  // projection surface. Resources tracked in the host registry → freed on unmount (V24).
  const corpseField = new CorpseField(resolveCorpseFieldSettings(tier), registry);
  corpseField.attachTo(scene.scene);

  return { bloodView, gibView, impactView, weatherView, fireView, highlightView, corpseField, surfaceProjector, firearmRangeMeters };
}

/** True if `o` or any ancestor is the tagged player avatar (T127) — so its async-attached SkinnedMesh is never
 *  treated as a static blood/decal projection surface, regardless of when it joined the graph. */
function hasPlayerAvatarAncestor(o: Object3D): boolean {
  for (let n: Object3D | null = o; n; n = n.parent) {
    if (n.userData?.isPlayerAvatar) return true;
  }
  return false;
}
