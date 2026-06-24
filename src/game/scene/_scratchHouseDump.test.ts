import { it } from 'vitest';
import { buildCityDistrict } from './cityDistrict';

it('DUMP player house layout', () => {
  const { block } = buildCityDistrict();
  const grid = block.navGrid;
  const pr = block.roomAt!(block.playerCell.cx, block.playerCell.cy)!;
  const house = block.placedHouses![pr.houseIndex]!;
  let minCx = 1e9, minCy = 1e9, maxCx = -1e9, maxCy = -1e9;
  for (const rc of house.rooms) {
    minCx = Math.min(minCx, rc.cx); minCy = Math.min(minCy, rc.cy);
    maxCx = Math.max(maxCx, rc.cx); maxCy = Math.max(maxCy, rc.cy);
  }
  const roomChar = (cx: number, cy: number): string => {
    const r = house.roomAt(cx, cy);
    if (!r) return ' ';
    return 'abcdefghij'[r.roomId] ?? '?';
  };
  const idoors = new Set(block.interiorDoors!.map((d) => `${d.cx},${d.cy},${d.edgeDir}`));
  // print a 2x-scaled grid: each cell is a glyph; between cells show wall (|/-) if edge walled.
  const lines: string[] = [];
  lines.push(`player house #${pr.houseIndex} footprint cx[${minCx}..${maxCx}] cy[${minCy}..${maxCy}]  player=(${block.playerCell.cx},${block.playerCell.cy}) captive=${block.captiveZombieCell ? `(${block.captiveZombieCell.cx},${block.captiveZombieCell.cy})` : 'none'}`);
  for (let cy = minCy; cy <= maxCy; cy++) {
    let row = '';
    for (let cx = minCx; cx <= maxCx; cx++) {
      let g = roomChar(cx, cy);
      if (block.playerCell.cx === cx && block.playerCell.cy === cy) g = '@';
      if (block.captiveZombieCell && block.captiveZombieCell.cx === cx && block.captiveZombieCell.cy === cy) g = 'Z';
      row += g;
      // east edge wall?
      if (cx < maxCx) row += grid.canCross(cx, cy, cx + 1, cy) ? ' ' : '|';
    }
    lines.push(row);
    if (cy < maxCy) {
      let sep = '';
      for (let cx = minCx; cx <= maxCx; cx++) {
        sep += grid.canCross(cx, cy, cx, cy + 1) ? ' ' : '-';
        if (cx < maxCx) sep += ' ';
      }
      lines.push(sep);
    }
  }
  // doors list
  lines.push('interiorDoors: ' + block.interiorDoors!.filter((d) => d.cx >= minCx && d.cx <= maxCx && d.cy >= minCy && d.cy <= maxCy).map((d) => `(${d.cx},${d.cy},${d.edgeDir})`).join(' '));
  lines.push('idoorsKeys none-needed');
  void idoors;
  // eslint-disable-next-line no-console
  console.log('\n' + lines.join('\n'));
});
