// T141 — held-weapon mesh factory: item→visual routing + the prebuilt meshes (one Group per visual, GPU
// resources tracked for V24 disposal). Pure construction — no GPU needed.
import { describe, it, expect } from 'vitest';
import { Group } from 'three';
import { buildWeaponMeshes, buildFlashlightMesh, weaponVisualForItem, WEAPON_VISUALS } from './weaponMesh';
import { ITEM } from '@/game/inventory';
import type { Disposable, ResourceKind } from '../engine/resources';

describe('weaponVisualForItem (T141)', () => {
  it('maps each weapon class to its held visual', () => {
    expect(weaponVisualForItem(ITEM.Pistol)).toBe('pistol');
    expect(weaponVisualForItem(ITEM.Shotgun)).toBe('longgun');
    expect(weaponVisualForItem(ITEM.HuntingRifle)).toBe('longgun');
    expect(weaponVisualForItem(ITEM.KitchenKnife)).toBe('blade');
    expect(weaponVisualForItem(ITEM.BaseballBat)).toBe('club');
    expect(weaponVisualForItem(ITEM.FireAxe)).toBe('club');
    expect(weaponVisualForItem(ITEM.Hammer)).toBe('club'); // tool held as a handle
  });

  it('returns null for items that are not a RIGHT-hand weapon (incl. the off-hand flashlight)', () => {
    expect(weaponVisualForItem(ITEM.Bandage)).toBeNull();
    expect(weaponVisualForItem(ITEM.Ammo9mm)).toBeNull();
    expect(weaponVisualForItem(ITEM.WaterBottle)).toBeNull();
    expect(weaponVisualForItem(ITEM.Flashlight)).toBeNull(); // off-hand prop, not a drawn weapon
  });
});

describe('buildFlashlightMesh (T141)', () => {
  it('builds an off-hand flashlight Group and tracks its GPU resources', () => {
    const tracked: ResourceKind[] = [];
    const mesh = buildFlashlightMesh((_r: Disposable, kind: ResourceKind) => {
      tracked.push(kind);
    });
    expect(mesh).toBeInstanceOf(Group);
    expect(mesh.children.length).toBeGreaterThan(0);
    expect(tracked.filter((k) => k === 'material').length).toBe(2); // body + lens
    expect(tracked.filter((k) => k === 'geometry').length).toBe(2);
  });
});

describe('buildWeaponMeshes (T141)', () => {
  it('builds one mesh Group per visual and tracks every GPU resource', () => {
    const tracked: { kind: ResourceKind; label: string }[] = [];
    const track = (_r: Disposable, kind: ResourceKind, label: string): void => {
      tracked.push({ kind, label });
    };
    const meshes = buildWeaponMeshes(track);
    for (const v of WEAPON_VISUALS) {
      expect(meshes[v]).toBeInstanceOf(Group);
      expect(meshes[v].children.length).toBeGreaterThan(0);
    }
    // shared materials (steel + wood + torch flame) + several geometries, all tracked (no leaks, V24).
    expect(tracked.filter((t) => t.kind === 'material').length).toBe(3);
    expect(tracked.filter((t) => t.kind === 'geometry').length).toBeGreaterThan(0);
  });
});
