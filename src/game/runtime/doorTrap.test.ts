// V42 trap guard — closing a door onto the player must be REFUSED (blocking the cell the player occupies
// traps them: every radius-aware wall-slide candidate then fails, so they cannot move out). The close is a
// no-op that returns the still-open access; once the player steps clear of the door cell the close succeeds.
import { describe, it, expect } from 'vitest';
import { GameRuntime } from './gameRuntime';
import { buildCityBlock } from '@/game/scene';
import { InMemoryPersistenceAdapter } from '@/game/persistence';

const TIER = 'desktop-high' as const;

function makeRuntime() {
  return new GameRuntime({ tier: TIER, adapter: new InMemoryPersistenceAdapter(), scene: buildCityBlock() });
}

describe('door close trap guard (V42)', () => {
  it('refuses to close a door while the player stands on its cell, then closes once clear', () => {
    const rt = makeRuntime();
    const cs = rt.scene.navGrid.settings.navCellSize;
    const door = rt.doorViews()[0];
    expect(door).toBeDefined();
    const navCell = rt.scene.navGrid.index(door!.cx, door!.cy);

    // Ensure the door is OPEN (so the cell is walkable and the player can stand on it).
    rt.setDoor(navCell, true);
    expect(rt.doorViews().find((d) => d.cx === door!.cx && d.cy === door!.cy)?.access).toBe('open');

    // Walk the player onto the door cell — step toward the door centre until within half a cell of it.
    for (let i = 0; i < 600; i++) {
      const p = rt.player();
      const dx = door!.x - p.x;
      const dz = door!.z - p.z;
      if (Math.hypot(dx, dz) <= cs * 0.4) break;
      rt.movePlayer(dx, dz, 0.05);
    }
    const onCell = rt.player();
    expect(Math.hypot(door!.x - onCell.x, door!.z - onCell.z)).toBeLessThan(cs * 0.5);

    // Closing now would trap the player → refused, door stays open.
    expect(rt.setDoor(navCell, false)).toBe('open');
    expect(rt.doorViews().find((d) => d.cx === door!.cx && d.cy === door!.cy)?.access).toBe('open');

    // Step well clear of the door cell, then the close takes.
    for (let i = 0; i < 200; i++) {
      const p = rt.player();
      const dx = onCell.x - door!.x; // away from the door, along the entry direction
      const dz = onCell.z - door!.z;
      rt.movePlayer(dx, dz, 0.05);
      // Clear by more than a full cell → player centre is well off the door cell (half-cell + body radius).
      if (Math.hypot(door!.x - p.x, door!.z - p.z) > cs) break;
    }
    expect(rt.setDoor(navCell, false)).toBe('closed');
  });
});
