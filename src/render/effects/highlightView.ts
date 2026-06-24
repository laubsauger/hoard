// T60 / T113 / V29 / V79 — ACTIVE-INTERACTABLE highlight (RENDER lane). An L4D-style silhouette GLOW outline
// drawn on the NEAREST interactable in reach — the SAME target the "{key} to {action}" prompt + the interaction
// wheel act on — so the player sees WHICH object the prompt means (the door, the cupboard, a window, the
// destructible wall, a corpse). One at a time (the nearest target); hidden when nothing is in reach.
//
// The glow HUGS THE REAL MESH SILHOUETTE, not a box (T113/V79). Technique: a FRESNEL RIM-GLOW (V81 — replaces the
// old inverted-hull BackSide shell, which only read as a rim under `depthTest:true` because the real mesh's front
// faces occluded the inner shell; with the always-on-top `depthTest:false` ask it rendered the WHOLE back shell
// → an additive FULL-FACE FILL blob, not an outline). For each render mesh of the active interactable we add a
// child Mesh that REUSES the source geometry + a SHARED FrontSide node material whose `colorNode` is EDGE-WEIGHTED
// by a fresnel term — `pow(1 - |dot(normalWorld, viewDir)|, power)` — so it is BRIGHT only where the surface
// normal is grazing (the silhouette edge) and dark facing the camera. Edge-only BY CONSTRUCTION, so it stays a
// thin OUTLINE even with depth off. A tiny `positionNode` inflate (`positionLocal + normalLocal*width`) lifts the
// rim a smidge proud of the surface. This app renders directly via `renderer.render()` with NO RenderPipeline
// post-pass wired in, so a selective edge-detect OUTLINE post-pass is impractical here without restructuring the
// whole render path — the fresnel rim is the generic, mesh-shaped approach the existing pipeline supports. It is
// GENERIC: meshes are resolved by nav cell from a `userData` tag the builders set (no per-kind conditionals).
// INSTANCED corpses/zombies carry no taggable single mesh, so for those the view falls back to a BOX — which uses
// the SAME fresnel material (one factory, no per-kind material branching) so the fallback reads identically.
//
// COLOUR-CODED by kind (colours from rendering config). Gently PULSING, damped to a steady glow when the player
// has reduce-flashes / reduce-motion set (V29). DEPTH policy (V81 — a DELIBERATE exception to V56 for THIS aid):
// the highlight is ALWAYS-ON-TOP — `depthTest:false` + `depthWrite:false`, composited LAST via a high renderOrder
// — so the rim of the active interactable is reliably visible (e.g. a CLOSED door's outline is no longer hidden
// by its own frame, a window's rim no longer swallowed by the surrounding wall). Safe because the fresnel keeps
// it an EDGE (no full-face fill) and it NEVER depth-writes, so it can't corrupt the depth buffer for anything
// else: it is a deliberate gameplay-readability cue on the single nearest target, the ONE sanctioned
// `depthTest:false` overlay, so the V56 "never depthTest:false" rule (which keeps blood/fire/etc. from drawing
// over the world) is intentionally overridden here. r184 binding-safe (V33): ONE shared box geometry + ONE shared
// fresnel rim material (the box reuses it too); shell meshes are built LAZILY per nav cell and CACHED (no
// per-frame allocation), reusing the source geometry. All GPU resources this view owns are tracked in the
// injected ResourceRegistry (V24); the cloned shell meshes reference builder-owned geometry (never disposed here)
// and are detached on teardown.
//
// The runtime supplies the placed + sized target (world centre + axis-aligned bounds + kind + nav cell) via
// `nearestInteractableHighlight()`; this view only resolves/positions/colours the glow (V1/V2 — never reads
// world state back). The pure colour + pulse + mesh-resolution helpers are GPU-free so they unit-test headless.

import { AdditiveBlending, BackSide, BoxGeometry, Color, Mesh, type Object3D, type Scene } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { normalLocal, positionLocal, uniform } from 'three/tsl';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import type { InteractionHighlightTarget } from '../../game/interaction';
import type { TargetKind } from '../../game/interaction';

// ALWAYS-ON-TOP compositing (V81): the highlight is `depthTest:false`, so among the transparent draws its
// render ORDER decides what it sits over. These sit ABOVE every gameplay overlay (blood/fire/weather ≤5) so the
// active-interactable rim composites last, yet below the DEV debug gizmos (~997) which must stay readable on top.
const HIGHLIGHT_BOX_RENDER_ORDER = 20;
const HIGHLIGHT_SHELL_RENDER_ORDER = 21;

