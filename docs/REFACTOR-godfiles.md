# God-file decomposition plan — `blockScene.ts` + `GameViewport.tsx`

Goal: break the two hot files apart so multiple people can work disjoint pieces without
clobbering each other. Render-only refactor — **no sim / determinism (V26) impact**.

## Renderer: leave it alone
`src/render/engine/renderer.ts` (163L, `RendererHost`) + `webgpuBackend.ts` (110L) are already a
clean two-layer boundary (host = backend-agnostic lifecycle + device-loss recovery; backend = the
only `new WebGPURenderer()`). Each is unit-tested. The pain the user feels as "renderer" is
**`BlockScene`**, not these. Do not split them.

## The actual coupling
`blockScene.ts` (1689L, ~117 methods) mixes three concerns:
1. **Geometry/material utils** (`mat`/`geo`/`mergeBoxes`).
2. **Static construction** (ground, houses, openings, props, containers, player) — runs once.
3. **Per-frame systems** (breach, doors, lighting, flashlight, cutaway, vision-cull, player sync, combat).

The knot is **shared mutable state** populated by (2) and read every frame by (3):
`fadeSurfaces[]`, `sectionMeshes[]`, `doorLeaves[]`, the lights, `playerMesh`/`aoContact`,
`perceptionMemory/Reveal`, `mats[]/geos[]`.

**Fix:** builders are pure fns/classes that **return typed handle structs**; systems are classes
**constructed from those handles**. No system reaches back into `BlockScene`. The orchestrator is
the only thing holding both, wiring `builder.output → new System(output)`.

## Target layout

### `src/render/scene/build/` — static construction, returns handles
- `handles.ts` — move `FadeSurface` here + define `SectionMesh`, `DoorLeaf`, `HouseHandles`,
  `OpeningHandles`, `PlayerHandles`, `LightingHandles` (plain data, no methods → `exactOptional` clean:
  use explicit `| null`, never `?`).
- `sceneResources.ts` — `SceneResources` owns `mats[]`/`geos[]`; `mat`/`geo`/`mergeBoxes` + `materialCount`/`geometryCount`.
- `buildContext.ts` — `BuildContext { root: Scene; res: SceneResources; townScene: TestBlock; navCellSize }`.
  Each builder also takes its own resolved typed config (V4) + narrows the scene with `Pick<TestBlock, …>` like `containers.ts` already does.
- `houseStyle.ts` — `HouseStyleResolver`: deterministic per-building style + feature index (V26). ← `computeFeatureBuildingIndex`, `styleFor`.
- `groundBuilder.ts` ← `buildGround`, `buildGroundRects`.
- `houseBuilder.ts` ← `buildWallsAndRoof`, `upperWallOutwardNormal` (pure, export for test), `buildClapboard`, `buildRoofAssembly`, `buildPorch`, ivy, debris → `HouseHandles`.
- `openingsBuilder.ts` ← `buildDoorsAndWindows` → `OpeningHandles`.
- `propsBuilder.ts` ← `buildProps`.
- `containersBuilder.ts` ← `buildContainers`.
- `playerBuilder.ts` ← `buildPlayer`, `buildContactAo` → `PlayerHandles`.

### `src/render/scene/systems/` — per-frame, consumes handles
- `playerLocation.ts` — pure `buildingIndexAt`/`isInside` (shared by cutaway/lighting/contact-AO). ← `playerBuildingIndex`, `isPlayerInsideBuilding`.
- `breachSystem.ts` ← `syncBreach`, `isSectionHidden` (from `SectionMesh[]`).
- `doorSystem.ts` ← `syncDoors` (from `DoorLeaf[]`).
- `lightingSystem.ts` ← `syncLighting`; owns `interiorTransition`, `exposure`; `update(dt,runtime) → {sceneBrightness, exposure}`.
- `flashlightSystem.ts` ← `updateFlashlight`; consumes lighting's brightness.
- `cutawaySystem.ts` ← `syncCutaway` (from `FadeSurface[]`). **Highest-risk** (mutates `opacity`/`depthWrite`/`renderOrder`, keeps `visible=true` so faded walls still shadow — V60/V20).
- `visionCullSystem.ts` ← `buildVisionCull`; owns `perceptionMemory`/`perceptionReveal`.
- `playerSyncSystem.ts` ← the player block of `syncFrame` + rim-glow.

Combat feedback is already a system pair — keep `ingestCombatEvents`/`fireFeedback` as thin delegators.

### `BlockScene` → thin orchestrator (~200L)
Owns `scene`, `crowd`, `SceneResources`, `HouseStyleResolver`, the handles, the systems. Constructor
runs builders in order → captures handles → constructs systems from them. **Public surface unchanged**:
`scene`, `crowd`, `currentExposure`, `syncFrame(dt,camera,flags)`, `ingestCombatEvents`, `fireFeedback`,
`setAccessibility`, `accessibilityParams`, `rebindRuntime`, `dispose`, test getters `debugInfo`/`debugFadeOpacity`/`isSectionHidden`.
**Preserve ordering:** lighting → flashlight → cutaway; lighting returns brightness the flashlight consumes.

### `src/ui/` hooks (GameViewport, 644L → phase 3)
`useGameRuntime`, `useRendererHost`, `useEffectViews` (fragile: keep the static-structure exclusion
list + name-prefix matching + corpse-attached-after ordering), `useInput`, `useCameraController`,
`useEngineHandle`, `useRenderLoop` (last).

## Phased order (tree green after EVERY phase)
- **Phase 0 (solo, blocking):** `handles.ts` + `sceneResources.ts` + `buildContext.ts`; make `mat/geo/mergeBoxes` delegate. Mechanical, no behavior change.
- **Phase 1 (parallel):** 1a `houseStyle.ts` first → then independent: 1b `ground`/`props`/`containers`/`player`; 1c `houseBuilder`; 1d `openingsBuilder`. Preserve fade-surface push ORDER (test indices), transparent materials' `polygonOffset`/`renderOrder`, no core Line/Points materials.
- **Phase 2 (parallel, after 1):** 2a `playerLocation` first → then 2b `breach`/`door`/`visionCull`/`playerSync`; 2c `lighting`+`flashlight` (sequential pair); 2d `cutaway` (highest risk).
- **Phase 3 (last, mostly sequential):** GameViewport hooks — `useRendererHost`/`useGameRuntime` first, then split the rest.

Within phases 1 and 2 the lettered tasks are disjoint → multiple people. Phases stay ordered 0→1→2→3.

## Tests
New pure CPU tests: `houseStyle` (replay stability), `upperWallOutwardNormal`, `sceneResources`
(counts + dispose), each builder (counts/handles), `doorSystem`, `breachSystem`, `lightingSystem`
(monotonic interior transition + exposure lift), `cutawaySystem` (directional fade + depthWrite flip +
motion-reduction snap), `visionCullSystem` (reveal length == capacity, memory decay, LOS).
Keep `blockScene.test.ts` as the green-guard through phases 0–2 (do not weaken). GameViewport: tsc/lint + WebGPU smoke.

## Coordination note
A concurrent agent is already extracting `windows.ts` out of blockScene (overlaps Phase 1 openings).
Let it land + commit before executing decomposition phases, so the plan targets the settled structure.
