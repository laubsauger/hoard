// T60 / V29 — ACTIVE-INTERACTABLE highlight (RENDER lane). A single glowing wireframe-box outline drawn on the
// NEAREST interactable in reach — the SAME target the "{key} to {action}" prompt + the interaction wheel act on
// — so the player sees WHICH object the prompt means (the door, the cupboard, a corpse, a window, the
// destructible wall). One at a time (the nearest target); hidden when nothing is in reach.
//
// COLOUR-CODED by kind (colours from rendering config). Gently PULSING, damped to a steady glow when the player
// has reduce-flashes / reduce-motion set (V29). V56 depth policy: depthTest ON so walls correctly OCCLUDE the
// outline (you never see the cupboard glow through a wall) + depthWrite OFF — NEVER depthTest:false. r184
// binding-safe (V33): ONE shared unit BoxGeometry + ONE MeshBasicMaterial, scaled/positioned per frame (no
// per-frame allocation, no instanceColor). All GPU resources tracked in the injected ResourceRegistry (V24).
//
// The runtime supplies the placed + sized target (world centre + axis-aligned bounds + kind) via
// `nearestInteractableHighlight()`; this view only POSITIONS/SCALES/colours the box (V1/V2 — never reads world
// state back). The pure colour + pulse helpers are GPU-free so they unit-test without a renderer.

import { BoxGeometry, Color, Mesh, MeshBasicMaterial, type Scene } from 'three';
import { resolve } from '../../config/spec';
import { renderingConfig } from '../../config/domains/rendering';
import type { QualityTier } from '../../config/types';
import type { ResourceRegistry } from '../engine/resources';
import type { InteractionHighlightTarget } from '../../game/interaction';
import type { TargetKind } from '../../game/interaction';

export interface RGB {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface HighlightSettings {
  readonly pulseHz: number;
  /** Trough/peak glow (opacity) of the pulse. */
  readonly pulseMin: number;
  readonly pulseMax: number;
  /** Steady glow held when reduce-flashes / reduce-motion damps the pulse (V29). */
  readonly reducedIntensity: number;
  /** Per-kind outline colours (linear RGB). */
  readonly colors: Readonly<Record<TargetKind, RGB>>;
}

export function resolveHighlightSettings(tier: QualityTier): HighlightSettings {
  return {
    pulseHz: resolve(renderingConfig.highlightPulseHz, tier),
    pulseMin: resolve(renderingConfig.highlightPulseMinIntensity, tier),
    pulseMax: resolve(renderingConfig.highlightPulseMaxIntensity, tier),
    reducedIntensity: resolve(renderingConfig.highlightReducedIntensity, tier),
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

/**
 * The thin GPU mirror: one wireframe box that snaps to the active target each frame. Pooled (ONE mesh reused),
 * tracked for disposal (V24). `update(null, ...)` hides it (nothing in reach).
 */
export class HighlightView {
  private readonly settings: HighlightSettings;
  private readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;
  private readonly color = new Color();
  private elapsed = 0;

  constructor(settings: HighlightSettings, registry: ResourceRegistry) {
    this.settings = settings;
    // ONE shared unit box; scaled to the target bounds each frame (no per-frame geometry alloc, V24).
    const geo = registry.track(new BoxGeometry(1, 1, 1), 'geometry', 'highlight.box.geo');
    // V56 depth policy: depthTest ON (walls occlude the glow), depthWrite OFF (transparent overlay). Wireframe
    // so it reads as an outline cage, not a solid block that hides the object it marks.
    this.material = registry.track(
      new MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, depthWrite: false, depthTest: true, opacity: 0 }),
      'material',
      'highlight.box.mat',
    );
    this.mesh = new Mesh(geo, this.material);
    this.mesh.renderOrder = 3; // after opaque structure + cutaway surfaces so the outline composites on top
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  /** Add the highlight mesh to the scene graph (call once at setup). */
  attachTo(scene: Scene): void {
    scene.add(this.mesh);
  }

  /**
   * Reflect the active target: position + scale the box to its bounds, colour it by kind, and pulse its glow.
   * `target === null` hides the box (nothing in reach). `damp` (reduce-flashes/motion) holds a steady glow.
   */
  update(target: InteractionHighlightTarget | null, dtSeconds: number, damp: boolean): void {
    if (!target) {
      this.mesh.visible = false;
      return;
    }
    this.elapsed += Math.max(0, dtSeconds);
    this.mesh.position.set(target.x, target.y, target.z);
    this.mesh.scale.set(target.sizeX, target.sizeY, target.sizeZ);
    const c = highlightColorFor(target.kind, this.settings);
    this.color.setRGB(c.r, c.g, c.b);
    this.material.color.copy(this.color);
    this.material.opacity = highlightPulseIntensity(this.elapsed, this.settings, damp);
    this.mesh.visible = true;
  }

  /** Detach from the scene graph (the injected registry owns disposal of the tracked geo/material, V24). */
  detach(): void {
    this.mesh.removeFromParent();
  }
}
