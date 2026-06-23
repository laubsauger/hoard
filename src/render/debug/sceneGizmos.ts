// Dev-tools scene gizmos — perception cones, attack radii, FSM-state markers, heard-sound field, and the
// player vision cone. Driven from the viewport; reads live runtime state + the debug-flag store. Built the
// SAME way the crowd is — InstancedMesh + MeshBasicNodeMaterial — which is the only primitive confirmed to
// render under three's WebGPURenderer (core Line/Points materials do not). Self-hides when no flag is set.
//
// Sight is a heading-oriented CONE (matches the zombie FOV in perception, V14) — NOT a 360° ring. Rings use
// a FIXED world-space thickness (geometry built at the true radius) so a big range never produces a fat band.

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  RingGeometry,
  Vector3,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { ZombieState, type SimulationZombies } from '@/game/simulation';
import { resolveDomain } from '@/config/registry';
import { perceptionConfig } from '@/config/domains/perception';
import type { QualityTier } from '@/config/types';
import type { DebugFlags } from '@/diagnostics/flags';

const MAX_GIZMOS = 600;
const MAX_SOUND = 64;
const GIZMO_Y = 0.25;
const RING_THICKNESS = 0.18; // constant world-space ring thickness (T58 feedback: no radius-scaled fat bands)
const SIGHT_CONE_WORLD_STROKE = 0.05; // sight-cone outline stroke in WORLD meters — thin line, bounded so a
// big sight range never fattens it (the relative width is derived = stroke / sightRange in the constructor).
const Y_AXIS = new Vector3(0, 1, 0);

// One solid colour per FSM state. Markers are bucketed into per-state InstancedMeshes (NOT per-instance
// instanceColor — which does not render reliably on the WebGPU node material, the "always grey" bug).
const STATE_HEX: readonly number[] = [
  0x3b82f6, // Idle   — blue
  0x22d3ee, // Wander — cyan (searching)
  0xf59e0b, // Pursue — amber (charging)
  0xef4444, // Attack — red
  0xeab308, // Stagger — yellow
  0x6b7280, // Down   — grey
];

function gizmoMaterial(color: number, opacity = 0.5): MeshBasicNodeMaterial {
  return new MeshBasicNodeMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: DoubleSide });
}

