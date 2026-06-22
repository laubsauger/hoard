# SPEC — Ho(a)rdish by Nature (Isometric Zombie Survival)

Working title: **Ho(a)rdish by Nature** (hoard × horde). Repo dir `hordish-by-nature`.

Source: `docs/isometric_zombie_survival_handout.pdf` (Concept blueprint v0.1, 22 Jun 2026). Caveman encoding. Identifiers/paths/numbers verbatim.

Label legend (from handout): `LOCKED`=fixed constraint. `DEFAULT`=impl unless prototype beats it. `GATE`=measurable target, validate on real hw. `OPEN`=product decision still needed.

---

## §G — Goal

Cinematic isometric zombie-survival game. Authored city sits above hidden destructible structural grid. Player + horde permanently reshape routes, defenses, visibility, acoustics, shelter. Every breach/barricade/collapse/obstruction changes sight, sound, navigation, safety, horde behavior. Desktop-browser-first, WebGPU-first. Complete indie game + explicit blueprint for coding-agent build. **Central promise (preserve above all): physically altering city must meaningfully change survival + horde behavior.**

---

## §C — Constraints

LOCKED stack:
- Three.js, React, TypeScript, Zustand, Vite.
- WebGPU-first render via Three.js `WebGPURenderer`. Reduced compat path only if it does not distort core arch. Desktop-high = reference experience.
- Web Workers. SharedArrayBuffer where deployment isolation (cross-origin isolated) permits. IndexedDB for structured local persistence. WASM only for measured bottlenecks.
- React = UI + app shell. Direct Three.js engine for world (NOT R3F for world; R3F only limited high-level composition if profiling supports).
- Zustand: selectors, shallow-compare where justified, `subscribeWithSelector`, domain slices.
- Cinematic near-isometric diorama presentation.
- Graphic survival realism: selective strong outlines, explicit gore, individual anatomical damage.
- Authored visible continuous geometry+materials; hidden sparse structural grid inside destructible modules (player sees no cubes unless tool exposes).
- Large horde via tiered simulation + rendering.
- Multiple zombie types, individual hit reactions, dismemberment.

Recommended DEFAULTS (handout, awaiting explicit confirm — treat as default impl):
- Single-player initial.
- Hybrid sandbox + medium-term objective.
- Mostly grounded archetypes, few exceptional behaviors.
- Near-orthographic camera, 90° rotation steps.
- Behavior-driven shelter pressure (NO scripted nightly wave).
- Contextual crafting + modification of existing structures before freeform construction.
- Persistence = immutable base packages + compact deltas.

OPEN decisions (do NOT hardcode; route through config, flag `?`):
- Campaign objective + ending structure + sandbox role.
- Death/save model (reload vs permadeath vs run; do modified worlds survive death).
- Min desktop GPU + official WebGL/compat fallback policy.
- Max launch scope of structural collapse/fire/freeform obstruction.
- Camera rotation+zoom limits.
- Human NPC depth (companions/communities).
- Mobile release commitment.

NON-GOALS at launch (unless separately approved):
- Authoritative multiplayer / persistent online world.
- Every building fully collapsible at arbitrary granularity.
- Terrain excavation across whole city.
- Full rigid-body persistence for every corpse/fragment.
- Equal desktop+mobile horde capacity.
- Unbounded procedural city replacing authored districts.
- Colony-management-grade companion community sim.
- Photoreal close-up fidelity for every crowd member.
- Permanently voxel-looking world. Project Zomboid clone. Conventional scripted wave-defense. Physics sandbox keeping every prop/body a full rigid body forever. React component tree representing simulated world.

Decision rule on conflict: feature vs (readability | systemic consequence | stable perf | production capacity) → preserve central promise (§G) first.

---

## §I — External surfaces

