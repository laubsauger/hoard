// T60/T113/V29/V79 — the highlight's pure helpers: colour-coded by kind, pulsing between min/max, damped to a
// steady glow when reduce-flashes / reduce-motion is set, and the GENERIC nav-cell mesh resolution the
// silhouette-GLOW outline uses (no per-kind conditionals). GPU-free (no renderer).
import { describe, it, expect } from 'vitest';
import { AdditiveBlending, BackSide, Group, Mesh, Scene } from 'three';
import {
  resolveHighlightSettings,
  highlightColorFor,
  highlightPulseIntensity,
  collectInteractableMeshes,
  tagInteractable,
  HighlightView,
} from './highlightView';
import { ResourceRegistry } from '../engine';
import type { TargetKind, InteractionHighlightTarget } from '../../game/interaction';

const settings = resolveHighlightSettings('desktop-high');

describe('highlight appearance (T60/V29)', () => {
  it('maps a DISTINCT colour per interactable kind', () => {
    const kinds: TargetKind[] = ['door', 'container', 'corpse', 'window', 'structure'];
    const keys = kinds.map((k) => {
      const c = highlightColorFor(k, settings);
      return `${c.r},${c.g},${c.b}`;
    });
    expect(new Set(keys).size).toBe(kinds.length); // every kind a different colour
    for (const k of kinds) {
      const c = highlightColorFor(k, settings);
      for (const ch of [c.r, c.g, c.b]) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(1);
      }
    }
  });

  it('pulses between the configured min and max over time', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 4; t += 0.02) {
      const v = highlightPulseIntensity(t, settings, false);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(lo).toBeCloseTo(settings.pulseMin, 1);
    expect(hi).toBeCloseTo(settings.pulseMax, 1);
  });

  it('holds a steady glow (no pulse) when damped for reduce-flashes / reduce-motion', () => {
    const a = highlightPulseIntensity(0.1, settings, true);
    const b = highlightPulseIntensity(2.7, settings, true);
    expect(a).toBe(settings.reducedIntensity);
    expect(b).toBe(settings.reducedIntensity);
  });

  it('resolves a positive silhouette-glow outline width (T113/V79)', () => {
    expect(settings.outlineWidthMeters).toBeGreaterThan(0);
  });

  it('resolves a positive fresnel rim power so the glow is edge-weighted (T115/V81)', () => {
    expect(settings.rimFresnelPower).toBeGreaterThan(0);
  });
});

describe('silhouette-glow mesh resolution (T113/V79)', () => {
  /** Build a small scene: two meshes tagged at cell 5, one at cell 9, one untagged, plus a non-mesh group. */
  const root = new Group();
  const a = new Mesh();
  const b = new Mesh();
  const c = new Mesh();
  const untagged = new Mesh();
  const childGroup = new Group(); // a non-mesh node carrying a tag must NOT be collected
  tagInteractable(a, 5);
  tagInteractable(b, 5);
  tagInteractable(c, 9);
  tagInteractable(childGroup, 5);
  root.add(a, b, c, untagged, childGroup);

  it('collects exactly the MESHES tagged with the given nav cell (generic, no per-kind switch)', () => {
    const cell5 = collectInteractableMeshes(root, 5);
    expect(cell5).toHaveLength(2);
    expect(cell5).toContain(a);
    expect(cell5).toContain(b);
    expect(cell5).not.toContain(c); // different cell
    expect(cell5).not.toContain(untagged); // never tagged
    expect(cell5).not.toContain(childGroup as unknown as Mesh); // tagged but not a mesh
  });

  it('finds nested tagged meshes (traverses the whole subtree)', () => {
    const parent = new Group();
    const nested = new Mesh();
    tagInteractable(nested, 42);
    parent.add(nested);
    const outer = new Group();
    outer.add(parent);
    expect(collectInteractableMeshes(outer, 42)).toEqual([nested]);
  });

  it('returns NOTHING for an unmatched cell → the view falls back to the box (instanced corpse)', () => {
    expect(collectInteractableMeshes(root, 123)).toEqual([]);
  });
});

