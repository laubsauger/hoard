# Procedural houses — ground-up redesign

Status: DESIGN (not yet built). This replaces the current per-cell-perimeter house gen entirely.

## Goal (user)
Real, believable, potentially fully-explorable houses — grounded in how real suburban / Project-Zomboid
houses look and feel. NOT decorative shells.
- One floor ⇒ a one-storey house + roof. Two floors ⇒ a real two-storey house with **stairs** you can climb;
  the **sim** supports the upper floor (nav, zombies, loot). **No decorative/fake second floors or second-floor
  windows.** (Decorative is OK for roofs/dormers only.)
- Rooms with **types** (kitchen / bedroom / bathroom / living / dining / hall / garage / closet / laundry),
  each with its own **furniture, loot, and textures** — like PZ room-definitions.
- Several **house kinds + layouts**, varied but believable.
- Grounded in **truth**: encode real floor-plan templates (suburban ranch/bungalow/two-storey, or PZ-map
  layouts) as data; add a layout grammar later.
- Kill the leftovers: the §G destructible "section" test-wall embedded in real houses, the "huge 2-storey
  open-ceiling" boxes, the weird doubled/clad walls.

## The PZ model we're grounding in
Project Zomboid buildings are tile grids stacked into **levels (floors)**; **rooms** are enclosed tile regions
tagged with a **room-definition name** (kitchen, bedroom, …) that drives which **furniture + items** spawn;
**stairs** connect levels; enclosed walls+roof+floor = "indoors". We mirror this: a house is **levels → rooms
(typed) → walls/openings → stairs → furniture → textures**, authored from templates, not per-cell noise.

## Data model (new)
```
HouseArchetype   // e.g. 'ranch-1', 'bungalow-1', 'colonial-2', 'garage-ranch-1'
  storeys: 1 | 2
  footprint: { w, d } in cells (with allowed jitter)
  levels: FloorPlan[]              // one per storey
FloorPlan
  rooms: Room[]                    // typed, non-overlapping, tiling the footprint
  stairsTo?: { up?: cell, down?: cell }   // stair cell linking this level to the next
Room
  type: RoomType                   // kitchen | bedroom | bathroom | living | dining | hall | garage | closet | laundry
  bounds: CellRect
  doors: Door[]                    // openings to adjacent rooms / outside
  windows: Window[]                // on exterior walls only, at believable sill/head heights
  floorMaterial / wallMaterial     // per room-type texture
  furniture: FurniturePlacement[]  // per room-type set (bed in bedroom, counters+fridge in kitchen, …)
```
Adjacency rules (believable): entry → hall/living; kitchen ↔ dining ↔ living; bathrooms off hall/bedrooms;
bedrooms clustered (upstairs in a 2-storey); garage off the side with an exterior + interior door; stairs in
the hall/living.

## Sim implications — the hard part
Today the sim is a **2D single-floor nav grid** (`NavGrid`) + a destructible structural wall (§G) + a flow
field. Real explorable multi-floor needs, in rough dependency order:
1. **Rooms as first-class regions**: a room map over the nav grid (cell → roomId → type) for loot/furniture/
   indoor-outdoor + AI ("zombie wanders its room"). Single-floor-compatible — do this FIRST.
2. **Furniture as nav + loot**: furniture footprints block nav (V19 steering already handles obstacles) and
   double as loot containers (extends the existing container system — cupboards already exist).
3. **Multi-floor (the big one)**: a nav grid PER LEVEL + **stair cells** that transition an agent between
   levels. Player/zombie position gains a `level`. Perception/sound/flow become per-level (sound bleeds via
   stairs/floors, attenuated). This is a deep change — phase it LAST, behind the single-floor work.
4. **Cutaway per level**: the render cutaway already fades the occupied building's roof/upper walls; extend to
   "show the level the player is on, ghost the others." Builds on the existing `CutawaySystem`.

## Render implications
Per-level: floor slab + room-partition walls (interior) + exterior walls with real window/door openings (the
single-mesh + punched-window work already landed) + per-room floor/wall textures + furniture meshes + stairs +
roof on the top level. The cladding-via-material + punched-window foundation stays; the LAYOUT source changes
from "perimeter cells" to "room partitions from the FloorPlan".

## Phased roadmap (each phase ships green + playable)
- **P0 — schema + ONE real 1-storey template.** Add the data model above + a single hand-authored ranch
  floor-plan (rooms from a real plan: living/kitchen/2 bed/bath/hall). Generate walls/doors/windows from the
  room partitions (interior walls + exterior with openings). Replace the current perimeter-only wall gen for
  that house. Remove the §G test-wall from authored houses (keep breach as a mechanic, not an embedded test
  wall). Single floor, no furniture yet. Sim: rooms-as-regions map. **Biggest single step; everything builds
  on it.**