### Project layout (`src/`) — LOCKED structure
```
app/          React shell, routing, lifecycle, error handling
ui/           HUD, panels, menus, accessibility, design system
stores/       Zustand stores, slices, selectors, persistence adapters
game/
  core/         clock, scheduler, events, commands, IDs
  simulation/   entity data + system execution
  world/        districts, sectors, chunks, portals, mutations
  zombie/       population, behavior, tiers, archetypes
  combat/       weapons, projectiles, damage, anatomy
  destruction/  structural modules, fracture, fire, support
  navigation/   graphs, navmesh, flow fields, steering
  inventory/    containers, items, crafting, equipment
  persistence/  snapshots, journals, migrations
render/
  engine/       Three.js lifecycle + frame orchestration
  crowd/        GPU animation, instances, LOD, culling
  world/        chunk render proxies + cutaways
  materials/    approved material families + nodes
  lighting/     sun, local lights, shadows, probes
  effects/      weather, gore, post-processing
workers/      nav, world, population, serialization workers
assets/       manifests, registries, loaders, validators
config/       typed values + quality profiles
diagnostics/  profilers, overlays, logs, benchmark tools
tests/        unit, integration, replay, performance scenarios
tools/        import, baking, compression, content validation
```

### Zustand stores (recommended)
session | UI+modal | player-view | inventory-view | crafting-view | map-view | settings | input | diagnostics.

NOT a store (live outside Zustand): zombie positions, projectile transforms, animation clocks, chunk entity arrays, collision contacts, structural cell arrays.

### Config domains (typed, centralized)
`game world streaming time player survival items inventory crafting structures destruction fire zombies perception hordes navigation collision combat weapons camera rendering lighting shadows materials postFX weather audio UI input accessibility saving debug`

### Persistence (IndexedDB)
Base world packages immutable, stored separate from compact modification deltas. Save records: doors, breaches, barricades, moved persistent objects, searched containers, local population changes, corpses, fires, utilities, dropped items, mission state. NOT untouched base assets. Schema versions + explicit migrations from first public build. Partition by district/sector. Serialize in worker, async write. Periodic checkpoints + short mutation journal for crash recovery. Validate asset+world-version compat before load.

### Command/event contract
UI issues commands (equip, craft, move item, confirm action, change setting, select target) → engine validates → publishes view-state result. Commands express intent, can fail w/ explicit reason. Events = facts already occurred, feed render/audio/UI/analytics/persistence. NO global untyped-string event bus. Bounded queues + pooled records for high-freq events. Separate ephemeral visual events from persistent world mutations. Discriminated command/event types, exhaustive handling.

### Debug views (required)
chunk/sector/district/nav-tile boundaries; structural occupancy cells + support links + dirty regions; zombie tier/render-tier/state/target/update-freq; spatial-hash occupancy + collision candidate counts; flow-field vectors + path corridors + portals + blocked links; draw calls/triangles/instances/anim-groups/lights/shadows/GPU-mem/texture residency; worker queue depth + sim timing + frame timing + GC + save ops. Debug controls: freeze tiers, force LODs, show spatial grids, visualize flow fields, inspect dirty nav tiles.

### Core data structs (from handout — shape contracts)
- `StructuralModule`: stable id; local transform+bounds; authored intact mesh refs; sparse occupancy cells; material+strength per occupied cell; support graph+anchor points; openings/doors/windows/service routes; fracture families+breach thresholds; collision proxy state; nav obstruction state; acoustic+visibility state; persistent modification delta.
- `ZombieArchetype`: body+skeleton family; locomotion profile; perception profile; attack profile; anatomy+sever rules; durability+armor profile; animation set; clothing+material family; audio set; special behavior modifiers; allowed sim+render tiers. Composed from data, NOT hardcoded classes. Examples: shamblers, fresh infected, crawlers, armored emergency personnel, decomposed fragile, agitated runners, burned, partially-dismembered.
- High-count zombie data groups (typed arrays / SoA): identity+archetype; position/heading/velocity; current state+timers; health+anatomical flags; target+stimulus refs; chunk+spatial-cell+nav-group; sim tier+render tier; animation state+phase.
- Low-count side data: unique equipment; active wounds; named quest state; detailed recent-event history.
- Ownership-named types: `SimulationZombie`, `ZombieRenderProxy`, `ZombieViewSnapshot` (not one overloaded `Zombie`).