export interface RGB {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface HighlightSettings {
  readonly pulseHz: number;
  /** Trough/peak glow (intensity) of the pulse. */
  readonly pulseMin: number;
  readonly pulseMax: number;
  /** Steady glow held when reduce-flashes / reduce-motion damps the pulse (V29). */
  readonly reducedIntensity: number;
  /** Fresnel rim-glow inflation width (m) — how far the rim shell sits proud of the source surface along the mesh
   *  normals around the active interactable (T113/T115/V79/V81). A smidge, so the rim reads without ballooning. */
  readonly outlineWidthMeters: number;
  /** Fresnel exponent — higher = a tighter EDGE-only outline (the rim brightness is `pow(1-|n·v|, power)`). */
  readonly rimFresnelPower: number;
  /** Per-kind outline colours (linear RGB). */
  readonly colors: Readonly<Record<TargetKind, RGB>>;
}

export function resolveHighlightSettings(tier: QualityTier): HighlightSettings {
  return {
    pulseHz: resolve(renderingConfig.highlightPulseHz, tier),
    pulseMin: resolve(renderingConfig.highlightPulseMinIntensity, tier),
    pulseMax: resolve(renderingConfig.highlightPulseMaxIntensity, tier),
    reducedIntensity: resolve(renderingConfig.highlightReducedIntensity, tier),
    outlineWidthMeters: resolve(renderingConfig.highlightOutlineWidthMeters, tier),
    rimFresnelPower: resolve(renderingConfig.highlightRimFresnelPower, tier),
    colors: {
      door: {
        r: resolve(renderingConfig.highlightDoorColorR, tier),
        g: resolve(renderingConfig.highlightDoorColorG, tier),
        b: resolve(renderingConfig.highlightDoorColorB, tier),
      },
      container: {
        r: resolve(renderingConfig.highlightContainerColorR, tier),
        g: resolve(renderingConfig.highlightContainerColorG, tier),
        b: resolve(renderingConfig.highlightContainerColorB, tier),
      },
      corpse: {
        r: resolve(renderingConfig.highlightCorpseColorR, tier),
        g: resolve(renderingConfig.highlightCorpseColorG, tier),
        b: resolve(renderingConfig.highlightCorpseColorB, tier),
      },
      window: {
        r: resolve(renderingConfig.highlightWindowColorR, tier),
        g: resolve(renderingConfig.highlightWindowColorG, tier),
        b: resolve(renderingConfig.highlightWindowColorB, tier),
      },
      structure: {
        r: resolve(renderingConfig.highlightStructureColorR, tier),
        g: resolve(renderingConfig.highlightStructureColorG, tier),
        b: resolve(renderingConfig.highlightStructureColorB, tier),
      },
    },
  };
}

/** The outline colour for a target kind (pure — the colour-coding the highlight reads). */
export function highlightColorFor(kind: TargetKind, settings: HighlightSettings): RGB {
  return settings.colors[kind];
}

/**
 * The highlight glow intensity (0..1) at `elapsedSeconds`. Damped to a steady `reducedIntensity` when the
 * player has reduce-flashes / reduce-motion enabled (V29 — no pulsing); otherwise a smooth sine pulse between
 * `pulseMin` and `pulseMax`. Pure — unit-tested without a renderer.
 */
export function highlightPulseIntensity(elapsedSeconds: number, settings: HighlightSettings, damp: boolean): number {
  if (damp) return settings.reducedIntensity;
  const phase = 0.5 * (1 + Math.sin(2 * Math.PI * settings.pulseHz * elapsedSeconds));
  return settings.pulseMin + (settings.pulseMax - settings.pulseMin) * phase;
}

/** `userData` key tagging a render mesh with the nav cell of the interactable it belongs to — the GENERIC,
 *  data-driven link the silhouette outline resolves by (set by the scene builders; no per-kind conditionals). */
export const INTERACTABLE_NAVCELL = 'interactableNavCell';

/** Tag a built render mesh with the nav cell of the interactable it represents so the silhouette-glow outline
 *  can resolve it generically by cell (T113/V79). Called by the scene builders (doors/windows/cupboard/wall). */
export function tagInteractable(object: Object3D, navCell: number): void {
  object.userData[INTERACTABLE_NAVCELL] = navCell;
}

/**
 * Collect every render mesh under `root` tagged (V79) with `navCell` — the GENERIC silhouette-outline source set
 * for the active interactable, with NO per-kind switch. Pure plain-Object3D traversal (GPU-free) so it
 * unit-tests headless. Returns an empty array when nothing is tagged for the cell (e.g. an instanced corpse) —
 * the view then falls back to the box.
 */
export function collectInteractableMeshes(root: Object3D, navCell: number): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh && (o.userData as Record<string, unknown>)[INTERACTABLE_NAVCELL] === navCell) {
      out.push(o as Mesh);
    }
  });
  return out;
}

