// Dev-tools scene gizmos — perception cones, attack radii, FSM-state markers, heard-sound field, and the
// player vision cone. Driven from the viewport; reads live runtime state + the debug-flag store. Built the
// SAME way the crowd is — InstancedMesh + MeshBasicNodeMaterial — which is the only primitive confirmed to
// render under three's WebGPURenderer (core Line/Points materials do not). Self-hides when no flag is set.
//
// §V78: the player vision cone AND the zombie sight cones are RAYCAST-OCCLUDED visibility POLYGONS, NOT full
// cones — from each agent apex, N rays fan across its FOV and each is clipped at the first occluder along it
// (`rayDistanceToWall` on the SAME nav grid the shots V53/B20 + perception LOS + flashlight clamp V67 use, so
// walls + solid props cast visibility shadows for free). The rim is the polyline of those clipped endpoints,
// rebuilt in place each frame into preallocated buffers (no per-frame allocation, V24). Rings (attack/sound)
// stay a FIXED world-space thickness so a big range never produces a fat band.

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
import { debugConfig } from '@/config/domains/debug';
import type { QualityTier } from '@/config/types';
import type { DebugFlags } from '@/diagnostics/flags';
import { occludedVisibilityRim } from './visibilityRim';

const MAX_GIZMOS = 600;
const MAX_SOUND = 64;
const GIZMO_Y = 0.25;
const RING_THICKNESS = 0.18; // constant world-space ring thickness (T58 feedback: no radius-scaled fat bands)
const Y_AXIS = new Vector3(0, 1, 0);

/** Occluder query supplied by the viewport: distance to the first wall/prop along `heading`, capped at `maxR`. */
type WallDistanceFn = (x: number, z: number, heading: number, maxR: number) => number;

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

/** A flat unit quad in the XZ plane, centred at the origin: local +X is the LENGTH axis (scaled to the edge
 *  length), local Z is the WIDTH axis (scaled to the stroke). DoubleSide material → winding irrelevant. */
function makeUnitQuadXZ(): BufferGeometry {
  const g = new BufferGeometry();
  // prettier-ignore
  const p = [
    -0.5, 0, -0.5,  0.5, 0, -0.5,  0.5, 0, 0.5,
    -0.5, 0, -0.5,  0.5, 0,  0.5, -0.5, 0, 0.5,
  ];
  g.setAttribute('position', new Float32BufferAttribute(p, 3));
  return g;
}

/**
 * §V78 — the OCCLUDED-visibility-polygon OUTLINE: a thin world-space stroke along the boundary apex → clipped
 * rim → apex, rebuilt each frame from raycast rim points. Lines don't render under WebGPU, so the stroke is a
 * set of thin quads (one per boundary edge). Each edge is ONE INSTANCE of a flat unit quad (positioned at the
 * edge midpoint, Y-rotated to the edge direction, scaled to length × stroke) — an InstancedMesh + the shared
 * MeshBasicNodeMaterial, the ONLY primitive confirmed to render under WebGPU (the earlier dynamic single-Mesh +
 * setDrawRange variant did NOT draw at all, B42). Holds up to `maxAgents × (segments+2)` edges; per-frame work
 * only rewrites instance matrices (no reallocation, V24). `mesh.count` bounds what's drawn.
 */
class OccludedRimLayer {
  readonly mesh: InstancedMesh;
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly s = new Vector3();
  private readonly m = new Matrix4();
  private edges = 0; // instance write cursor this frame

  constructor(color: number, maxAgents: number, segments: number, order: number, opacity = 0.85) {
    const maxEdges = maxAgents * (segments + 2); // apex→rim[0], `segments` rim edges, rim[last]→apex
    this.mesh = new InstancedMesh(makeUnitQuadXZ(), gizmoMaterial(color, opacity), maxEdges);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.position.y = GIZMO_Y;
    this.mesh.count = 0;
  }

  begin(): void {
    this.edges = 0;
  }