### Spatial hierarchy (DEFAULT scales, config-owned, not hardcoded truths)
| Layer | Scale | Responsibility |
|---|---|---|
| District | ~512 m² | long-range pop, objectives, weather, resource economy, save partition |
| Streaming sector | ~128 m² | asset manifest, activation priority, abstract sim boundary |
| Render chunk | ~32 m² | static batches, visibility, lights, decals, scene attach |
| Navigation tile | ~16 m² | local path data, dirty-region rebuild |
| Structural module | object-local sparse | destruction cells: walls/floors/doors/supports/selected props |

### Reference notes (Appendix A): R4 WebGPURenderer, R5 InstancedMesh, R6 BatchedMesh, R7 GLTF/KTX2Loader, R8 Zustand slices/subscribeWithSelector, R9 Recast tiled navmesh, R10 DetourCrowd, R11 flow-field tiles, R12 Web Workers, R13 SharedArrayBuffer, R14 IndexedDB, R15 GPU adapter limits, R16 WebGPU spec, R17 KTX2/Basis.

---

## §V — Invariants

Architecture-boundary + non-negotiable rules. Numbered, monotonic.

- **V1** React/Zustand NEVER authoritative for per-frame world state. React owns shell/panels/HUD/menus/accessibility/loading+error boundaries only. Must NOT own per-frame entities, projectile state, crowd movement, animation time.
- **V2** NO one Three.js object / animation mixer / physics body / path search / React component per zombie by default.
- **V3** Simulation records NOT coupled to visual objects. Zombie = compact sim data first; Three.js/skinned-mesh/physics-body/React-component = optional representation only.
- **V4** NO magic numbers outside typed config. Every value: unit, domain owner, default, valid range, quality-tier behavior. Derived values computed from smaller meaningful sources. Content/tuning data separated from engine invariants. Production builds REJECT invalid content (no silent invented fallbacks).
- **V5** NO full-region rebuild for local destruction. Small structural edit must NOT trigger full district remesh or full nav rebuild. Mark only affected nav tiles + cost cells dirty.
- **V6** NEVER merge navigation, collision, visual mesh, interaction geometry into one representation. Separate visual mesh / collision proxy / nav data / interaction targets / destruction structure. Collision layers explicit: movement, projectile, attack, interaction, sight, audio.
- **V7** NO generated asset accepted without validation + budgets. Image-to-3D = source material, not shippable runtime asset; every model passes normalization→validation→optimization→style control. Failed asset → clear placeholder + report, never silent missing collider.
- **V8** NO new high-cost effect without quality-tier policy + benchmark scene.
- **V9** NO untouched base world data persisted in every save (base packages separate from deltas).
- **V10** NO horde-count claim without reproducible benchmark proving it. Horde counts = benchmark gates, not marketing. Each target specifies hardware, resolution, camera, effects, active systems, frame-time percentile.
- **V11** Zustand: every component subscribes smallest practical selector; NEVER call store hook without selector in production UI; prefer primitive selectors, shallow-compare only for small tuples/objects when appropriate; `subscribeWithSelector` for engine→store + non-React subs; persistence only on explicit settings/session slices, not transient engine state; throttle/event-gate high-freq UI snapshots (health interp, cursor targeting); keep actions stable, no rebuilding command objects in render paths.
- **V12** Authoritative sim runs fixed tick independent of render rate. Render interpolates between stable snapshots. Subsystems may use lower update freq via scheduler, but order of authoritative changes stays explicit + testable.
- **V13** Tier promotion/demotion preserves identity, health, anatomy, equipment, behavior state. Targeted distant zombie can be promoted before final hit response resolves. Tier assignment depends on distance, visibility, threat, camera importance, target status, recent damage, current attack, available perf budget.
- **V14** Zombies do NOT receive omniscient player coords. Perception stimulus-driven only: sound, sight, light, movement, nearby agitation, fire, (optional scent-like residual). Horde has group intent/density/momentum/attraction but is NOT one inseparable entity.
- **V15** NO one A* path per zombie. Large groups share target fields + corridor intent (flow/cost fields). Individual precision (tiled navmesh) only near complex traversal or direct interaction.
- **V16** Combat hit pipeline: query chunk-local spatial accel → gather candidates from intersected cells/bounds only → order by projectile travel + filter by tier hit geometry → promote selected target if detailed anatomy/anim needed → damage resolves vs named anatomical region + armor + penetration + posture → authoritative entity records health/severed/locomotion/death → render gets compact event for reaction/particles/wounds/detached parts. Player attack damage only via timed attack volumes tied to animation windows (never from mere navigation overlap).
- **V17** Dismemberment = modular anatomical segmentation + wound-cap geometry, NOT runtime mesh cutting for ordinary combat. Each detachable region: bone ownership, render ownership, sever threshold, collision rules, detached-part asset, behavior consequence. Missing limbs change attacks/locomotion/balance/crawling/reach/threat. Detached limbs pooled → cheap settled props after short active window. Head destruction fatal unless archetype overrides.
- **V18** Persistent rubble/debris = compact state, not thousands of active rigid bodies. Debris may start physics → settle to cheap static/instanced. Same breach state feeds render, collision, pathing, light, sound, fire, save, AI.
- **V19** Crowd: lower tiers may overlap slightly, use density pressure, resolve separation gradually; close bodies get stronger correction. Doorways/narrow routes support queueing/climbing/pushing/grabbing/compression/structural pressure without unique collision-free route per agent.
- **V20** Visibility: hide/fade roofs + upper walls via room/portal/camera-occlusion logic; preserve enough wall base+structure to read enclosure+breach state; interior darkness + line-of-sight are gameplay systems not just post-fx; do NOT reveal all interiors merely because camera is above. Clear visual language for known / currently-visible / heard / remembered threats.
- **V21** Camera: near-orthographic (not perfect ortho), ~35–45° downward pitch, diagonal yaw, limited tactical zoom (closer indoors, pull back for horde), 90° rotation steps default. Stable combat framing; no auto cinematic movement changing aiming geometry in ordinary play.
- **V22** Scaling order on GPU pressure (strict): (1) internal res + expensive postFX, (2) shadow distance/res + secondary casters, (3) crowd anim fidelity + hero promotion budget, (4) LOD aggressiveness + texture residency, (5) debris/particles/persistent corpses/dynamic local lights, (6) visible horde density LAST. **NEVER reduce authoritative combat correctness to hide a render problem.** Dynamic resolution engages before failure, before dropping simulation correctness.
- **V23** Failure behavior: worker failure degrades/restarts subsystem without corrupting authoritative state; save writes atomic at record level, retain previous valid checkpoint; WebGPU device loss → controlled recovery or session-safe shutdown; perf overload lowers quality by documented priorities (V22), never unpredictable drops.
- **V24** Resource lifecycle: every streamed geometry/texture/material/render-target/buffer/effect has explicit ownership + disposal. Memory growth + resource leaks = release-blocking defects.
- **V25** Quality tier selected from measured startup tests + GPU adapter limits, not browser name. Store user override but protect against settings exceeding safe resource limits. Tiers: Desktop-high (reference), Desktop-medium, Desktop-compat, Mobile-WebGPU. Gameplay systems remain consistent across tiers where possible; mobile = capability-scaled same game, not visual parity, stays optional until desktop vertical slice proves arch.
- **V26** Determinism: recorded command sequences produce expected authoritative outcomes (replay test layer). Avoid raw object refs across worker/persistence boundaries — use explicit IDs (entities, chunks, assets, modules, stimuli, commands). Distinguish units in names/types: world-meters, grid-cells, pixels, seconds, ticks, degrees, radians.
- **V27** Definition-of-done per system (all required): Function (player-visible behavior matches written rules, explicit failure states) · Architecture (ownership+data-flow respect boundaries) · Performance (representative benchmark within budget) · Configuration (centralized/typed/documented/validated) · Persistence (survives save/reload/migration/partial failure) · Diagnostics (debug view + timing exist) · Testing (unit+integration incl edge cases + system interactions) · Accessibility (relevant settings + alternative feedback).
- **V28** Audio is simulation input + aesthetic. Heard event also produces stimulus (intensity, frequency character, duration, source type, obstruction, propagation history). Coarse sector graph for long-range spread; doors/windows/breaches/floors/materials = attenuation links; expensive ray/portal refine only active area; major event = persistent disturbance influencing migration after sample ends. Do NOT play per-member vocalization for large horde — layered group beds + selected foreground voices.
- **V29** Accessibility (must support): full input remap + separate sensitivity; outline strength / target highlight / gore intensity / camera shake / flashes / motion-reduction settings; color-independent interaction+damage indicators; scalable UI + high-contrast text; optional pause/slowdown for inventory+complex contextual actions (single-player); audio-cue subtitles / visual indicators for alarms, breaking glass, directional threats.
- **V30** Scope guardrails (launch destruction): destructible doors, windows, selected walls, selected floors, barricades, furniture obstacles, local fire. Full multi-building collapse / terrain excavation / arbitrary civil-engineering construction = later milestones. Irregular breach holes must visually hide structural cell shape.
- **V31** Survival systems = slow pressure, not constant meter babysitting. Hunger/thirst, fatigue/sleep (quality depends on security/pain/noise/temp), bleeding/pain (persist, readable severity), infection risk (consistent rules, communicated via symptoms), encumbrance (weight+container capacity+quick-access cost), stress/panic (affect control + awareness, no agency removal). Progression increases competence/options/reliability, NOT superhuman damage. Tension rule: every major system feeds "how safe is this place now, and what did the player do to change that?"

