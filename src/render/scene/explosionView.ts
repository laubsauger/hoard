// T142 — layered grenade explosion FX. Each blast spawns, from a shared pool of "puffs" (emissive spheres, each
// with its own cloned material for an independent fade): a bright fast CORE flash, a slower grey SMOKE shell that
// expands + lifts, and a handful of EMBERS that fly outward under gravity. Popped from `runtime.drainExplosions()`
// (render loop) + advanced each frame. Render-only (V2). Math.random for ember scatter is fine (audio/visual is
// not replay-deterministic). Geometry shared + every material tracked for V24 disposal.

import { Group, Mesh, MeshStandardMaterial, SphereGeometry } from 'three';
import type { Disposable, ResourceKind } from '../engine/resources';

type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;
type Kind = 'core' | 'smoke' | 'ember';

const POOL = 32; // ~ (1 core + 1 smoke + 5 embers) × 4 concurrent blasts
const EMBERS_PER_BLAST = 5;
const GRAVITY = 9.8;

interface Puff {
  readonly mesh: Mesh;
  readonly mat: MeshStandardMaterial;
  kind: Kind;
  age: number;
  ttl: number; // >= ttl ⇒ free
  baseScale: number;
  maxScale: number;
  vx: number;
  vy: number;
  vz: number;
}

export class ExplosionView {
  readonly group = new Group();
  private readonly puffs: Puff[] = [];

  constructor(track: TrackFn) {
    this.group.name = 'explosions';
    const geo = new SphereGeometry(1, 12, 10);
    track(geo, 'geometry', 'explosion.geo');
    for (let i = 0; i < POOL; i++) {
      const mat = new MeshStandardMaterial({ transparent: true, opacity: 0, depthWrite: false, emissiveIntensity: 3 });
      track(mat, 'material', `explosion.mat.${i}`);
      const mesh = new Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.puffs.push({ mesh, mat, kind: 'core', age: 999, ttl: 1, baseScale: 0, maxScale: 0, vx: 0, vy: 0, vz: 0 });
    }
  }

  private claim(): Puff | null {
    let p = this.puffs.find((q) => q.age >= q.ttl);
    if (!p) {
      // all busy → recycle the most-elapsed (largest age/ttl ratio)
      p = this.puffs.reduce((a, b) => (a.age / a.ttl >= b.age / b.ttl ? a : b));
    }
    return p;
  }

  /** Pop a layered explosion at (x,y,z): a core flash + a smoke shell + a spray of embers. */
  spawn(x: number, y: number, z: number): void {
    const core = this.claim();
    if (core) this.init(core, 'core', x, y, z);
    const smoke = this.claim();
    if (smoke) this.init(smoke, 'smoke', x, y, z);
    for (let i = 0; i < EMBERS_PER_BLAST; i++) {
      const e = this.claim();
      if (e) this.init(e, 'ember', x, y, z);
    }
  }

  private init(p: Puff, kind: Kind, x: number, y: number, z: number): void {
    p.kind = kind;
    p.age = 0;
    p.mesh.visible = true;
    p.mesh.position.set(x, y, z);
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    if (kind === 'core') {
      p.ttl = 0.22;
      p.baseScale = 0.5;
      p.maxScale = 1.8;
      p.mat.color.setHex(0xffd27a);
      p.mat.emissive.setHex(0xff9a2e);
    } else if (kind === 'smoke') {
      p.ttl = 0.75;
      p.baseScale = 0.8;
      p.maxScale = 3.6;
      p.vy = 1.2; // drifts up
      p.mat.color.setHex(0x3a3631);
      p.mat.emissive.setHex(0x140d08);
    } else {
      // ember: a small bright bit flung outward + up, falling under gravity
      p.ttl = 0.45 + Math.random() * 0.25;
      p.baseScale = 0.12;
      p.maxScale = 0.12;
      const ang = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 5;
      p.vx = Math.cos(ang) * speed;
      p.vz = Math.sin(ang) * speed;
      p.vy = 3 + Math.random() * 4;
      p.mat.color.setHex(0xffb347);
      p.mat.emissive.setHex(0xff7a1a);
    }
    p.mesh.scale.setScalar(p.baseScale);
    p.mat.opacity = 1;
  }

  /** Advance every active puff: expand/fade (core, smoke) or ballistic fly-out (embers); free when elapsed. */
  update(dtSeconds: number): void {
    const dt = Math.max(0, dtSeconds);
    for (const p of this.puffs) {
      if (p.age >= p.ttl) continue;
      p.age += dt;
      const t = Math.min(1, p.age / p.ttl);
      if (t >= 1) {
        p.mesh.visible = false;
        p.mat.opacity = 0;
        continue;
      }
      if (p.kind === 'ember') {
        p.vy -= GRAVITY * dt;
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        p.mat.opacity = 1 - t;
      } else {
        const ease = p.kind === 'smoke' ? 1 - (1 - t) * (1 - t) : t; // smoke eases out, core linear+fast
        p.mesh.scale.setScalar(p.baseScale + (p.maxScale - p.baseScale) * ease);
        if (p.vy !== 0) p.mesh.position.y += p.vy * dt; // smoke rises
        p.mat.opacity = (p.kind === 'smoke' ? 0.75 : 1) * (1 - t);
      }
    }
  }
}