/**
 * The GPU mirror of the active highlight: a FRESNEL RIM-GLOW that hugs the real interactable mesh(es)' silhouette
 * edge, with a BOX fallback (using the SAME fresnel material) for targets whose mesh can't be resolved (instanced
 * corpses). Shell meshes are pooled per nav cell (V24/V33). `update(null, ...)` hides everything (nothing in reach).
 */
export class HighlightView {
  private readonly settings: HighlightSettings;
  // Box fallback (corpse / untagged target): a unit cube using the SHARED fresnel material, sized to the bounds.
  private readonly box: Mesh;
  // ONE shared FRESNEL RIM material (V33/V81) for BOTH the per-mesh shells AND the box — FrontSide, additive,
  // edge-weighted by fresnel, lifted along normals by `uWidth`; glow brightness driven by `uIntensity`, colour by
  // `uColor`. Only ONE target is active at a time, so all active meshes share these uniforms safely.
  private readonly shellMaterial: MeshBasicNodeMaterial;
  private readonly uColor = uniform(new Color(1, 1, 1));
  private readonly uIntensity = uniform(0);
  private readonly uWidth = uniform(0);
  private readonly color = new Color();
  private root: Object3D | null = null;
  // Lazily-built shell meshes per nav cell — children of the source meshes so they inherit the full world
  // transform (a swinging door leaf, etc.); cached so a re-highlight just toggles visibility (no per-frame alloc).
  private readonly shellsByNav = new Map<number, Mesh[]>();
  private activeNav: number | null = null;
  private elapsed = 0;

