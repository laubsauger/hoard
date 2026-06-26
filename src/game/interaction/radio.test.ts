// T40 — the objective RADIO hub's context verbs (pure resolveInteractions). One live verb per stage, gated by
// what the player carries: install (needs a part) → repair (needs a tool, toggles while channeling) → call.

import { describe, it, expect } from 'vitest';
import { resolveInteractions, type InteractionTarget } from './resolve';

const radio = (over: Partial<InteractionTarget>): InteractionTarget => ({ kind: 'radio', partsFound: 0, partsRequired: 3, ...over });

describe('radio interaction verbs (T40)', () => {
  it('collect stage offers Install — enabled only with a carried part', () => {
    const t = radio({ radioStage: 'collect', partsFound: 1, partsRequired: 3 });
    const without = resolveInteractions(t, { hasRadioPart: false });
    expect(without).toHaveLength(1);
    expect(without[0]!.enabled).toBe(false);
    expect(without[0]!.reason).toMatch(/radio part/);
    expect(without[0]!.label).toContain('1/3');

    const withPart = resolveInteractions(t, { hasRadioPart: true });
    expect(withPart[0]!.enabled).toBe(true);
    expect(withPart[0]!.action).toBe('radio.install');
  });

  it('repair stage gates Repair on a tool, and toggles to Stop while channeling', () => {
    const noTool = resolveInteractions(radio({ radioStage: 'repair' }), { hasRepairTool: false });
    expect(noTool[0]!.enabled).toBe(false);
    expect(noTool[0]!.reason).toMatch(/screwdriver|hammer/);

    const withTool = resolveInteractions(radio({ radioStage: 'repair' }), { hasRepairTool: true });
    expect(withTool[0]!.enabled).toBe(true);
    expect(withTool[0]!.label).toBe('Repair radio');

    const channeling = resolveInteractions(radio({ radioStage: 'repair', repairing: true }), { hasRepairTool: true });
    expect(channeling[0]!.label).toBe('Stop repair');
    expect(channeling[0]!.action).toBe('radio.repair');
  });

  it('call stage offers Call for evacuation; done stage offers nothing', () => {
    const call = resolveInteractions(radio({ radioStage: 'call' }), {});
    expect(call[0]!.enabled).toBe(true);
    expect(call[0]!.action).toBe('radio.call');

    expect(resolveInteractions(radio({ radioStage: 'done' }), {})).toHaveLength(0);
  });
});
