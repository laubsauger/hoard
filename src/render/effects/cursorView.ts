// T136 — MOUSE CURSOR (render lane). A world-space ground reticle drawn at the pointer's ground intersection
// (the same y=0 plane the aim raycaster hits), so the isometric player sees EXACTLY where the mouse points —
// for aiming AND for picking WHICH interactable is selected when several are in reach (the runtime hover-pick).
// The reticle turns GREEN when an interactable is currently selected (the highlight is showing one) so the
// player gets "press to interact" feedback at the cursor, and stays neutral steel otherwise.
//
// Always-on-top (depthTest:false, additive, high renderOrder) like the interactable highlight — a cursor is a UI
// aid, never occluded. ONE ring geometry + ONE dot, two shared materials; positioned each frame, no per-frame
// allocation (V24). Every GPU resource is registry-tracked (V24); the group is detached on teardown.

import { AdditiveBlending, CircleGeometry, Color, Group, Mesh, RingGeometry, type Scene } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import type { ResourceRegistry } from '../engine/resources';

/** Just under the interactable highlight (20/21) so a highlighted object's rim still reads over the cursor,
 *  but above gameplay overlays (blood/fire/weather ≤5). */
const CURSOR_RENDER_ORDER = 19;
/** Reticle lift off the ground so it composites over the floor without z-fighting (it is depthTest:false anyway). */
const CURSOR_GROUND_LIFT = 0.05;
/** Neutral pointer colour (pale steel) — additive, so it reads as a soft glow on the dark night ground. */
const CURSOR_NEUTRAL = new Color(0.55, 0.62, 0.72);
/** Armed colour (green) — shown when an interactable is selected under the cursor (press to interact). */
const CURSOR_ARMED = new Color(0.25, 0.95, 0.5);

export class CursorView {
  private readonly group = new Group();
  private readonly ringMat: MeshBasicNodeMaterial;
  private readonly dotMat: MeshBasicNodeMaterial;
  private root: Scene | null = null;

  constructor(registry: ResourceRegistry) {
    const mk = (label: string): MeshBasicNodeMaterial =>
      registry.track(
        new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: AdditiveBlending, toneMapped: false }),
        'material',
        label,
      );
    this.ringMat = mk('cursor.ring.mat');
    this.dotMat = mk('cursor.dot.mat');
    this.ringMat.color.copy(CURSOR_NEUTRAL);
    this.dotMat.color.copy(CURSOR_NEUTRAL);

    const ringGeo = registry.track(new RingGeometry(0.26, 0.4, 36), 'geometry', 'cursor.ring.geo');
    const dotGeo = registry.track(new CircleGeometry(0.05, 16), 'geometry', 'cursor.dot.geo');
    const ring = new Mesh(ringGeo, this.ringMat);
    const dot = new Mesh(dotGeo, this.dotMat);
    // Lie flat on the ground (the geometries are authored in the XY plane → rotate onto XZ).
    ring.rotation.x = -Math.PI / 2;
    dot.rotation.x = -Math.PI / 2;
    ring.renderOrder = CURSOR_RENDER_ORDER;
    dot.renderOrder = CURSOR_RENDER_ORDER;
    this.group.add(ring, dot);
    this.group.frustumCulled = false;
    this.group.visible = false;
  }

  /** Add the reticle group to the scene (call once at setup). */
  attachTo(scene: Scene): void {
    this.root = scene;
    scene.add(this.group);
  }

  /**
   * Place the reticle at the pointer's ground point each frame; `point === null` hides it (pointer off the
   * ground plane). `armed` (an interactable is currently selected) flips the colour to green so the cursor
   * reads as "ready to interact" right where the mouse is. Allocation-free (V24).
   */
  update(point: { readonly x: number; readonly z: number } | null, armed: boolean): void {
    if (!point) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.group.position.set(point.x, CURSOR_GROUND_LIFT, point.z);
    const c = armed ? CURSOR_ARMED : CURSOR_NEUTRAL;
    this.ringMat.color.copy(c);
    this.dotMat.color.copy(c);
  }

  /** Detach the reticle group (GPU resources are disposed via the registry, V24). */
  dispose(): void {
    this.root?.remove(this.group);
    this.root = null;
  }
}