describe('HighlightView FRESNEL RIM-GLOW + always-on-top depth policy (T115/V81)', () => {
  /** The shared fresnel-rim material props the always-on-top edge glow depends on. */
  type RimMat = { depthTest: boolean; depthWrite: boolean; side: number; blending: number; toneMapped: boolean; colorNode: unknown };

  it('builds a FRESNEL RIM shell over a tagged mesh: FrontSide + additive + edge-weighted colorNode, depthTest OFF', () => {
    const registry = new ResourceRegistry();
    const view = new HighlightView(settings, registry);
    const scene = new Scene();
    const src = new Mesh(); // default BufferGeometry → the shell can clone it
    tagInteractable(src, 7);
    scene.add(src);
    view.attachTo(scene);

    const target: InteractionHighlightTarget = { kind: 'door', x: 0, y: 1, z: 0, sizeX: 1, sizeY: 2, sizeZ: 0.2, rotationY: 0, navCell: 7 };
    view.update(target, 0.016, false); // first highlight → shell built lazily + activated

    // the shell is parented to the SOURCE mesh (so it inherits the source world transform — a swinging door, etc.)
    const shells = src.children.filter((c) => (c as Mesh).isMesh) as Mesh[];
    expect(shells).toHaveLength(1);
    const m = shells[0]!.material as unknown as RimMat;
    expect(m.depthTest).toBe(true); // V97 — DEPTH-TESTED inverted-hull: closer bodies (zombies/player/frame) occlude the ring
    expect(m.depthWrite).toBe(false); // never writes depth over the scene
    expect(m.side).toBe(BackSide); // inverted-hull outline: the inflated BACK faces form the silhouette ring
    expect(m.blending).toBe(AdditiveBlending);
    expect(m.toneMapped).toBe(false);
    expect(m.colorNode).toBeTruthy(); // solid kind-colour × pulse (the inflated hull IS the edge — no fresnel face-fill)
    expect(shells[0]!.renderOrder).toBeGreaterThan(20); // composited last (above gameplay overlays)
    expect(shells[0]!.visible).toBe(true);

    view.update(null, 0.016, false); // nothing in reach → shell hidden, kept cached (no realloc)
    expect(shells[0]!.visible).toBe(false);
  });

  it('the box fallback reuses the SAME fresnel material (one factory, identical technique — no per-kind branch)', () => {
    const registry = new ResourceRegistry();
    const view = new HighlightView(settings, registry);
    const scene = new Scene();
    const src = new Mesh();
    tagInteractable(src, 7);
    scene.add(src);
    view.attachTo(scene); // also adds the box to the scene

    // resolve the SHARED material via a glow target (the shell uses it)…
    view.update({ kind: 'door', x: 0, y: 1, z: 0, sizeX: 1, sizeY: 2, sizeZ: 0.2, rotationY: 0, navCell: 7 }, 0.016, false);
    const shellMat = (src.children.find((c) => (c as Mesh).isMesh) as Mesh).material;

    // …then an untagged target (instanced corpse) → box fallback shown
    const corpse: InteractionHighlightTarget = { kind: 'corpse', x: 0, y: 0.2, z: 0, sizeX: 0.7, sizeY: 0.42, sizeZ: 0.7, rotationY: 0, navCell: 999 };
    view.update(corpse, 0.016, false);
    const box = scene.children.find((c) => (c as Mesh).isMesh && (c as Mesh).geometry?.type === 'BoxGeometry') as Mesh;
    expect(box).toBeDefined();
    expect(box.visible).toBe(true);
    expect(box.material).toBe(shellMat); // SAME instance → the box reads as the same fresnel glow
    const m = box.material as unknown as RimMat;
    expect(m.depthTest).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.side).toBe(BackSide);
    expect(m.colorNode).toBeTruthy();
  });
});
