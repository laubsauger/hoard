// Breach visibility system: hides a destructible wall-section's meshes once its structural cell is breached
// (the render only REFLECTS the authoritative wall state, V12). Operates over the SectionMesh handles the house
// builder produced, keyed by structural cell. Extracted from BlockScene (docs/REFACTOR-godfiles.md).

import type { TestBlock } from '../../../game/scene';
import type { SectionMesh } from '../builders/handles';

export class BreachSystem {
  constructor(private readonly sectionMeshes: SectionMesh[]) {}

  /** Toggle each section's meshes to match the authoritative breach state of its structural cell. */
  sync(town: TestBlock): void {
    for (const s of this.sectionMeshes) {
      const breached = town.wall.isBreached(s.cell);
      for (const o of s.objects) o.visible = !breached;
    }
  }

  /** Test/diagnostics: whether every section mesh for a structural cell is currently hidden (breached). */
  isSectionHidden(structuralCell: number): boolean {
    const s = this.sectionMeshes.find((m) => m.cell === structuralCell);
    return s ? s.objects.every((o) => !o.visible) : false;
  }
}