---

## §V perf gates (GATE — provisional desktop reference, revise after prototypes; cite V10)

| Metric | Normal target | Extreme benchmark |
|---|---|---|
| Frame rate | 60 FPS @1440p reference dedicated GPU | ≥45 FPS in max-horde stress scene |
| Visible zombies | 300–800 / scene | 2,000 individually addressable low-tier (stretch beyond) |
| Detailed hero zombies | 20–40 | up to 80 constrained |
| Active individual sim | 500–1,500 | up to 5,000 tiered in loaded sectors |
| Abstract world pop | tens of thousands | limited by save+district design |
| Draw calls | budgeted by scene/material family | stable as crowd rises (batching) |
| Main-thread CPU | prefer <5 ms avg | no sustained long tasks disrupting input/UI |
| GPU frame | prefer <12 ms at target quality | dyn-res + effect scaling before failure |

Profiling: record median/95th/99th frame times; separate main-thread/worker/GPU/streaming/GC/save costs; automated captures in CI where practical.

Benchmark scenes: Crowd avenue · Breach cascade · Dense interior · Streaming sprint · Corpse accumulation · Mobile capability.

---

## §T — Tasks

Ordered + **parallel-structured**. Status: `.`=todo `~`=wip `x`=done. Milestone gates from handout §22. **GATE 0: do NOT build broad content until crowd+destruction+streaming+state-boundaries prove plausible perf+maintainability.**