/** Flat annulus in the XZ plane at a fixed radius + constant thickness. */
function makeRing(radius: number, thickness: number, segs = 48): BufferGeometry {
  const g = new RingGeometry(Math.max(0.01, radius - thickness), radius, segs);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Unit vision-cone OUTLINE (arc rim + two apex→rim edges) in the XZ plane — thin, no fill, so overlapping
 *  cones never opaque the scene. `w` is the relative stroke width; scaled per instance by the cone radius. */
function makeConeOutline(halfAngle: number, segs = 24, w = 0.02): BufferGeometry {
  const p: number[] = [];
  const ri = 1 - w;
  const arc = (a: number, r: number): [number, number] => [Math.cos(a) * r, Math.sin(a) * r];
  for (let i = 0; i < segs; i++) {
    const a0 = -halfAngle + (2 * halfAngle * i) / segs;
    const a1 = -halfAngle + (2 * halfAngle * (i + 1)) / segs;
    const [ix0, iz0] = arc(a0, ri); const [ox0, oz0] = arc(a0, 1);
    const [ix1, iz1] = arc(a1, ri); const [ox1, oz1] = arc(a1, 1);
    p.push(ix0, 0, iz0, ox0, 0, oz0, ox1, 0, oz1, ix0, 0, iz0, ox1, 0, oz1, ix1, 0, iz1);
  }
  for (const a of [-halfAngle, halfAngle]) {
    const dx = Math.cos(a); const dz = Math.sin(a);
    const px = -dz * w * 0.5; const pz = dx * w * 0.5; // perpendicular half-width
    p.push(px, 0, pz, dx + px, 0, dz + pz, dx - px, 0, dz - pz, px, 0, pz, dx - px, 0, dz - pz, -px, 0, -pz);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  return g;
}

/** Nav-grid info the world overlays (spatial grid + structural cells) are built from. */
export interface WorldGridInfo {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  /** True when the cell is impassable (wall / structure) — drawn as a filled quad for the structural overlay. */
  blocked(cx: number, cy: number): boolean;
}

/** Merged thin-quad mesh of every nav-cell boundary line (lines don't render under WebGPU — use quads). */
function makeGridLines(w: WorldGridInfo, halfW = 0.04): BufferGeometry {
  const p: number[] = [];
  const cs = w.cellSize;
  const W = w.width * cs;
  const H = w.height * cs;
  const quad = (x0: number, z0: number, x1: number, z1: number): void => {
    p.push(x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z0, x1, 0, z1, x0, 0, z1);
  };
  for (let i = 0; i <= w.width; i++) quad(i * cs - halfW, 0, i * cs + halfW, H);
  for (let j = 0; j <= w.height; j++) quad(0, j * cs - halfW, W, j * cs + halfW);
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  return g;
}

/** Merged flat-quad mesh covering every blocked (structural) cell. */
function makeBlockedQuads(w: WorldGridInfo): BufferGeometry {
  const p: number[] = [];
  const cs = w.cellSize;
  const m = cs * 0.46;
  for (let cy = 0; cy < w.height; cy++) {
    for (let cx = 0; cx < w.width; cx++) {
      if (!w.blocked(cx, cy)) continue;
      const x = (cx + 0.5) * cs;
      const z = (cy + 0.5) * cs;
      p.push(x - m, 0, z - m, x + m, 0, z - m, x + m, 0, z + m, x - m, 0, z - m, x + m, 0, z + m, x - m, 0, z + m);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  return g;
}

/** One instanced layer: compose a transform per instance (position + Y-rotation + non-uniform scale). */
class InstancedLayer {
  readonly mesh: InstancedMesh;
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly s = new Vector3();
  private readonly m = new Matrix4();

  constructor(geo: BufferGeometry, color: number, max: number, order: number, opacity = 0.5) {
    this.mesh = new InstancedMesh(geo, gizmoMaterial(color, opacity), max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.count = 0;
  }

  set(i: number, x: number, z: number, rotY: number, sx: number, sz: number): void {
    this.q.setFromAxisAngle(Y_AXIS, rotY);
    this.v.set(x, GIZMO_Y, z);
    this.s.set(sx, 1, sz);
    this.m.compose(this.v, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
  }

  setColor(i: number, c: Color): void {
    this.mesh.setColorAt(i, c);
  }

  finalize(count: number): void {
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
}

export class SceneGizmos {
  readonly group = new Group();
  private readonly sight: InstancedLayer; // heading-oriented cone (unit radius, scaled per agent)
  private readonly attack: InstancedLayer; // thin ring baked at attackRange (translate only)
  private readonly sound: InstancedLayer; // unit ring scaled per own radius
  private readonly stateMarkers: InstancedLayer[]; // one InstancedMesh per FSM state (solid colour each)
  private readonly stateCounts: number[] = [];
  private readonly playerCone: Mesh;
  private readonly markerColor = new Color();
  private readonly sightRange: number;
  private readonly playerFovHalf: number;
  /** World overlays (spatial grid lines + filled structural cells) — static, built once from the nav grid. */
  private gridLines: Mesh | null = null;
  private structuralQuads: Mesh | null = null;

  constructor(tier: QualityTier, world?: WorldGridInfo) {
    const p = resolveDomain(perceptionConfig, tier);
    this.sightRange = p.sightRange;
    const fovHalf = (p.fieldOfViewDegrees * Math.PI) / 360;

    // Derive the cone-outline stroke so it reads as a THIN fixed world-space line regardless of sight range
    // (geometry is unit-radius scaled per instance by the range, so relative width = worldStroke / range).
    const sightStroke = SIGHT_CONE_WORLD_STROKE / Math.max(0.01, this.sightRange);
    this.sight = new InstancedLayer(makeConeOutline(fovHalf, 24, sightStroke), 0x38bdf8, MAX_GIZMOS, 998, 0.85);
    this.attack = new InstancedLayer(makeRing(p.attackRangeMeters, RING_THICKNESS), 0xef4444, MAX_GIZMOS, 999, 0.7);
    this.sound = new InstancedLayer(makeRing(1, RING_THICKNESS), 0xfacc15, MAX_SOUND, 999, 0.6);
    this.stateMarkers = STATE_HEX.map(
      (hex) => new InstancedLayer(new BoxGeometry(0.6, 0.6, 0.6), hex, MAX_GIZMOS, 1000, 0.95),
    );

    this.playerFovHalf = (p.playerFieldOfViewDegrees * Math.PI) / 360;
    // Player vision = OUTLINED cone (analogous to the zombie sight cones, not a solid fill), violet so it's
    // clearly distinct from the cyan ZOMBIE sight (0x38bdf8). Unit-radius outline scaled by the vision range,
    // with the same thin fixed world-space stroke.
    const playerStroke = SIGHT_CONE_WORLD_STROKE / Math.max(0.01, p.playerVisionRange);
    this.playerCone = new Mesh(makeConeOutline(this.playerFovHalf, 24, playerStroke), gizmoMaterial(0xc084fc, 0.85));
    this.playerCone.frustumCulled = false;
    this.playerCone.renderOrder = 998;
    this.playerCone.position.y = GIZMO_Y;
    this.playerCone.scale.set(p.playerVisionRange, 1, p.playerVisionRange);
    this.playerCone.visible = false;

    this.group.add(this.sight.mesh, this.attack.mesh, this.sound.mesh, this.playerCone);
    for (const m of this.stateMarkers) this.group.add(m.mesh);

    if (world) {
      this.gridLines = new Mesh(makeGridLines(world), gizmoMaterial(0x5b7aa8, 0.4));
      this.gridLines.position.y = GIZMO_Y - 0.1;
      this.gridLines.frustumCulled = false;
      this.gridLines.renderOrder = 997;
      this.gridLines.visible = false;
      this.structuralQuads = new Mesh(makeBlockedQuads(world), gizmoMaterial(0xf97316, 0.28));
      this.structuralQuads.position.y = GIZMO_Y - 0.05;
      this.structuralQuads.frustumCulled = false;
      this.structuralQuads.renderOrder = 997;
      this.structuralQuads.visible = false;
      this.group.add(this.gridLines, this.structuralQuads);
    }
  }

  update(
    zombies: SimulationZombies,
    flags: DebugFlags,
    player: { x: number; z: number; heading: number },
    queryStimuli: (x: number, z: number) => readonly { x: number; z: number; intensity: number; radius: number }[],
    wallDistance?: (x: number, z: number, heading: number, maxR: number) => number,
  ): void {
    const showPlayer = flags.showPlayerVision;
    // World overlays are static meshes — just toggle their visibility (no per-frame rebuild needed).
    if (this.gridLines) this.gridLines.visible = flags.showSpatialGrids;
    if (this.structuralQuads) this.structuralQuads.visible = flags.showStructuralCells;
    const any =
      flags.showSightRadius ||
      flags.showAttackRadius ||
      flags.showZombieState ||
      flags.showSoundField ||
      showPlayer ||
      flags.showSpatialGrids ||
      flags.showStructuralCells;
    this.group.visible = any;
    if (!any) return;

    // Player vision cone (single mesh) — orient to the aim heading. Nose is +x, so rotateY(-heading).
    this.playerCone.visible = showPlayer;
    if (showPlayer) {
      this.playerCone.position.set(player.x, GIZMO_Y, player.z);
      this.playerCone.rotation.y = -player.heading;
    }

    for (let s = 0; s < STATE_HEX.length; s++) this.stateCounts[s] = 0;
    let n = 0;
    const pos: [number, number, number] = [0, 0, 0];
    zombies.forEachAlive((slot) => {
      if (n >= MAX_GIZMOS) return;
      zombies.getPosition(slot, pos);
      const heading = zombies.getHeading(slot);
      if (flags.showSightRadius) {
        // V47: crop the cone at the first wall along the heading so the overlay shows the OCCLUDED sight.
        const r = wallDistance ? wallDistance(pos[0], pos[2], heading, this.sightRange) : this.sightRange;
        this.sight.set(n, pos[0], pos[2], -heading, r, r);
      }
      if (flags.showAttackRadius) this.attack.set(n, pos[0], pos[2], 0, 1, 1);
      if (flags.showZombieState) {
        // Bucket into the per-state mesh (its own count) so each marker draws its state's solid colour.
        const st = zombies.getState(slot);
        const layer = this.stateMarkers[st < STATE_HEX.length ? st : ZombieState.Idle]!;
        const c = this.stateCounts[st < STATE_HEX.length ? st : ZombieState.Idle]!;
        layer.set(c, pos[0], pos[2], 0, 1, 1);
        this.stateCounts[st < STATE_HEX.length ? st : ZombieState.Idle] = c + 1;
      }
      n += 1;
    });

    this.sight.mesh.visible = flags.showSightRadius;
    if (flags.showSightRadius) this.sight.finalize(n);
    this.attack.mesh.visible = flags.showAttackRadius;
    if (flags.showAttackRadius) this.attack.finalize(n);
    for (let s = 0; s < this.stateMarkers.length; s++) {
      const m = this.stateMarkers[s]!;
      m.mesh.visible = flags.showZombieState;
      if (flags.showZombieState) m.finalize(this.stateCounts[s] ?? 0);
    }

    this.sound.mesh.visible = flags.showSoundField;
    if (flags.showSoundField) {
      const hits = queryStimuli(player.x, player.z);
      const m = Math.min(hits.length, MAX_SOUND);
      for (let i = 0; i < m; i++) {
        // Ring at the sound's MAXIMUM reach (its emit radius) so you see how WIDE it carries; brightness
        // (instance colour) encodes how HARD it is right now (attenuated intensity). Each sound independent.
        const h = hits[i]!;
        this.sound.set(i, h.x, h.z, 0, h.radius, h.radius);
        const b = 0.25 + 0.75 * Math.min(1, h.intensity);
        this.sound.setColor(i, this.markerColor.setRGB(0.98 * b, 0.8 * b, 0.09 * b));
      }
      this.sound.finalize(m);
    }
  }

  dispose(): void {
    this.sight.dispose();
    this.attack.dispose();
    this.sound.dispose();
    for (const m of this.stateMarkers) m.dispose();
    if (this.gridLines) {
      this.gridLines.geometry.dispose();
      (this.gridLines.material as MeshBasicNodeMaterial).dispose();
    }
    if (this.structuralQuads) {
      this.structuralQuads.geometry.dispose();
      (this.structuralQuads.material as MeshBasicNodeMaterial).dispose();
    }
    this.playerCone.geometry.dispose();
    (this.playerCone.material as MeshBasicNodeMaterial).dispose();
  }
}
