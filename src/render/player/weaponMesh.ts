// T141 — procedural held-weapon meshes for the player avatar. No weapon GLB assets ship, so each weapon CLASS
// gets a small stylized primitive (a gun / long-gun / blade / club) built from boxes + a cylinder, scene-lit.
// The avatar attaches the matching mesh to its RIGHT-HAND bone (weaponMesh ← skeleton drives it through the
// animation). PURE geometry construction; the avatar owns attachment + V24 disposal tracking.

import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, type Object3D } from 'three';
import { ITEM, weaponClassForItem } from '@/game/inventory';
import type { Disposable, ResourceKind } from '../engine/resources';

/** The visual archetypes a held item maps to (drives which primitive mesh is shown). */
export type WeaponVisual = 'pistol' | 'longgun' | 'blade' | 'club' | 'torch';

export const WEAPON_VISUALS: readonly WeaponVisual[] = ['pistol', 'longgun', 'blade', 'club', 'torch'];

/** The held-weapon visual for an item, or null when the item isn't held in-hand (non-equippable). */
export function weaponVisualForItem(item: number): WeaponVisual | null {
  if (item === ITEM.Torch) return 'torch'; // a melee weapon, but it reads as a lit torch (T147)
  const cls = weaponClassForItem(item);
  if (cls === 'pistol') return 'pistol';
  if (cls === 'shotgun' || cls === 'rifle' || cls === 'smg') return 'longgun';
  if (cls === 'melee') return item === ITEM.KitchenKnife ? 'blade' : 'club';
  // Hand tools read as a held handle (club) when drawn. The FLASHLIGHT is excluded — it is an OFF-hand prop
  // (rendered in the left hand while lit, T141), not a right-hand weapon.
  if (item === ITEM.Hammer || item === ITEM.Saw || item === ITEM.Screwdriver) return 'club';
  return null;
}

/** Build the off-hand FLASHLIGHT prop (held in the LEFT hand while the beam is lit) — a short dark body with a
 *  bright lens cap. Long axis along local +X (the beam/nose direction). Geometries + material are V24-tracked. */
export function buildFlashlightMesh(track: TrackFn): Object3D {
  const body = new MeshStandardMaterial({ color: 0x23262b, metalness: 0.4, roughness: 0.5 });
  const lens = new MeshStandardMaterial({ color: 0xfff3c4, metalness: 0, roughness: 0.3, emissive: 0xfff0b0, emissiveIntensity: 0.4 });
  track(body, 'material', 'flashlight.mat.body');
  track(lens, 'material', 'flashlight.mat.lens');
  const bodyGeo = new CylinderGeometry(0.022, 0.026, 0.13, 12);
  const lensGeo = new CylinderGeometry(0.03, 0.026, 0.02, 12);
  track(bodyGeo, 'geometry', 'flashlight.geo.body');
  track(lensGeo, 'geometry', 'flashlight.geo.lens');
  const group = new Group();
  group.name = 'flashlight.offhand';
  const bodyMesh = new Mesh(bodyGeo, body);
  bodyMesh.rotation.z = -Math.PI / 2; // cylinder +Y → point along +X
  bodyMesh.position.set(0.065, 0, 0);
  bodyMesh.castShadow = true;
  const lensMesh = new Mesh(lensGeo, lens);
  lensMesh.rotation.z = -Math.PI / 2;
  lensMesh.position.set(0.14, 0, 0);
  group.add(bodyMesh, lensMesh);
  return group;
}

export type TrackFn = (resource: Disposable, kind: ResourceKind, label: string) => void;

/** Build one mesh per weapon visual (detached Groups). The long axis points along local +X with the GRIP at the
 *  origin, so the avatar can seat the origin in the palm. Geometries + the two shared materials are V24-tracked. */
export function buildWeaponMeshes(track: TrackFn): Record<WeaponVisual, Object3D> {
  const steel = new MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.6, roughness: 0.45 });
  const wood = new MeshStandardMaterial({ color: 0x6b4a2b, metalness: 0.0, roughness: 0.8 });
  track(steel, 'material', 'weapon.mat.steel');
  track(wood, 'material', 'weapon.mat.wood');

  let geoSeq = 0;
  const box = (w: number, h: number, d: number): BoxGeometry => {
    const g = new BoxGeometry(w, h, d);
    track(g, 'geometry', `weapon.geo.${geoSeq++}`);
    return g;
  };
  const part = (g: BoxGeometry | CylinderGeometry, mat: MeshStandardMaterial, x: number, y = 0, z = 0): Mesh => {
    const m = new Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = false;
    return m;
  };

  // PISTOL — short barrel block above a stubby grip.
  const pistol = new Group();
  pistol.add(part(box(0.18, 0.05, 0.035), steel, 0.07, 0.02));
  pistol.add(part(box(0.04, 0.10, 0.032), steel, 0.0, -0.04));
  pistol.name = 'weapon.pistol';

  // LONG GUN (shotgun / rifle) — long barrel + a wooden stock behind the grip.
  const longgun = new Group();
  longgun.add(part(box(0.85, 0.05, 0.05), steel, 0.42, 0.01));
  longgun.add(part(box(0.2, 0.07, 0.04), wood, -0.06, -0.01));
  longgun.name = 'weapon.longgun';

  // BLADE (kitchen knife) — thin steel blade + a short wooden handle.
  const blade = new Group();
  blade.add(part(box(0.18, 0.014, 0.04), steel, 0.14, 0.0));
  blade.add(part(box(0.08, 0.03, 0.03), wood, 0.02, 0.0));
  blade.name = 'weapon.blade';

  // CLUB (bat / crowbar / axe / tool) — a tapered wooden shaft (cylinder long-axis rotated onto +X).
  const club = new Group();
  const shaftGeo = new CylinderGeometry(0.018, 0.03, 0.6, 10);
  track(shaftGeo, 'geometry', `weapon.geo.${geoSeq++}`);
  const shaft = new Mesh(shaftGeo, wood);
  shaft.rotation.z = -Math.PI / 2; // cylinder default +Y → point along +X
  shaft.position.set(0.3, 0.0, 0.0);
  shaft.castShadow = true;
  club.add(shaft);
  club.name = 'weapon.club';

  // TORCH (T147) — a short wooden handle topped with an emissive flame (the held light/melee weapon).
  const flameMat = new MeshStandardMaterial({ color: 0xff8a2a, emissive: 0xff7a1a, emissiveIntensity: 3.2, transparent: true, opacity: 0.92 });
  track(flameMat, 'material', 'weapon.mat.flame');
  const torch = new Group();
  const handleGeo = new CylinderGeometry(0.015, 0.02, 0.32, 10);
  track(handleGeo, 'geometry', `weapon.geo.${geoSeq++}`);
  const handle = new Mesh(handleGeo, wood);
  handle.rotation.z = -Math.PI / 2;
  handle.position.set(0.16, 0, 0);
  handle.castShadow = true;
  const flameGeo = new SphereGeometry(0.06, 10, 8);
  track(flameGeo, 'geometry', `weapon.geo.${geoSeq++}`);
  const flame = new Mesh(flameGeo, flameMat);
  flame.position.set(0.35, 0.02, 0);
  flame.scale.set(1, 1.6, 1); // teardrop flame
  torch.add(handle, flame);
  torch.name = 'weapon.torch';

  return { pistol, longgun, blade, club, torch };
}