### Parallelization protocol (V1, V3, V6, V12 enforce this)

**Lane** = disjoint dir-subtree ownership. Two agents in same wave take two different lanes → never write same file. **Wave** = batch of tasks runnable concurrently across lanes. **Cross-lane talk only via frozen contracts** (typed commands, discriminated events, `*ViewSnapshot`, SoA buffer layout, worker message schema, ID schemes). Contracts live in `game/core/` + `config/`, frozen in Wave 0, changed only by coordinated edit (not mid-wave).

Lane ownership (no overlap):
| Lane | Owns (writes only here) |
|---|---|
| **F** Foundation | `game/core/`, `config/` (W0 only — then frozen, additive per-domain files) |
| **S** Sim+State authority | `game/{simulation,zombie,combat,destruction,navigation,inventory,crafting,persistence}/`, `workers/` |
| **R** Render | `render/*` |
| **U** UI/React | `app/`, `ui/`, `stores/` |
| **A** Assets/Tools | `tools/`, `assets/` (independent — runs any wave) |
| **X** Cross-cut | `diagnostics/`, `tests/` (each task adds its OWN files, namespaced per system → additive, collision-free) |

Rules: (1) shared dirs (`config/`, `diagnostics/`, `tests/`) only get NEW files per domain/system, never concurrent edits to one file. (2) a lane reads other lanes only through frozen contracts, never imports their internals. (3) within a wave, no task depends on another task in a different lane of the same wave. (4) `deps` lists only cross-wave prerequisites.

