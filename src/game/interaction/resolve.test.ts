// T59 / V43 — interaction resolution: context-filtered verbs, disabled with the missing requirement.
import { describe, it, expect } from 'vitest';
import { resolveInteractions } from './resolve';

describe('interaction resolution (T59/V43)', () => {
  it('a closed door offers open/lock + gated board/breach', () => {
    const v = resolveInteractions({ kind: 'door', access: 'closed' }, {});
    expect(v.find((x) => x.id === 'open')?.enabled).toBe(true);
    expect(v.find((x) => x.id === 'board')?.enabled).toBe(false); // no hammer/planks
    expect(v.find((x) => x.id === 'board')?.reason).toMatch(/hammer/);
  });

  it('board becomes enabled with hammer + planks', () => {
    const v = resolveInteractions({ kind: 'door', access: 'closed' }, { hasHammer: true, hasPlanks: true });
    expect(v.find((x) => x.id === 'board')?.enabled).toBe(true);
  });

  it('a locked door needs a key to unlock', () => {
    const noKey = resolveInteractions({ kind: 'door', access: 'locked' }, {});
    expect(noKey.find((x) => x.id === 'unlock')?.enabled).toBe(false);
    const withKey = resolveInteractions({ kind: 'door', access: 'locked' }, { hasKey: true });
    expect(withKey.find((x) => x.id === 'unlock')?.enabled).toBe(true);
  });

  it('container + corpse offer loot/search', () => {
    expect(resolveInteractions({ kind: 'container' }).some((x) => x.action === 'container.loot')).toBe(true);
    expect(resolveInteractions({ kind: 'corpse' }).some((x) => x.action === 'corpse.search')).toBe(true);
  });

  it('structure breach is gated on a tool', () => {
    const v = resolveInteractions({ kind: 'structure' }, {});
    expect(v.find((x) => x.id === 'breach')?.enabled).toBe(false);
    expect(resolveInteractions({ kind: 'structure' }, { hasTool: true }).find((x) => x.id === 'breach')?.enabled).toBe(true);
  });
});
