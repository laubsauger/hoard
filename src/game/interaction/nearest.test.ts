// T60 — nearest-interactable resolution + the "{key} to {action}" prompt picks the right verb by target type.
import { describe, it, expect } from 'vitest';
import { nearestInteractable, interactionActionLabel, interactionPrompt } from './nearest';
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