  constructor(settings: HighlightSettings, registry: ResourceRegistry) {
    this.settings = settings;
    this.uWidth.value = settings.outlineWidthMeters;

    // The shared INVERTED-HULL OUTLINE material (V97 — replaces the V81 fresnel rim, which face-FILLED on the
    // BOXY interactables: a fresnel `1-|n·v|` lights every side face of a hard-edged box, not a thin edge). This is
    // the classic toon/selection outline: render the geometry inflated along its normals (`positionNode`) on the
    // BACK faces (`side:BackSide`) in a SOLID kind-colour, with DEPTH-TEST ON. The real interactable mesh (drawn
    // normally, writes depth) then occludes the hull's interior — only the rim that pokes BEYOND the silhouette
    // survives the depth test → a true OUTLINE ring, never a filled blob regardless of mesh shape. depthTest ON
    // also makes anything CLOSER (a zombie, the player, the door's own frame) correctly OCCLUDE the outline, so it
    // no longer draws over dynamic bodies (the "always-on-top looked weird" report). depthWrite OFF so it never
    // corrupts the depth buffer (V56-safe). AdditiveBlending + toneMapped:false → the ring glows.
    this.shellMaterial = registry.track(
      new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, side: BackSide, blending: AdditiveBlending, toneMapped: false }),
      'material',
      'highlight.outline.shell.mat',
    );
    // Inflate every vertex OUT along its normal by uWidth → the hull sticks `uWidth` past the real silhouette; the
    // visible BackSide rim is exactly that band (the interior is depth-occluded by the real front faces).
    this.shellMaterial.positionNode = positionLocal.add(normalLocal.mul(this.uWidth));
    // SOLID kind-colour × pulse — NO fresnel (that was the box face-fill). The inflated-hull geometry IS the edge.
    this.shellMaterial.colorNode = this.uColor.mul(this.uIntensity);

    // ONE shared unit box reusing the SAME fresnel material (so the corpse/untagged fallback looks like the same
    // glow technique — no per-kind material branching); scaled to the target bounds in update (no alloc, V24).
    const geo = registry.track(new BoxGeometry(1, 1, 1), 'geometry', 'highlight.box.geo');
    this.box = new Mesh(geo, this.shellMaterial);
    this.box.renderOrder = HIGHLIGHT_BOX_RENDER_ORDER; // composited last (always-on-top, V81)
    this.box.visible = false;
    this.box.frustumCulled = false;
  }

  /** Add the box fallback to the scene + remember the root the shells resolve their meshes from (call once at
   *  setup). Shells are added later as children of the resolved source meshes, so they are NOT in any list a
   *  surface raycaster / cutaway built at setup time enumerates. */
  attachTo(scene: Scene): void {
    this.root = scene;
    scene.add(this.box);
  }

  /**
   * Reflect the active target: glow its real mesh silhouette (fresnel rim shells), colour by kind, pulse the
   * glow. `target === null` hides everything (nothing in reach). `damp` (reduce-flashes/motion) holds a steady
   * glow. When the target's mesh can't be resolved (an instanced corpse), fall back to the box at its bounds —
   * the box uses the SAME fresnel material, so it reads as the identical glow technique.
   */
  update(target: InteractionHighlightTarget | null, dtSeconds: number, damp: boolean): void {
    if (!target) {
      this.box.visible = false;
      this.activate(null);
      return;
    }
    this.elapsed += Math.max(0, dtSeconds);
    const intensity = highlightPulseIntensity(this.elapsed, this.settings, damp);
    const c = highlightColorFor(target.kind, this.settings);
    this.color.setRGB(c.r, c.g, c.b);

    // Drive the SHARED fresnel uniforms (one active target → one colour/intensity) — used by both the shells AND
    // the box, so the colour/pulse is set once regardless of which path renders.
    this.uColor.value.copy(this.color);
    this.uIntensity.value = intensity;

    const shells = this.shellsFor(target.navCell);
    if (shells.length > 0) {
      // Silhouette GLOW: the per-mesh fresnel rim shells hug the real interactable.
      this.activate(target.navCell);
      this.box.visible = false;
    } else {
      // No resolvable mesh (instanced corpse / untagged) → the fresnel-rim box fallback hugs the target bounds.
      this.activate(null);
      this.box.position.set(target.x, target.y, target.z);
      this.box.rotation.y = target.rotationY;
      this.box.scale.set(target.sizeX, target.sizeY, target.sizeZ);
      this.box.visible = true;
    }
  }

  /** Resolve (and lazily build + cache) the fresnel rim shell meshes for a nav cell. Each shell reuses the
   *  source geometry and the shared fresnel material, parented to the source mesh so it follows its transform. */
  private shellsFor(navCell: number): Mesh[] {
    const cached = this.shellsByNav.get(navCell);
    if (cached) return cached;
    const shells: Mesh[] = [];
    if (this.root) {
      for (const src of collectInteractableMeshes(this.root, navCell)) {
        if (!src.geometry) continue;
        const shell = new Mesh(src.geometry, this.shellMaterial);
        shell.renderOrder = HIGHLIGHT_SHELL_RENDER_ORDER; // after the box; always-on-top glow composited last (V81)
        shell.frustumCulled = false;
        shell.castShadow = false;
        shell.receiveShadow = false;
        shell.visible = false; // shown by activate(); a hidden source (e.g. a removed board) hides its child shell
        src.add(shell); // child → inherits the source world transform (a swinging door leaf included)
        shells.push(shell);
      }
    }
    this.shellsByNav.set(navCell, shells);
    return shells;
  }

  /** Show only the shells of `nav` (hiding the previously-active set). Shells follow their parents, so a shell of
   *  a currently-hidden source mesh stays unrendered even when set visible. */
  private activate(nav: number | null): void {
    if (this.activeNav === nav) return;
    if (this.activeNav !== null) {
      const prev = this.shellsByNav.get(this.activeNav);
      if (prev) for (const s of prev) s.visible = false;
    }
    if (nav !== null) {
      const cur = this.shellsByNav.get(nav);
      if (cur) for (const s of cur) s.visible = true;
    }
    this.activeNav = nav;
  }

  /** Detach from the scene graph (the injected registry owns disposal of the tracked geo/materials, V24; the
   *  cloned shell meshes reference builder-owned geometry, so they are only detached, never disposed here). */
  detach(): void {
    this.box.removeFromParent();
    for (const shells of this.shellsByNav.values()) for (const s of shells) s.removeFromParent();
    this.shellsByNav.clear();
    this.activeNav = null;
    this.root = null;
  }
}