  /** Append one agent's occluded-rim stroke. apex in world XZ; `rim` = `pointCount` XZ pairs (the clipped
   *  endpoints). `stroke` is the world-space line width. Emits one quad instance per boundary edge. */
  add(apexX: number, apexZ: number, rim: Float32Array, pointCount: number, stroke: number): void {
    this.edge(apexX, apexZ, rim[0]!, rim[1]!, stroke); // apex → rim[0]
    for (let i = 0; i < pointCount - 1; i++) {
      this.edge(rim[i * 2]!, rim[i * 2 + 1]!, rim[(i + 1) * 2]!, rim[(i + 1) * 2 + 1]!, stroke); // rim[i] → rim[i+1]
    }
    this.edge(rim[(pointCount - 1) * 2]!, rim[(pointCount - 1) * 2 + 1]!, apexX, apexZ, stroke); // rim[last] → apex
  }

  /** One edge ax,az → bx,bz as a quad instance (midpoint, Y-rotated to the edge dir, scaled len × stroke). */
  private edge(ax: number, az: number, bx: number, bz: number, stroke: number): void {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-5) return; // a ray clipped to the apex collapses an edge — skip (no zero-scale instance)
    // Y-rotation θ that maps local +X to the edge direction (dx,dz): R_y(θ)·+X = (cosθ, 0, −sinθ), so θ = atan2(−dz, dx).
    this.q.setFromAxisAngle(Y_AXIS, Math.atan2(-dz, dx));
    this.v.set((ax + bx) * 0.5, 0, (az + bz) * 0.5); // midpoint; mesh.position.y lifts it to GIZMO_Y
    this.s.set(len, 1, stroke);
    this.m.compose(this.v, this.q, this.s);
    this.mesh.setMatrixAt(this.edges++, this.m);
  }

  finalize(): void {
    this.mesh.count = this.edges;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicNodeMaterial).dispose();
  }
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
  // §V78: sight + player vision are raycast-OCCLUDED visibility polygons (per-agent dynamic outline), cyan
  // for zombies / violet for the player — NOT a shared scaled cone (an occluder must carve a shadow per agent).
  private readonly sightRim: OccludedRimLayer; // zombie sight cones (cyan), MAX_GIZMOS rims
  private readonly playerRim: OccludedRimLayer; // player vision cone (violet), 1 rim
  private readonly attack: InstancedLayer; // thin ring baked at attackRange (translate only)
  private readonly sound: InstancedLayer; // unit ring scaled per own radius
  private readonly stateMarkers: InstancedLayer[]; // one InstancedMesh per FSM state (solid colour each)
  private readonly stateCounts: number[] = [];
  private readonly markerColor = new Color();
  private readonly sightRange: number;
  private readonly sightFovHalf: number;
  private readonly playerFovHalf: number;
  private readonly playerVisionRange: number;
  private readonly raySegments: number;
  private readonly strokeMeters: number;
  /** Reused scratch for one agent's rim points (XZ pairs) — sized to segments+1; never reallocated (V24). */
  private readonly rimScratch: Float32Array;
  // §V78: occluder query state, mutated per agent so `distanceAt` (created ONCE) stays allocation-free.
  private rimX = 0;
  private rimZ = 0;
  private rimRange = 0;
  private wallDistanceFn: WallDistanceFn | null = null;
  private readonly distanceAt = (angle: number): number =>
    this.wallDistanceFn ? this.wallDistanceFn(this.rimX, this.rimZ, angle, this.rimRange) : this.rimRange;
  /** World overlays (spatial grid lines + filled structural cells) — static, built once from the nav grid. */
  private gridLines: Mesh | null = null;
  private structuralQuads: Mesh | null = null;

  constructor(tier: QualityTier, world?: WorldGridInfo) {
    const p = resolveDomain(perceptionConfig, tier);
    const d = resolveDomain(debugConfig, tier);
    this.sightRange = p.sightRange;
    this.sightFovHalf = (p.fieldOfViewDegrees * Math.PI) / 360;
    this.playerFovHalf = (p.playerFieldOfViewDegrees * Math.PI) / 360;
    this.playerVisionRange = p.playerVisionRange;
    this.raySegments = d.visionDebugRaySegments;
    this.strokeMeters = d.visionDebugStrokeMeters;
    this.rimScratch = new Float32Array((this.raySegments + 1) * 2);

    // §V78: zombie sight = cyan occluded polygon; player vision = violet occluded polygon. Both are rebuilt
    // in place each frame from per-agent raycasts (a wall/prop carves a shadow notch), no shared scaled cone.
    this.sightRim = new OccludedRimLayer(0x38bdf8, MAX_GIZMOS, this.raySegments, 998, 0.85);
    this.playerRim = new OccludedRimLayer(0xc084fc, 1, this.raySegments, 998, 0.85);
    this.attack = new InstancedLayer(makeRing(p.attackRangeMeters, RING_THICKNESS), 0xef4444, MAX_GIZMOS, 999, 0.7);
    this.sound = new InstancedLayer(makeRing(1, RING_THICKNESS), 0xfacc15, MAX_SOUND, 999, 0.6);
    this.stateMarkers = STATE_HEX.map(
      (hex) => new InstancedLayer(new BoxGeometry(0.6, 0.6, 0.6), hex, MAX_GIZMOS, 1000, 0.95),
    );

    this.playerRim.mesh.visible = false;
    this.group.add(this.sightRim.mesh, this.playerRim.mesh, this.attack.mesh, this.sound.mesh);
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
    wallDistance?: WallDistanceFn,
  ): void {
    const showPlayer = flags.showPlayerVision;
    this.wallDistanceFn = wallDistance ?? null; // §V78: occluder query for this frame (null → unoccluded full cone)
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

    const segs = this.raySegments;
    const rimPoints = segs + 1;

    // §V78: player vision = a RAYCAST-OCCLUDED polygon — fan rays across the FOV, clip each at the first
    // occluder, stroke the apex → clipped rim → apex boundary (a wall ahead carves a shadow, see around corners).
    this.playerRim.mesh.visible = showPlayer;
    if (showPlayer) {
      this.rimX = player.x;
      this.rimZ = player.z;
      this.rimRange = this.playerVisionRange;
      const rim = occludedVisibilityRim(
        player.x, player.z, player.heading, this.playerFovHalf, this.playerVisionRange, segs, this.distanceAt, this.rimScratch,
      );
      this.playerRim.begin();
      this.playerRim.add(player.x, player.z, rim, rimPoints, this.strokeMeters);
      this.playerRim.finalize();
    }

    for (let s = 0; s < STATE_HEX.length; s++) this.stateCounts[s] = 0;
    let n = 0;
    const pos: [number, number, number] = [0, 0, 0];
    this.sightRim.begin();
    zombies.forEachAlive((slot) => {
      if (n >= MAX_GIZMOS) return;
      zombies.getPosition(slot, pos);
      const heading = zombies.getHeading(slot);
      if (flags.showSightRadius) {
        // §V78: per-agent raycast-occluded sight polygon (each ray clipped at the first wall/prop along it),
        // so corners + obstacles cast visibility shadows — NOT a full cone cropped only on the heading ray.
        this.rimX = pos[0];
        this.rimZ = pos[2];
        this.rimRange = this.sightRange;
        const rim = occludedVisibilityRim(
          pos[0], pos[2], heading, this.sightFovHalf, this.sightRange, segs, this.distanceAt, this.rimScratch,
        );
        this.sightRim.add(pos[0], pos[2], rim, rimPoints, this.strokeMeters);
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

    this.sightRim.mesh.visible = flags.showSightRadius;
    if (flags.showSightRadius) this.sightRim.finalize();
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
    this.sightRim.dispose();
    this.playerRim.dispose();
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
  }
}
