// T80 — the multi-building suburban DISTRICT: a street grid carrying MANY separately-enterable houses, one
// of which keeps the destructible dividing wall (the §G promise). Asserts the authored layout + the
// extended TestBlock contract (buildings / groundRects / props) the renderer consumes.

import { describe, it, expect } from 'vitest';
import { buildCityDistrict } from './cityDistrict';
import { buildingsOf, hasLineOfSight } from './testBlock';
import { reachableFromExterior } from './houseTemplates';
import { FlowField } from '@/game/navigation';

describe('city district scene (T80 — large multi-building world)', () => {
  it('authors MANY separately-enterable buildings on a street grid', () => {
    const { block } = buildCityDistrict();
    const buildings = buildingsOf(block);
    expect(buildings.length).toBeGreaterThanOrEqual(8); // Project-Zomboid-scale, NOT one house
    // thin-wall model: each building's bounds are EXACTLY its template's W×D ROOM cells — NO exterior wall ring
    // (no +2). At navCellSize 2 m a single-storey footprint runs ~8–24 m. buildingsOf() and placedHouses share
    // stamping order, so building[i] is house[i].
    const houses = block.placedHouses!;
    expect(houses.length).toBe(buildings.length);
    buildings.forEach((b, i) => {
      const wCells = b.bounds.maxCx - b.bounds.minCx + 1;
      const dCells = b.bounds.maxCy - b.bounds.minCy + 1;
      // bounds === the template footprint (W×D), NOT (W+2)×(D+2)
      expect(wCells).toBe(houses[i]!.template.footprint.w);
      expect(dCells).toBe(houses[i]!.template.footprint.d);
      expect(wCells).toBe(houses[i]!.width);
      expect(dCells).toBe(houses[i]!.depth);
      const w = wCells * block.navGrid.settings.navCellSize;
      const d = dCells * block.navGrid.settings.navCellSize;
      expect(w).toBeGreaterThanOrEqual(8);
      expect(w).toBeLessThanOrEqual(24);
      expect(d).toBeGreaterThanOrEqual(8);
      expect(d).toBeLessThanOrEqual(24);
    });
  });

  it('exterior walls are THIN edge-walls — every perimeter room cell is walkable but cannot cross OUT (no ring)', () => {
    const { block } = buildCityDistrict();
    const grid = block.navGrid;
    // SOLID furniture cells (world). A perimeter room cell carrying a wall-backed solid piece (bed / dresser /
    // nightstand / sink / …) is blocked by FURNITURE, not by an exterior wall ring — exclude it so the blockedInner
    // count measures only a (regressed) blocked WALL ring, not the intended furniture solidity.
    const furnitureCells = new Set<number>();
    for (const p of block.placedFurniture ?? []) {
      if (!p.solid) continue;
      for (let dy = 0; dy < p.footprint.d; dy++) {
        for (let dx = 0; dx < p.footprint.w; dx++) furnitureCells.add(grid.index(p.cx + dx, p.cy + dy));
      }
    }
    let walledEdges = 0;
    let walkableInner = 0;
    let blockedInner = 0;
    for (const house of block.placedHouses!) {
      // outward direction of an exterior edge: the side whose neighbour is OUTSIDE the footprint (roomAt → null),
      // picked from the edge's `along` axis — the same world-coord derivation the scene + renderer use.
      const dirOf = (e: (typeof house.wallEdges)[number]): readonly [number, number] => {
        if (e.along === 'x') return house.roomAt(e.innerCx, e.innerCy - 1) === null ? [0, -1] : [0, 1];
        return house.roomAt(e.innerCx - 1, e.innerCy) === null ? [-1, 0] : [1, 0];
      };
      const frontDoorEdges = new Set(house.doors.filter((dr) => dr.front).map((dr) => dr.edge.key));
      for (const e of house.wallEdges) {
        if (e.kind !== 'exterior') continue;
        const [dx, dy] = dirOf(e);
        const ox = e.innerCx + dx;
        const oy = e.innerCy + dy;
        // the INNER room cell is walkable FLOOR — there is no sealed wall ring. (A SOLID furniture piece may sit on
        // a perimeter room cell; that's an orthogonal cell-block, not the edge-wall this test probes — skip it.)
        const innerIdx = grid.index(e.innerCx, e.innerCy);
        const innerBlocked = grid.isBlocked(innerIdx);
        if (innerBlocked) {
          // a SOLID furniture piece against the wall — an orthogonal cell-block, not the ring this test probes.
          if (!furnitureCells.has(innerIdx)) blockedInner += 1;
          continue;
        }
        walkableInner += 1;
        if (frontDoorEdges.has(e.key)) continue; // the door edge is the cleared exception (its own test)
        if (grid.isBlocked(grid.index(ox, oy))) continue; // a prop/car parked on the outer street cell — skip
        // both cells walkable, but the shared EDGE is WALLED — a body can't cross out (the thin exterior
        // edge-wall), and BOTH cells stay walkable (no blocked ring volume).
        expect(grid.canCross(e.innerCx, e.innerCy, ox, oy)).toBe(false);
        walledEdges += 1;
      }
    }
    // the perimeter is WALKABLE floor with thin edge-walls — NOT a blocked ring. In the old (W+2)×(D+2) model
    // EVERY perimeter cell was a blocked wall (walkableInner would be 0); here the majority are walkable room
    // cells (some carry solid furniture against the wall — an orthogonal cell-block, counted separately).
    expect(walkableInner).toBeGreaterThan(blockedInner);
    expect(walkableInner).toBeGreaterThan(100);
    expect(walledEdges).toBeGreaterThan(0);
  });

  it('buildingBounds is the union bbox covering every building (back-compat accessor)', () => {
    const { block } = buildCityDistrict();
    const bb = block.buildingBounds;
    for (const b of buildingsOf(block)) {
      expect(b.bounds.minCx).toBeGreaterThanOrEqual(bb.minCx);
      expect(b.bounds.minCy).toBeGreaterThanOrEqual(bb.minCy);
      expect(b.bounds.maxCx).toBeLessThanOrEqual(bb.maxCx);
      expect(b.bounds.maxCy).toBeLessThanOrEqual(bb.maxCy);
    }
  });

  it('gives every building a front EDGE-door; all enterable EXCEPT the player house (starts sheltered/closed)', () => {
    const { block } = buildCityDistrict();
    expect(block.exitCells.length).toBe(buildingsOf(block).length); // one door per building
    const grid = block.navGrid;
    const DELTA: Record<'n' | 's' | 'e' | 'w', readonly [number, number]> = {
      n: [0, -1],
      s: [0, 1],
      e: [1, 0],
      w: [-1, 0],
    };
    const contains = (b: { minCx: number; maxCx: number; minCy: number; maxCy: number }, cell: { cx: number; cy: number }) =>
      cell.cx >= b.minCx && cell.cx <= b.maxCx && cell.cy >= b.minCy && cell.cy <= b.maxCy;
    const playerHouse = buildingsOf(block).find((bld) => contains(bld.bounds, block.playerCell));
    let closed = 0;
    for (const cell of block.exitCells) {
      // Thin-wall house model: the door is an EDGE-door. The INNER room cell is always walkable floor; the
      // front door's passability lives on its EXTERIOR EDGE toward `edgeDir` (the outer street cell).
      const c = block.cellCenter(cell);
      expect(block.isWalkableWorld(c.x, c.z)).toBe(true); // the inner room cell is walkable for every house
      expect(cell.edgeDir).toBeDefined();
      const [dx, dy] = DELTA[cell.edgeDir!];
      const outerCx = cell.cx + dx;
      const outerCy = cell.cy + dy;
      const inPlayerHouse = playerHouse ? contains(playerHouse.bounds, cell) : false;
      if (inPlayerHouse) {
        // The player's spawn house starts SHELTERED — its front-door EDGE begins WALLED (closed): the body can't
        // cross out and sight/sound don't pass, but the cell stays walkable.
        expect(grid.canCross(cell.cx, cell.cy, outerCx, outerCy)).toBe(false);
        closed += 1;
      } else {
        expect(grid.canCross(cell.cx, cell.cy, outerCx, outerCy)).toBe(true); // every other house's door edge is open
      }
    }
    expect(closed).toBe(1); // exactly the player house is sealed at start
  });

  it('places player + horde spawn on walkable cells (interior vs central green)', () => {
    const { block } = buildCityDistrict();
    const p = block.cellCenter(block.playerCell);
    const s = block.cellCenter(block.spawnCenterCell);
    expect(block.isWalkableWorld(p.x, p.z)).toBe(true);
    expect(block.isWalkableWorld(s.x, s.z)).toBe(true);
  });

  it('keeps the ONE destructible dividing-wall section intact (blocked) at build time', () => {
    const { block } = buildCityDistrict();
    for (let z = 0; z < block.wall.sizeZ; z++) {
      const sc = block.wall.packCell(0, 0, z);
      expect(block.wall.isBreached(sc)).toBe(false);
      const c = block.cellCenter(block.navCellForStructuralCell(sc));
      expect(block.isWalkableWorld(c.x, c.z)).toBe(false); // intact wall blocks the route
    }
  });

  it('lays streaming sectors on walkable open ground (promotion scatter never starts in a wall)', () => {
    const { block, sectors } = buildCityDistrict();
    expect(sectors.length).toBeGreaterThan(0);
    for (const sec of sectors) {
      expect(block.isWalkableWorld(sec.centerX, sec.centerZ)).toBe(true);
    }
  });

  // P0b: real room-based houses generated from floor-plan templates (placeHouse) replace the old
  // perimeter-cell shells + the §G test-wall that used to bisect a house.
  it('generates a room-based house per building — typed rooms, a front door, reachable interior', () => {
    const { block } = buildCityDistrict();
    expect(block.placedHouses && block.placedHouses.length).toBe(buildingsOf(block).length);
    for (const house of block.placedHouses!) {
      // a tiled room map covering the whole footprint
      expect(house.rooms.length).toBe(house.width * house.depth);
      // exactly one front door, and every room reachable from the exterior door via interior doors
      const plan = house.template.levels[0]!;
      const fronts = house.doors.filter((dr) => dr.front);
      expect(fronts.length).toBe(1);
      expect(reachableFromExterior(plan.rooms, plan.doors)).toBe(true);
      // interior partition walls exist between differing rooms (a real multi-room layout, not one box)
      expect(house.wallEdges.some((e) => e.kind === 'interior')).toBe(true);
    }
  });

  // P2: street variety — the district draws from MULTIPLE single-storey archetypes (not one repeated shell).
  it('varies house archetypes across the street (P2)', () => {
    const { block } = buildCityDistrict();
    const ids = new Set(block.placedHouses!.map((h) => h.template.id));
    expect(ids.size).toBeGreaterThanOrEqual(2); // a believable street of differing homes
    for (const h of block.placedHouses!) expect(h.template.storeys).toBe(1); // single-storey until P3
  });

  it('exposes rooms-as-regions (roomAt) over each house interior, null outside', () => {
    const { block } = buildCityDistrict();
    expect(block.roomAt).toBeDefined();
    // the player's start cell resolves to a typed room
    const here = block.roomAt!(block.playerCell.cx, block.playerCell.cy);
    expect(here).not.toBeNull();
    expect(typeof here!.type).toBe('string');
    // the central green (horde muster) is not inside any house
    expect(block.roomAt!(block.spawnCenterCell.cx, block.spawnCenterCell.cy)).toBeNull();
  });

  it('the §G breach wall no longer bisects a house — its cells sit outside every building', () => {
    const { block } = buildCityDistrict();
    for (let z = 0; z < block.wall.sizeZ; z++) {
      const cell = block.navCellForStructuralCell(block.wall.packCell(0, 0, z));
      const insideAHouse = buildingsOf(block).some(
        (b) => cell.cx >= b.bounds.minCx && cell.cx <= b.bounds.maxCx && cell.cy >= b.bounds.minCy && cell.cy <= b.bounds.maxCy,
      );
      expect(insideAHouse).toBe(false);
    }
  });

  // P0 fix: interior partition walls are REAL nav collision (edge-walls), wired from each house's wallEdges.
  it('wires interior partitions as edge-walls: cells stay walkable but cannot cross; doorways are passable or a CLOSED interactive door (T135)', () => {
    const { block } = buildCityDistrict();
    const grid = block.navGrid;
    let walledPartitions = 0;
    let openDoorways = 0;
    let closedDoors = 0;
    for (const house of block.placedHouses!) {
      const doorKeys = new Set(house.doors.map((d) => d.edge.key));
      for (const e of house.wallEdges) {
        if (e.kind !== 'interior' || e.outerCx === null || e.outerCy === null) continue;
        const innerOk = !grid.isBlocked(grid.index(e.innerCx, e.innerCy));
        const outerOk = !grid.isBlocked(grid.index(e.outerCx, e.outerCy));
        // P1b: a SOLID furniture piece may legitimately block a room cell adjacent to a partition; that's an
        // orthogonal cell-block, not the edge-wall this test probes. Skip those — the edge-wall still stands,
        // we just can't assert the cell is walkable when furniture occupies it.
        if (!innerOk || !outerOk) continue;
        if (doorKeys.has(e.key)) {
          if (grid.canCross(e.innerCx, e.innerCy, e.outerCx, e.outerCy)) {
            openDoorways += 1; // open gap, or an interactive door that started open
          } else {
            // T135: a doorway that is NOT crossable must be a CLOSED interactive door (registered in
            // interiorDoors so the player can open it), never a dead wall they can't pass.
            const registered = block.interiorDoors!.some(
              (dr) => (dr.cx === e.innerCx && dr.cy === e.innerCy) || (dr.cx === e.outerCx && dr.cy === e.outerCy),
            );
            expect(registered).toBe(true);
            closedDoors += 1;
          }
        } else {
          expect(grid.canCross(e.innerCx, e.innerCy, e.outerCx, e.outerCy)).toBe(false); // wall: blocked
          walledPartitions += 1;
        }
      }
    }
    expect(walledPartitions).toBeGreaterThan(0); // real partitions exist
    expect(openDoorways).toBeGreaterThan(0); // most doorways stay open (flow preserved)
    expect(closedDoors).toBeGreaterThan(0); // at least the player-house captive door starts closed (tension)
  });

  it('T135: seals a lone CAPTIVE zombie in a single-door back room of the player house behind a CLOSED interactive door', () => {
    const { block } = buildCityDistrict();
    const grid = block.navGrid;
    const captive = block.captiveZombieCell;
    expect(captive).toBeTruthy(); // the player house authored a captive room
    const room = block.roomAt!(captive!.cx, captive!.cy)!;
    const playerRoom = block.roomAt!(block.playerCell.cx, block.playerCell.cy)!;
    expect(room.houseIndex).toBe(playerRoom.houseIndex); // captive sits in the PLAYER's house
    expect(room.roomId).not.toBe(playerRoom.roomId); // a DIFFERENT room than the player starts in
    // the captive room is a dead-end: exactly ONE door, which is CLOSED (not crossable) yet an interactive
    // interior door (registered in interiorDoors so the player can open it) — the zombie is contained until then.
    const house = block.placedHouses![room.houseIndex]!;
    const roomDoors = house.doors.filter((d) => d.fromRoom === room.roomId || d.toRoom === room.roomId);
    expect(roomDoors.length).toBe(1);
    const d = roomDoors[0]!;
    expect(grid.canCross(d.edge.innerCx, d.edge.innerCy, d.edge.outerCx!, d.edge.outerCy!)).toBe(false); // closed
    expect(block.interiorDoors!.some((x) => x.cx === d.cx && x.cy === d.cy)).toBe(true); // openable
  });

  it('a zombie in one room can only reach the adjacent room via the doorway, never through the wall', () => {
    const { block } = buildCityDistrict();
    const grid = block.navGrid;
    // find an interior partition (walled, non-door) with both room cells walkable, in a house that has an
    // interior door (so the rooms ARE connected — just not through the wall).
    let probe: { ax: number; ay: number; bx: number; by: number } | null = null;
    for (const house of block.placedHouses!) {
      const hasInteriorDoor = house.doors.some((d) => !d.exterior);
      if (!hasInteriorDoor) continue;
      const doorKeys = new Set(house.doors.map((d) => d.edge.key));
      for (const e of house.wallEdges) {
        if (e.kind !== 'interior' || e.outerCx === null || e.outerCy === null) continue;
        if (doorKeys.has(e.key)) continue;
        // P1b: both probe cells must be walkable (a solid-furniture cell isn't a valid flow-field target).
        if (grid.isBlocked(grid.index(e.innerCx, e.innerCy))) continue;
        if (grid.isBlocked(grid.index(e.outerCx, e.outerCy))) continue;
        probe = { ax: e.innerCx, ay: e.innerCy, bx: e.outerCx, by: e.outerCy };
        break;
      }
      if (probe) break;
    }
    expect(probe).not.toBeNull();
    const { ax, ay, bx, by } = probe!;
    // sight does not pass through the partition (zombie in room B can't see player in room A through the wall)
    const aC = block.cellCenter({ cx: ax, cy: ay });
    const bC = block.cellCenter({ cx: bx, cy: by });
    expect(hasLineOfSight(block, aC.x, aC.z, bC.x, bC.z)).toBe(false);
    // flow toward the player's cell (A): the neighbour B across the wall is still reachable (via the door) but
    // its cost-to-target is NOT the single adjacent step it would be without the wall — it detours to a door.
    const field = new FlowField(grid, grid.index(ax, ay), 'zombie-walk', grid.navRevision);
    expect(field.isReachable(grid.index(bx, by))).toBe(true);
    expect(field.distance[grid.index(bx, by)]!).toBeGreaterThan(grid.getCost(grid.index(bx, by)) * 1.5);
    // and B's flow vector must not point straight across the walled edge into A.
    const [dx, dz] = field.directionAt(grid.index(bx, by));
    const sx = Math.sign(Math.round(dx));
    const sy = Math.sign(Math.round(dz));
    if (sx === Math.sign(ax - bx) && sy === Math.sign(ay - by) && (sx === 0 || sy === 0)) {
      expect(grid.canStep(bx, by, sx, sy)).toBe(true); // if it points toward A it must be a crossable step
    }
  });

  it('emits suburban ground paint + decorative dressing for the renderer (T80 contract)', () => {
    const { block } = buildCityDistrict();
    expect(block.groundRects && block.groundRects.length).toBeGreaterThan(0);
    expect(block.groundRects!.some((r) => r.kind === 'asphalt')).toBe(true);
    expect(block.groundRects!.some((r) => r.kind === 'grass')).toBe(true);
    expect(block.props && block.props.length).toBeGreaterThan(0);
    expect(block.props!.some((p) => p.kind === 'fence')).toBe(true);
    expect(block.props!.some((p) => p.kind === 'car')).toBe(true);
  });
});
