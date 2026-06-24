// T60 — nearest-interactable resolution + the "{key} to {action}" prompt picks the right verb by target type.
import { describe, it, expect } from 'vitest';
import { nearestInteractable, hoveredInteractable, interactionActionLabel, interactionPrompt } from './nearest';
import { resolveInteractions } from './resolve';
import type { InteractionTargetWorld } from './nearest';

const door: InteractionTargetWorld = { kind: 'door', access: 'closed', x: 0, z: 0, label: 'Door' };
const container: InteractionTargetWorld = { kind: 'container', x: 10, z: 0, label: 'Kitchen Cupboard' };
const windowT: InteractionTargetWorld = { kind: 'window', access: 'closed', x: 0, z: 10, label: 'Window' };

describe('nearest interactable + prompt (T60)', () => {
  it('picks the NEAREST target within reach', () => {
    const near = nearestInteractable([door, container, windowT], 9, 0, 3);
    expect(near?.target.kind).toBe('container'); // standing next to the cupboard
    expect(near?.distanceMeters).toBeCloseTo(1);
  });

  it('returns null when nothing is in reach', () => {
    expect(nearestInteractable([door, container, windowT], 100, 100, 3)).toBeNull();
  });

  it('HOVER pick (T136): among in-reach targets, the MOUSE chooses which one — disambiguates adjacent targets', () => {
    // door at (0,0) + container at (1,0); player at (0,0) is within reach (3 m) of BOTH. The pointer decides.
    const closeContainer: InteractionTargetWorld = { kind: 'container', x: 1, z: 0, label: 'Cupboard' };
    const targets = [door, closeContainer];
    // pointer hovering the CONTAINER → the container is picked (even though the door is closer to the player).
    expect(hoveredInteractable(targets, 0, 0, 3, 1.2, 0)?.target.kind).toBe('container');
    // sweep the pointer onto the DOOR → the door is picked.
    expect(hoveredInteractable(targets, 0, 0, 3, -0.2, 0)?.target.kind).toBe('door');
    // distanceMeters stays the PLAYER→target reach (prompt anchor), not the pointer distance.
    expect(hoveredInteractable(targets, 0, 0, 3, 1.2, 0)?.distanceMeters).toBeCloseTo(1);
  });

  it('HOVER pick still requires the target to be IN REACH of the player (pointer alone never reaches)', () => {
    // pointer sits right on the far container, but the player at (0,0) is out of its reach (10 m > 3) → null.
    expect(hoveredInteractable([door, container], 0, 0, 3, 10, 0)?.target.kind).toBe('door'); // door is in reach
    expect(hoveredInteractable([container], 0, 0, 3, 10, 0)).toBeNull(); // only the far one → nothing in reach
  });

  it('HOVER pick honours a hover RADIUS — pointer far from every in-reach target selects NONE (T136 hold-last)', () => {
    // door in reach at (0,0); pointer at (10,0) is beyond the 1.4 m hover radius → not hovered → null (the runtime
    // then HOLDS its last selection so moving the cursor to the menu over empty floor doesn't drop focus).
    expect(hoveredInteractable([door], 0, 0, 3, 10, 0, 1.4)).toBeNull();
    // pointer ON the door (within the radius) → selects it.
    expect(hoveredInteractable([door], 0, 0, 3, 0.2, 0, 1.4)?.target.kind).toBe('door');
  });

  it('the prompt action depends on the nearest target TYPE + state', () => {
    expect(interactionActionLabel(door)).toBe('open door');
    expect(interactionActionLabel({ ...door, access: 'open' })).toBe('close door');
    expect(interactionActionLabel(container)).toBe('search');
    expect(interactionActionLabel(windowT)).toBe('climb through');
    expect(interactionActionLabel({ kind: 'structure' })).toBe('breach wall');
  });

  it('interactionPrompt carries the bound key + the resolved action for the nearest target', () => {
    const near = nearestInteractable([door, container, windowT], 0, 0.5, 3);
    expect(near?.target.kind).toBe('door');
    const prompt = interactionPrompt(near!.target, 'E');
    expect(prompt).toMatchObject({ key: 'E', action: 'open door', kind: 'door' });
  });

  it('resolution offers door verbs near a door, container verbs near storage, window verbs near a window', () => {
    expect(resolveInteractions(door).some((v) => v.id === 'open')).toBe(true);
    expect(resolveInteractions(container).some((v) => v.action === 'container.loot')).toBe(true);
    expect(resolveInteractions(windowT).some((v) => v.id === 'climb')).toBe(true);
  });

  it('the window headline verb is STATE-DRIVEN (T108): boarded → remove, intact → smash, open → climb', () => {
    expect(interactionActionLabel({ kind: 'window', boards: 2, glass: 'open' })).toBe('remove boards');
    expect(interactionActionLabel({ kind: 'window', boards: 0, glass: 'intact' })).toBe('smash glass');
    expect(interactionActionLabel({ kind: 'window', boards: 0, glass: 'smashed' })).toBe('climb through');
    expect(interactionActionLabel({ kind: 'window', boards: 0, glass: 'open' })).toBe('climb through');
  });
});