### Wave 0 — Foundation (SERIAL, 1 agent, blocks all parallel work)

| id | st | lane | task | deps | cites |
|---|---|---|---|---|---|
| T1 | x | F | Scaffold Vite+TS+React+Zustand+Three.js(WebGPURenderer); folder layout per §I; strict TS; lint; vitest | — | C, I.layout |
| T2 | x | F | `config/` typed system: every value w/ unit+owner+default+range+tier; loader rejects invalid content; quality-profile resolver; one file per config domain | T1 | V4, V25, I.config |
| T3 | x | F | `game/core/`: fixed-tick clock + scheduler (freq buckets: every-tick/2-4/5-15/per-sec-or-event/on-demand); explicit ID minting; bounded pooled event queues | T1 | V12, V26, I.cmd |
| T42 | x | F | **FREEZE CONTRACTS**: discriminated command+event types (exhaustive); `*ViewSnapshot` shapes; SoA buffer layout + field offsets; worker message schema; ID schemes. Published from `game/core/`; downstream lanes code against these | T3 | V1, V3, V12, V26, I.cmd, I.structs |

### Wave 1 — Spikes (PARALLEL: lanes S / R / U / A run concurrently)

| id | st | lane | task | deps | cites |
|---|---|---|---|---|---|
| T8 | x | S | data-oriented SoA entity store (typed arrays) per frozen layout — pos/heading/vel/state/health/anatomical-flags/target/stimulus/chunk/cell/nav-group/sim-tier/render-tier/anim; ownership-named types | T42 | V3, V26, I.structs |
| T10 | x | S | tiered population (Tier0 hero/1 active-crowd/2 visible-horde/3 abstract) + promotion/demotion preserving identity+state | T8 | V13, zombies-config |
| T11 | x | S | navigation: tiled navmesh + ≥1 shared flow-field in test block; region/portal graph; local steering grid; cache flow by target+profile+nav-revision | T2, T3 | V15, V5, R9, R10, R11 |
| T12 | x | S | collision broad-phase: chunk-local uniform grid/spatial hash; explicit layers; circles+vertical bounds default, promote to capsule/anatomical on demand | T2, T3 | V6, V19, collision-config |
| T13 | x | S | sparse `StructuralModule`: occupancy cells, material+strength, support graph, fracture families/breach thresholds; irregular breach → local collision+pathing update (no full rebuild); breach hides cell shape | T2 | V5, V18, V30, I.structs |
| T14 | x | S | chunk streaming lifecycle (unloaded→abstract→meta→CPU-load→sim-active→visual→high-detail→cooling→persisted+evicted) + asset disposal + basic save delta to IndexedDB | T2, T3 | V9, V24, I.persist, R14 |
| T5 | x | R | `render/engine/`: WebGPURenderer lifecycle, frame orchestration, adapter-limit capability detect, device-loss recovery, resource ownership+disposal registry, diagnostics counters | T1, T2 | V23, V24, V25, R4, R15 |
| T7 | x | R | camera rig: near-ortho ~35–45° pitch, diagonal yaw, 90° rotation steps, limited zoom, stable combat framing | T5 | V21, camera-config |
| T9 | x | R | GPU-instanced animated crowd, ≥several hundred varied zombies (instances + per-instance variation buffers, shared mesh family); reads SoA via frozen layout | T5, T42 | V2, V10, R5, R6 |
| T4 | x | U | `stores/`: session/UI/player-view/inventory-view/crafting-view/map-view/settings/input/diagnostics slices; subscribeWithSelector; selector-only; persist settings+session only | T3 | V1, V11, I.stores |
| T6 | x | U | `app/` React shell + error/loading boundaries; HUD that NEVER subscribes to per-frame world state (selector-scoped proof) | T4 | V1, V11 |
| T34 | x | A | Asset pipeline (`tools/`): import+provenance → clean → retopo/decimate → skeleton+weights → anatomical region split+wound caps → UV+bake → art-direction pass → LOD+shadow+collision+impostor gen → KTX2/GLB compress+metadata → automated validation | — | V7, R7, R17 |

### GATE 0 — integrating proof (after Wave 1, blocks Wave 2; 1 coordinator agent)