- **P1 — room types + textures + furniture + loot.** Per-room floor/wall material; a furniture set per room
  type (bed/dresser, kitchen counters/fridge/sink, sofa/TV, toilet/sink/tub, …) as meshes + nav blockers +
  loot containers wired to the existing loot tables (room-type → loot table, like PZ room-defs).
- **P2 — variety.** 3–5 house archetypes/templates (ranch, bungalow, L-plan, garage-front) + light jitter, so
  a street reads as varied believable homes. Still single-floor (+ roof).
- **P3 — real two-storey.** Add a second LEVEL to the sim (per-level nav grid + stair transition), the upstairs
  floor-plan (bedrooms/bath), stairs in the hall, per-level cutaway, multi-level perception/sound. Player +
  zombies can climb. This is the deep sim change — do it only after P0–P2 are solid.

## Decisions for the user (sequencing)
- P0 is large but unavoidable (it replaces the wall-gen + adds room regions). Recommend doing P0 → P1 → P2 on
  the existing single-floor sim, then P3 (multi-floor) as a dedicated effort.
- Interim: the current 2-storey houses (decorative stacked windows) are wrong per the new direction. Until P3,
  generate **only one-storey houses + roofs** (no fake upper floor) so nothing is decorative-fake.

## Research to gather (ground in truth)
Real suburban floor plans (ranch/bungalow/two-storey) + PZ TileZed/BuildingEd room-def layouts → encode 3–5 as
templates. Room-def → loot mapping mirrors PZ's room-definition item spawns.

## P3 multi-floor model (chosen)
Level dimension via **per-level nav grids**: the scene carries `levels: NavGrid[]` (index 0 = ground/district,
1 = upstairs). Most of the world is level 0; level 1 is SPARSE — only the cells under a 2-storey house's upper
rooms exist (walkable), the rest blocked. An agent (player + zombie) gains a `level: number` (default 0).
**Stairs** are a vertical LINK: `(level 0, stairCell) ↔ (level 1, stairCell)` at the SAME world XZ — a portal
edge in the nav graph. Movement/flow-field/pathfinding traverse the link (climb); perception + sound are
per-level with attenuated bleed across a stair/floor link. Render stacks level-1 geometry at +storeyHeight Y at
the same XZ (looks like a real upstairs); the cutaway shows the player's CURRENT level (ghost levels above).
**Backward-compat is the green-keeper:** a 1-storey house / all outdoors has no level-1 cells, every agent stays
level 0, every system defaults to level 0 → byte-identical to today, so the existing suite stays green. Staged:
(P3a) per-level nav + stair-link API; (P3b) agent level + climb in movement/flow; (P3c) per-level perception+
sound; (P3d) render stacking + per-level cutaway + stairs mesh; (P3e) cityDistrict emits some colonial-2storey.

## House polish punch-list (user feedback, do with P3d/e + cleanup)
1. **Exterior wall = thin edge-wall, not a 2m ring.** cityDistrict's (W+2)×(D+2) blocked ring makes the wall a
   full nav cell (~2m) thick → ~50% of a small house is non-nav wall + a big floor↔outside gap. Make exterior
   walls thin edge-walls on the room perimeter (reuse edge-wall nav); rooms reach the footprint boundary; no ring.
2. **Fewer/bigger rooms.** Houses are overcrowded with walls/rooms for their size. Reduce interior partitions —
   bigger rooms in the templates (fewer 1-cell rooms), less wall noise.
3. **Interior walls thinner.** Reduce interior partition wall thickness.
4. **Weird/nonsensical walls — reduce noise.** Audit for spurious wall segments; clean up.
5. **Windows: kill z-fighting + thinner.** Pane/void/frame still z-fight (paneInset insufficient) + span full wall
   depth = too thick. Thin the glass + frame; fix the coincident-face z-fight properly.
6. **Roof texture.** Roofs are flat single-color + lame — add shingle/material detail (procedural banding, no files).
7. **Remove backward-compat after P3 lands.** Drop the single-level legacy paths/gating once multi-floor is real —
   don't carry legacy. (Do LAST, after P3d/e green.)
8. **Collapsed-roof sag clamp.** `style.collapsed` tilts `buildRoofAssembly`'s roof (rotation.z) too far on one
   side — the low edge dips BELOW the wall top so the walls poke through above the roof. Clamp the sag so the
   roof's lowest point stays at/above the wall plate, or reduce the collapse tilt + raise the ridge to compensate.