| id | st | lane | task | deps | cites |
|---|---|---|---|---|---|
| T41 | x | INT | **FIRST PRODUCTION ACTION = GATE 0 artifact**: ugly-but-measurable test block stitching Wave-1 outputs via frozen contracts — destructible wall + multi-room interior + ≥500 animated zombies + shared horde nav + firearm w/ anatomical hits + save/reload + React HUD never subscribing to per-frame world state. **Gate decision**: crowd+destruction+streaming+state boundaries demonstrate plausible perf+maintainability before broad content. Lane agents do NOT edit T41 glue concurrently | T8,T9,T11,T13,T6 + min T16,T33 | V1, V2, V10, V27, milestone-0 |

T16+T33 minimal subsets are pulled forward into T41 (firearm anatomical hit path + save delta) — their full versions land in Wave 2/3. This is the only forward-pull; avoids a separate GATE-0 review task.

### Wave 2 — Systems (PARALLEL: lanes S / R / U)

| id | st | lane | task | deps | cites |
|---|---|---|---|---|---|
| T16 | x | S | combat hit pipeline: spatial query→candidate gather→order/filter by tier hit-volume→promote→resolve vs anatomical region+armor+penetration+posture→record authoritative→emit compact render event; player attack via timed anim-window volumes | T8, T11, T12, T13 | V16, combat-config |
| T17 | x | S | anatomy + dismemberment: modular segments+wound caps, bone+render ownership, sever thresholds, pooled detached parts→settled props, locomotion/threat consequences, head-kill default | T16 | V17, anatomy-config |
| T18 | x | S | weapons: melee sweep + firearm (sound, ammo, penetration, line-of-fire); hit-volume tiers (hero full / active-crowd L/R limbs / distant head-sphere+capsule) | T16 | V16, weapons-config |
| T20 | x | S | zombie behavior: stimulus-driven perception (no omniscient coords); compact FSM/utility at tier freq; horde group intent/density/momentum/attraction; group action weakens barricades/doors under pressure | T8, T11 | V14, V19, perception-config |
| T21 | x | S | ≥3 data-composed archetypes (shambler/runner/crawler) via `ZombieArchetype`; anatomical damage variation | T17, T20 | V7, zombies-config |
| T22 | x | S | survival: hunger/thirst, fatigue/sleep, bleeding/pain, infection risk, encumbrance, stress/panic — slow-pressure depth; competence-based progression | T8 | V31, survival-config |
| T23 | x | S | inventory: container-based (clothing/backpack/cupboard/trunk/shelf/crate/floor-pile); weight+capacity; quick-access timing cost; fast transfer+category rules; command-validated transfers | T3 | V1, inventory-config |
| T24 | x | S | crafting: contextual common-sense (tool+material+skill+target→valid actions); recipes only for non-obvious/specialist/chemistry/medicine/fabrication; reuse destruction material+tool logic for repairs | T23, T25 | crafting-config |
| T25 | x | S | modification classes: surface-damage, functional-mod (lock/board/reinforce/weld/brace), breach-creation, obstruction (furniture/debris/vehicle), support-damage (collapse/route-delete), fire+heat, utility work (power/circuits/water/alarms) — each feeds nav/sight/sound/path-cost | T13 | V18, V30, destruction-config |
| T26 | x | S | fire system: ignite wood/fuel/fabric/vegetation; DoT/light/smoke/sound/spread/evacuation; compact persistent state | T25 | V18, fire-config |
| T27 | x | S | audio sim: stimulus from heard events (intensity/freq/duration/source/obstruction/propagation); coarse sector sound graph; attenuation links; persistent disturbance→migration; group vocalization beds+foreground voices; alarm/glass/gunfire/footstep/weather classes | T3, T11 | V28, audio-config |
| T30 | x | R | crowd render paths: hero skinned / instanced animated / horde-LOD / impostor-cluster; material families+atlases; variation via body/head/hair/clothing/mask/palette/dirt/blood/posture/scale/anim-phase; no per-zombie shader | T9 | V2, V8, R5, R6 |
| T19 | x | R | gore render: directional blood spray/mist, readable stains+sever silhouettes, pooled simplified distant gore, hero close wet response; gore-intensity accessibility; consumes combat events via contract | T9, T42 | V8, V29, effects-config |
| T28 | x | R | visibility: roof/upper-wall fade via room/portal/camera-occlusion; interior darkness + LOS gameplay; threat-state visual language (known/visible/heard/remembered) | T5, T42 | V20, lighting-config |
| T29 | x | R | lighting: directional sun/moon w/ budgeted shadow cascades; baked indirect static; dynamic local lights (flashlight/fire/alarm/vehicle); contact+ambient occlusion near player; fog/weather/interior exposure; shadow priority by screen-contribution/tier/distance/threat | T5 | V8, shadows-config |
| T31 | x | R | post-processing: stable-outline AA, authored color grading (district/time/weather/danger), selective bloom, grounding AO, depth+fog horde separation, dynamic resolution, sparse accessible damage feedback | T5 | V8, V22, postFX-config |
| T32 | x | R | outline hierarchy + small-character readability: player strongest silhouette, medium nearby threats, few/no distant per-body outlines (dark mass), restrained architecture edges; evaluate at gameplay pixel height | T5, T30 | V20, materials-config |
| T35 | x | X | diagnostics overlays + debug views (full §I list) + freeze-tier/force-LOD/show-grid/flow-field/dirty-nav controls; reads counters via contract | T4, T5 | V27, I.debug |

### Wave 3 — Integration + hardening (PARALLEL where lane-disjoint; T38/T40 = integration, single coordinated agent)

| id | st | lane | task | deps | cites |
|---|---|---|---|---|---|
| T33 | x | S | persistence full: base packages vs deltas, schema versions+migrations, district/sector partition, worker serialize, async IndexedDB, checkpoints+mutation journal, version-compat validation | T13, T14, T25 | V9, V23, V26, I.persist, R12, R14 |
| T37 | x | R | quality tiers + scaling-order impl (Desktop high/med/compat, Mobile-WebGPU); capability detect; user override w/ safe-limit guard | T5, T30 | V22, V25 |
| T36 | . | X | benchmark suite: Crowd avenue, Breach cascade, Dense interior, Streaming sprint, Corpse accumulation, Mobile capability; median/95/99 frame times; CI captures | T9, T16, T33 | V10, §V-gates |
| T39 | . | X | test layers: unit (damage/transfer/strength/tier/config), deterministic replay, integration (breach→nav+vis+audio+render+persist consistency), content validation, visual regression, perf, save-compat | T16, T33 | V26, V27 |
| T38 | . | INT | M1 vertical slice: one city block — street + multi-room building, cutaway camera, loot, shelter actions, melee+firearm, sound attraction, save/load, day/night+weather, one full modify-defend-escape loop | W2 done | V27, milestone-1 |
| T40 | . | INT | M2 vertical slice: representative district final-quality art, medium-term objective + decisive horde event shaped by player mods, production pipeline, benchmark suite, accessibility pass, stable save migration, reference desktop quality on named hw | T38, T34, T36, T37, T39 | milestone-2, V27 |

**Suggested 2-agent assignment** (parallel-safe by lane):
- **W0** — 1 agent: T1→T2→T3→T42 (contracts must be serial + frozen).
- **W1** — α=lane S (T8,T10,T11,T12,T13,T14); β=lane R (T5,T7,T9)+lane U (T4,T6). Lane A (T34) = optional 3rd agent, fully independent.
- **GATE 0** — 1 coordinator: T41 (stitch only, no concurrent lane edits to glue).
- **W2** — α=lane S systems (T16→T17/T18, T20→T21, T22,T23→T24, T25→T26, T27); β=lane R systems (T30,T19,T28,T29,T31,T32)+X (T35).
- **W3** — α=S (T33), β=R (T37)+X (T36,T39); then 1 coordinator for INT (T38→T40).

Five decisions to lock before vertical-slice brief finalized (OPEN, §C): campaign+ending+sandbox role; death+save model (do modified worlds survive death); min desktop GPU + WebGPU/compat policy; max launch scope collapse/fire/obstruction; camera rotation+zoom+control model.

---

## §B — Bugs

| id | date | cause | fix |
|---|---|---|---|
