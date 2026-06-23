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
- Cinematic near-isometric diorama presentation over a **LARGE authored multi-building world** — a street grid with MANY separately-enterable houses/buildings, Project-Zomboid-scale exploration (NOT a single building; the single-block M1/M2 slices were scoping artifacts, not the target). "Diorama" = the camera/lighting/cutaway STYLE; the cutaway reveals the interior of whichever building the player currently occupies. Streamed districts/sectors hold the rest (V13).
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
- Permanently voxel-looking world. A mechanical Project-Zomboid CLONE (we share its large multi-building explorable SCALE + survival depth, but differentiate via the destructible structural grid + cinematic diorama presentation + tiered massive horde — not a reskin of PZ's systems). Conventional scripted wave-defense. Physics sandbox keeping every prop/body a full rigid body forever. React component tree representing simulated world.

Decision rule on conflict: feature vs (readability | systemic consequence | stable perf | production capacity) → preserve central promise (§G) first.

Reference-fidelity bar: `docs/ART-DIRECTION.md` + `docs/inspo/` = the visual target (residential decay diorama; hand-painted outlined survivors; voxel substrate hidden until breach). Gray-box primitives = GATE-0 scaffolding only; M1+ "done" requires the authored look (V37).

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
- **V32** (backprop B1) Each fixed tick within a multi-tick frame MUST advance the tick index passed to systems. A frame running N catch-up ticks invokes scheduler/systems with tick, tick+1, … tick+N-1 — NOT the final index N times. Else interval-cadence systems (perception/tier/sound) misfire under variable-dt frames. Test with a variable-dt frame that advances >1 tick.
- **V33** (backprop B2) Per-instance / crowd GPU data that scales with entity capacity MUST use storage buffers or instanced vertex attributes via the WebGPU node path — NEVER a uniform buffer. Respect `maxUniformBufferBindingSize` (65536). A capacity-sized uniform (e.g. instanceMatrix as uniform = capacity×64B) silently invalidates the bind group and drops the draw. Verify by zero WebGPU validation errors in the in-browser smoke check at max horde capacity.
- **V34** (backprop B3) Visible structural geometry = thin authored shells, NOT cell-filling solids. Wall panel thickness ≪ nav-cell; cutaway/reveal faces MUST NOT be coplanar with retained walls/ground — inset + `polygonOffset`/`renderOrder` to kill z-fighting. Breach still hides cell shape (V30).
- **V35** (backprop B4) Hero/active/visible-tier agents MUST resolve agent-agent penetration to a min center distance (~2×radius) AFTER movement integrate. Soft steering separation alone (V19) is insufficient for visible tiers; only low/abstract tiers may interpenetrate. Doorway queueing/compression preserved.
- **V36** Desktop-high reference scene MUST present readable lighting: directional key + visible cast shadows + tone-mapped exposure + ambient/contact AO. Raw unlit/flat-ambient = release-blocker. Verify in-browser (not unit-only), per V8.
- **V37** Authored environment MUST read as its named real-world place (residential block = rooms, doors, windows, furniture, façade/interior materials per ART-DIRECTION) before a slice counts done (V27). Gray-box = scaffolding, not deliverable.
- **V38** Atmosphere stays readable + stable: fog is smooth distance/height-based with continuous params (no per-frame near/far snapping that sweeps visible bands); fog colour ≠ near-black background crushing all geometry; at reference tier the player + nearby ground stay legible across weather/time (V8, V36).
- **V39** Every authoritative combat outcome surfaces a render reaction. The frozen VisualEvent stream (hitReaction / bloodSpray / partDetached / entityDied / soundEmitted) MUST be drained each rendered frame and turned into feedback: muzzle flash + report on fire, hit flinch, directional blood, sever silhouettes, death reaction. A built effect system never fed events = not done (V8, V27).
- **V40** Death is a visible state transition, not an instant despawn. A killed entity plays a death reaction and leaves a compact persistent corpse (settled prop, pooled, configured lifetime, saved as delta per V9/V18) before eviction; render NEVER pops a live body off-screen without a death event. Dismemberment consequences persist on the corpse.
- **V41** Aim is single-sourced: ONE heading convention shared by sim + render (no ad-hoc per-mesh offset). The player avatar MUST face the aim/cursor target each frame within a small tolerance; firing direction == displayed facing.
- **V42** Agent movement respects body radius against STATIC blockers: a move is validated against impassable cells (walls / closed-or-locked doors / boarded / obstruction) with the agent's radius margin, NOT just the centre point — no part of a body penetrates a blocked cell; reject or slide. Pairs with agent-agent min-spacing (V35); together no visible body overlaps a wall or another body beyond the V19 low-tier tolerance.
- **V43** Interaction is context-filtered: the verbs offered on a target = f(target type, held items/tools, skills, proximity). NEVER offer an action the player cannot perform — omit it, or show it disabled with the missing requirement. ONE context surface (radial/menu) is the single entry point; a default-verb key (`E`) performs the top action without opening it.
- **V44** World actions are timed + interruptible: non-instant interactions run as queued timed actions with an on-character progress indicator, cancellable by the player and auto-cancelled by movement/threat. The sim (not the UI) owns action duration + completion; skill scales duration (V1/V12).
- **V45** ONE unified container model: furniture, floor tile, corpse, vehicle compartment = the same container abstraction behind one dual-pane transfer UI (player ↔ nearby/floor/container) with grab-all. Capacity is flat — NO recursive bag-in-bag capacity stacking. Carry limit (hard, strength-based) is separate from encumbrance (soft penalty curve).
- **V46** Two-channel survival feedback: an explicit per-body-part health panel for TREATABLE injuries (bleeding/wound/fracture → bandage/suture/splint) + a deliberately AMBIGUOUS moodle layer; the zombie infection is NOT UI-confirmed (inferred from generic moodles — the dread engine). Ties V29/V31.
- **V47** Perception + stimulus propagation are occlusion-aware: sight / attack / trigger checks and the sound/noise field MUST be attenuated or blocked by intervening walls / closed-or-locked doors / obstructions — a zombie does NOT see or hear through solid structure (line-of-sight for sight; material attenuation links for sound, V28). A breach/open door restores propagation locally (V5). Deepens V14/V28.
- **V48** Gore VisualEvents carry contract-normalized `energy` 0..1; renderers MUST clamp to [0,1] (a raw-damage value silently scales a quad to meters — B14). Hit gore spawns AT the struck region's world height (head/torso/limb), travels along the impact vector with velocity + spread (not one static axis-aligned quad), and lays a persistent ground splat/decal at the projected impact point. Pooled + capped (V24), distance-simplified (V8), gore-intensity gated (V29).
- **V49** A firearm tracer/projectile visual MUST terminate at the shot's actual stop distance — the struck body's travel (or max range on a clean miss) — NEVER drawn through bodies to max range. An impact spark marks the stop point. The visual reads where the shot actually stopped.
- **V50** Per-weapon ballistics: each weapon class defines damage, range, penetration budget (stopping power), spread, and damage falloff in typed config. Penetration consumes budget per body by body resistance/armor; when the budget is exhausted the shot STOPS — a handgun stops at 1 body by default, higher-power arms pierce more. `runtime.fire` resolves against the equipped weapon's model, not a single global firearm.
- **V51** Blood is MATTER, not glow. Pooled 3D droplets spawn at the struck region's height, arc under gravity + air-drag, and LAND as directional teardrop floor decals that darken/dry/soak into the ground over their life (lobed puddles + streaks, never clean ellipses). Gore type is per-archetype (blood / ichor / burned→none-or-ash). Heavy hits, dismemberment, and deaths erupt with more matter; crit/headshot tightens a directional jet down the shot line; volume scales with archetype size + impact energy (skewed so most hits spritz, the odd one erupts). The player BODY accumulates a gore coating that lingers far longer than floor decals (a long fight leaves you drenched) and leaves bloody footsteps while soaked + moving. Implementation: solid geometry + a pre-created `instanceColor` on `MeshBasicMaterial { toneMapped:false }` (the WebGPU-binding-safe instanced path, cf. V33); pooled + HARD-capped, no per-frame allocation (V24); render-local RNG only, NEVER feeds the sim (V2/V3); gore-intensity + reduce-flashes gated (V29); distance-simplified for the horde (V8).
- **V52** Gibs = flung SOLID body chunks (sibling to blood, V51): a kill/dismember throws a few low-poly faceted meat lumps that arc under gravity + air-drag, tumble (spin), LAND + settle on the floor, then dry + shrink away. Lit `MeshStandardMaterial` (matter, not additive) with a LOW emissive so dark gore reads on the dark floor (cf. B6), dark per-archetype gore colour via `instanceColor` (blood/ichor/burned→scrap-or-ash). `partDetached` flings the severed limb as a fat chunk (ties V17); `entityDied` throws a clutch (one fat lump ~30% vs a scatter, count/speed by archetype size). Pooled + HARD-capped ring buffer, no per-frame alloc (V24); solid-geo + pre-created `instanceColor` binding-safe path (V33); render-local RNG only (V2/V3); reduce-flash thins the count (V29). Ties to the corpse system (T54/T55): cosmetic gib burst on death; future overkill-corpse detonation = bigger gout.
- **V53** Firearm/projectile rays are occlusion-blocked by structure: a shot stops at the FIRST wall / closed-or-locked door / boarded panel / obstruction cell along its path — no damage and no visual beyond the blocker. No shoot-through-walls. Ties V47 (LOS) + V16 (hit pipeline); a breach/open door restores the line locally (V5).
- **V54** Gore decals project onto the ACTUAL hit surface, never a fixed world-Y: a render-side raycast finds the real floor height (interior slabs included) OR a wall/obstacle plane and orients the decal to the surface normal — so blood lands correctly indoors AND splats VERTICALLY on a wall behind a shot zombie. Decal shape is ORGANIC: teardrop/streak elongated along the impact velocity, varied size + rotation (never a uniform circle/blob), amounts tuned + hard-capped (most hits modest, the odd one erupts). Decay is SLOW with a long-lived DRIED-blood phase (darkened, persists) before recycle. Player bloody footsteps are subtle, delayed (only when heavily soaked), small, and infrequent.
- **V55** Muzzle flash / projectile / tracer originates at the weapon MUZZLE — in front of the player along the aim vector — never inside or behind the body. The player mesh faces the aim heading (single-source sim+render heading; cf. B8).
- **V56** ONE coherent depth/transparency layering policy (so effects stop fighting it): opaque structure (walls, units, a NON-hidden roof) depth-writes + occludes normally. A cutaway-FADED roof / upper-wall sets `depthWrite=false` while faded (restores when fully opaque) so it never occludes the interior floor, ground decals, or units below it. Ground decals (blood/scorch) keep depth TEST on (walls / units / the player correctly occlude them) but `depthWrite=false` + a polygon-offset bias toward the camera so they read on the floor without z-fighting. Effects MUST NOT use `depthTest:false` to force visibility — that draws them over the player/world and breaks layering; fix the occluder's depth-write instead.
- **V57** Impact response is by SURFACE type + gated on an actual damage hit: a ZOMBIE/player damage-hit (a body struck within the weapon's range) → blood spray (V51); a STRUCTURE / wall / clean-miss stop point → a distinct SPARK burst (bright, thrown OPPOSITE the impact direction — NOT red blood) + a persistent bullet-hole decal on the struck surface. Blood NEVER fires on a shot that did not damage a body within range. Struck bodies also take a wound decal at the hit region. The visual must let the player tell "I hit a wall" from "I hit a zombie" at a glance.
- **V58** Cutaway removes ONLY the roof/walls actually occluding the camera→player sightline, DYNAMICALLY as camera/player move — never all four sides of a room by default (almost never all 4). Per V20 + the Project Zomboid cutaway reference + `docs/ART-DIRECTION.md`: fade the near/occluding faces to see in, the far walls stay to read enclosure.

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
| T36 | x | X | benchmark suite: Crowd avenue, Breach cascade, Dense interior, Streaming sprint, Corpse accumulation, Mobile capability; median/95/99 frame times; CI captures | T9, T16, T33 | V10, §V-gates |
| T39 | x | X | test layers: unit (damage/transfer/strength/tier/config), deterministic replay, integration (breach→nav+vis+audio+render+persist consistency), content validation, visual regression, perf, save-compat | T16, T33 | V26, V27 |
| T38 | x | INT | M1 vertical slice: one city block — street + multi-room building, cutaway camera, loot, shelter actions, melee+firearm, sound attraction, save/load, day/night+weather, one full modify-defend-escape loop | W2 done | V27, milestone-1 |
| T40 | x | INT | M2 vertical slice: representative district final-quality art, medium-term objective + decisive horde event shaped by player mods, production pipeline, benchmark suite, accessibility pass, stable save migration, reference desktop quality on named hw | T38, T34, T36, T37, T39 | milestone-2, V27 |

### Wave 4 — Fidelity & UX (close the reference gap; PARALLEL lanes R / S / U / A)

Closes the gap between spec-done and the `docs/ART-DIRECTION.md` reference. Prior Wave-2/3 systems (T13/T28/T29/T38/T40) shipped functional but gray-box; these deliver the authored look + missing UX shell. Additive — supersedes the fidelity gaps without reopening prior status.

| id | st | lane | task | deps | cites |
|---|---|---|---|---|---|
| T43 | x | R | thin wall-shell geometry + fix cutaway z-fighting (inset/polygonOffset/renderOrder); base-vs-upper split reads enclosure | T28,T13 | V20,V34 |
| T44 | x | S | agent separation hardening: post-integrate penetration resolve to min spacing for hero/active/visible tiers; doorway queueing preserved; low/abstract may overlap | T12,T20 | V19,V35,collision-config |
| T58 | x | S | radius-aware static collision: validate moves against impassable cells (wall/closed-locked door/boarded/obstruction) with body-radius margin (not centre-point); reject/slide so bodies never clip into walls; pairs with T44 | T12,T13,T25 | V6,V42,collision-config |
| T45 | x | R | lighting+shadow delivery: directional key w/ visible cast shadows, tone-mapped exposure (wired to renderer), ambient+contact AO, stable readable fog, diorama grade per time/weather; in-browser verify | T29,T31 | V8,V36,V38,shadows-config,lighting-config |
| T46 | . | S | doors as structural+interactive modules: open/close/lock/board/breach; per-state block/clear of nav+sight+sound; destructible w/ damage states | T13,T25 | V30,V37,destruction-config |
| T47 | . | A | residential content kit: room layouts, furniture/prop library, window+door meshes, façade/interior material families; art-direction pass so block reads residential | T34 | V7,V37,ART-DIRECTION |
| T48 | . | R | environment dressing: replace gray-box primitives w/ authored materials + overgrowth/decay/weathering per ART-DIRECTION; outline+grade integration | T31,T32,T47 | V8,V20,V37,ART-DIRECTION |
| T49 | x | U | pause/ESC menu: ESC toggles authoritative pause (sim halts, V12-safe), resume/settings/quit; single-player slowdown option | T6 | V29,I.stores |
| T50 | . | U | input/hotkeys + rebinding UI: full key remap + separate sensitivity, persisted to settings; binds move/aim/fire/interact/inventory/tools | T4 | V29,input-config,I.stores |
| T51 | . | U | settings panel: graphics-tier override (safe-limit guard V25), audio, accessibility (outline/gore/shake/flashes/motion/contrast/subtitles), reachable from pause | T49,T37 | V25,V29 |
| T52 | . | A | authored character meshes: player survivor + zombie archetypes (shambler/bloated/runner/crawler) per ART-DIRECTION T-pose + archetype sheets, replacing capsule/box + instanced placeholders; skeleton+regions feed dismemberment | T34,T9 | V7,V17,V37,ART-DIRECTION |

### Wave 5 — Combat feel & feedback (PARALLEL lanes R / S)

The combat systems resolve authoritatively but surface nothing: VisualEvents are emitted into the ring queue and drained nowhere; the (built) GoreSystem is never constructed/fed; death frees the slot with no corpse; the avatar does not face the cursor. These wire the feedback loop end-to-end.

| id | st | lane | task | deps | cites |
|---|---|---|---|---|---|
| T53 | x | R | combat feedback render: drain VisualEvents/frame → muzzle flash + tracer + report on fire, hit flinch on hitReaction, directional blood spray/stains + sever silhouettes via the (already-built) GoreSystem | T19,T30 | V8,V39,effects-config |
| T54 | . | S | death→corpse state: replace instant `free` with a death transition + compact persistent corpse (settled prop, pooled, configured lifetime, saved delta); dismemberment consequences persist | T17,T33 | V18,V40,combat-config |
| T55 | . | R | death + corpse + dismemberment render: topple/death reaction, corpse meshes/impostors, detached-part props consume `partDetached` | T54,T30 | V8,V17,V40 |
| T56 | x | R | aim/firing avatar: single-source heading (sim+render), avatar faces cursor each frame, firing pose + recoil | T7,T52 | V21,V41 |
| T57 | . | S | combat lethality + reactions tuning: non-head hits wound/stagger (not instakill), wound state drives behaviour; head-kill stays; emit `hitReaction` per resolved hit | T16,T17 | V16,V17,combat-config |

### Wave 6 — Interaction & menus (PARALLEL lanes S / U)

Context-driven player↔environment interaction + the menu surfaces (interaction wheel, inventory, character/health). Sim foundations already exist (commands `equip`/`moveItem`/`craft`/`confirmAction`/`modifyStructure`; contextual affordances in `crafting.ts`; door access-states + `boarded` in `modifications.ts`; containers in `inventory/`) — the gap is interaction RESOLUTION + UI. Design reference: `docs/research/project-zomboid-interactions.md` (PZ mechanics breakdown — what to steal vs simplify) + `docs/ART-DIRECTION.md`.

| id | st | lane | task | deps | cites |
|---|---|---|---|---|---|
| T59 | x | S | interaction resolution: from player pos+facing+held items+skills, enumerate valid contextual verbs on nearby targets (door/window/container/barricade/furniture/corpse/structure); publish as a filtered affordance list contract. Reuse `crafting.ts` affordances + `modifications.ts` access-states | T24,T25 | V43,crafting-config,destruction-config,PZ-research |
| T60 | . | U | interaction wheel / context menu UI: radial/list at cursor showing filtered verbs (disabled + missing-req shown), default-verb key (`E`), click → `confirmAction`/`modifyStructure` command | T59,T6 | V43,V1,I.cmd,PZ-research |
| T61 | . | S | timed-action queue: per-player action queue, durations from config scaled by skill, progress in player-view snapshot, cancel on Esc / movement / threat | T3 | V44,V12,PZ-research |
| T62 | x | U | inventory menu: dual-pane (player ↔ nearby/floor/container), drag + grab-all via `moveItem`, equip primary/secondary, hard carry-cap vs soft encumbrance readout, per-item context verbs | T23,T4 | V45,V1,V11,inventory-config,PZ-research |
| T63 | . | S | unified container surfacing: expose furniture/floor/corpse/vehicle as one container type via `ContainerRef`, proximity-populated; flat capacity (no recursive bag stacking) | T23 | V45,inventory-config,PZ-research |
| T64 | x | U | character/health panel: per-body-part treatable injuries (bleeding/wound/fracture → bandage/suture/splint), moodle row, skills/XP tab, clothing/protection; infection stays ambiguous (no UI confirm) | T22,T4 | V29,V31,V46,survival-config,PZ-research |
| T65 | . | S | barricade siege model: barricade = sacrificial HP layer in front of door/window; board/reinforce tiers gated by skill (skill also raises HP); zombie COUNT (not strength) drives structure damage; key/lock-bypass verb | T13,T25 | V18,V30,V42,destruction-config,PZ-research |

| Cite token | Resolves to |
|---|---|
| PZ-research | `docs/research/project-zomboid-interactions.md` (Project Zomboid interaction-model breakdown) |
| ART-DIRECTION | `docs/ART-DIRECTION.md` (visual target / reference-fidelity bar) |

### Wave 7 — Dev iteration & scene fidelity (PARALLEL lanes R / S / U)

Live-iteration instrumentation + the scene-fidelity fixes the dev loop surfaced. Reference: `docs/research/project-zomboid-interactions.md`, `docs/ART-DIRECTION.md`.

| id | st | lane | task | deps | cites |
|---|---|---|---|---|---|
| T66 | . | U | dev spawn controls: dev-tools sliders/actions to raise live zombie count + spawn rate up to SoA capacity for limit-testing; read back actual alive count + frame cost | T35,T58 | V10,zombies-config |
| T67 | . | R | real GPU-time panel: expose a `RendererHost` renderer/timestamp getter → stats-gl GPU panel + feed `renderer.info` (draw calls/triangles/GPU mem) into `DiagnosticsCollector` | T5,T35 | V10,V24,V27 |
| T68 | x | S | occlusion-aware perception + sound: gate sight/attack/trigger by line-of-sight vs walls/closed doors; attenuate the stimulus field through intervening structure (V28 links); breach/open restores | T13,T20,T27 | V14,V28,V47,perception-config,audio-config |
| T69 | . | S | shootable car + car alarm in the dev street scene: shooting the car triggers a looping car-alarm sound stimulus to test/iterate the noise field; alarm draws the horde via the shared flow (V15) | T25,T27,T59 | V14,V28,destruction-config |
| T70 | x | R | house geometry pass: ONE solid wall per span (not doubled slim panels with a gap), reasonable height (`buildingWallHeightMeters`), window + door openings, base+upper reading as a single wall; fixes the gap regression. [doubled-wall+gap fixed (B12, centred panels); framed door leaves at exit gaps + glass window panes on facade cells. Interactive open/close/lock = T46] | T43,T28 | V20,V34,V37,world-config,ART-DIRECTION |

### Wave 8 — Gore, ballistics & character anatomy (PARALLEL lanes R / S / A)

Visible-quality + combat-feel gaps spotted in-browser: blood renders as a giant scaling square, tracers draw through whole rows of zombies, characters are featureless boxes so dismemberment has nothing to act on.

| id | st | lane | task | deps | cites |
|---|---|---|---|---|---|
| T71 | . | R | gore render overhaul: clamp energy→[0,1]; directional velocity-driven multi-particle blood spray from the struck region's world height along the hit vector + spread; persistent ground splat/decals at the projected impact; billboarded, pooled+capped, distance-simplified, gore-intensity gated | T19,T53 | V48,V8,V24,V29,effects-config |
| T72 | . | R/A | block-limbed character rig for hero/active tiers (+player): compound block mesh (head/torso/upper+fore arms/thigh+shin) with region↔part ownership; a severed region hides/detaches its part + spawns blood from it; visible-horde stays instanced box; tier promotion swaps box→rig | T17,T30,T52 | V17,V13,ART-DIRECTION |
| T73 | . | S | per-weapon ballistics: weapon classes (pistol/rifle/shotgun/melee) in config with damage/range/penetration-budget(stopping power)/spread/falloff; penetration consumes budget per body by resistance/armor → handgun stops at 1 body, rifle pierces more; `runtime.fire` uses the equipped weapon + returns the actual stop distance | T16,T18 | V50,V16,weapons-config |
| T74 | . | R | projectile/tracer terminates at the actual stop distance (struck-body travel, or max-range miss) + impact spark at the stop point; muzzle at the weapon muzzle; per-weapon tracer style | T53,T73 | V49,effects-config |

| T75 | . | R | rich pooled blood system (supersedes T71's basic spray): droplet SoA physics (gravity + drag) → directional drying floor-decal ring buffer (lobed puddles/streaks); per-archetype gore type (blood/ichor/burned); region + energy + crit-scaled volume; player-body gore coating (accumulate + linger) + bloody footsteps while soaked; distance-simplified; solid-geo + `instanceColor` binding-safe path; all tunables typed config | T71 | V48,V51,V8,V24,V29,effects-config |

| T76 | . | R | gibs view (sibling to T75 blood): pooled flung faceted meat chunks — gravity+drag arc, tumble/spin, land+settle, dry+shrink; per-archetype gore colour; `partDetached`→severed-limb chunk, `entityDied`→clutch; lit low-emissive `MeshStandardMaterial` (reads on dark floor, cf B6); `instanceColor` binding-safe; reduce-flash gated; all tunables config | T55,T75 | V52,V17,V8,V24,V29,effects-config |

W8 lane split: α = lane R (T71, T74, T75, T76) — render/effects only, disjoint from the house-geometry/GPU-panel R work; β = lane S (T73) combat; lane A/R (T72) char rig (touches crowd/scene — sequence after T70 house pass to avoid blockScene contention).

### Wave 9 — Combat feel & gore polish (PARALLEL lanes R / S)

In-browser feedback on the live build: shots pierce walls, the muzzle spawns behind the player, blood is circular/excessive and invisible indoors (below the floor), no wall splats, footsteps too extreme.

| id | st | lane | task | deps | cites |
|---|---|---|---|---|---|
| T77 | . | R | blood quality + surface-projection pass (tunes T75): organic velocity-aligned teardrop/streak decals (varied size/shape/rotation), reduced amounts + caps, slow decay + long dried-blood phase; project each decal onto the REAL hit surface via render-side raycast — true floor height (interior slabs) or WALL plane, oriented to the surface normal; subtle delayed sparse footsteps | T75 | V54,V8,V24,V29,effects-config |
| T78 | . | R | muzzle/tracer origin at the weapon muzzle in front of the player along aim (not behind/through the body) + player mesh faces the aim heading (fixes B8/B20-muzzle) | T74 | V55,V21,rendering-config |
| T79 | . | S | firearm ray blocked by structure: stop at the first wall / closed-or-locked door / boarded / obstruction cell along the path; no shoot-through-wall; return the true stop distance for the tracer | T16,T13 | V53,V16,V47,weapons-config |

W9 lane split: α = lane R (T77, T78) render/effects + GameViewport (raycast reads scene geometry, does NOT edit blockScene); β = lane S (T79) combat ray-vs-structure. Background jobs (concurrent with the spec agent); reconcile via full `npm run check`.

### Wave 10 — Impact response & directional cutaway (PARALLEL lanes R)

In-browser: shooting a wall/missing reads like blood (no distinct surface impact), no bullet holes, no wounds on bodies; and the cutaway strips whole rooms (all 4 walls) instead of just the occluders.

| id | st | lane | task | deps | cites |
|---|---|---|---|---|---|
| T80 | . | R | surface impact response: a STRUCTURE/wall/clean-miss stop → a distinct bright spark burst thrown OPPOSITE the impact (NOT red) + a persistent bullet-hole decal projected on the struck surface (via the existing surface raycaster); keep blood strictly on a zombie damage-hit within range (gate it). Applies to all surfaces | T74,T77 | V57,V51,effects-config |
| T81 | . | R | wound decals at the struck region on zombie + player bodies (small dark wound mark at the hit point, accumulates, capped) | T17,T75 | V57,V17,effects-config |
| T82 | . | R | directional dynamic cutaway: fade ONLY the roof/walls occluding the camera→player sightline (almost never all 4); far walls stay to read enclosure; updates as camera/player move (touches `blockScene`/visibility — coordinate w/ the house-geometry owner) | T28,T70 | V58,V20,ART-DIRECTION |

W10 lane split: α = lane R (T80, T81) render/effects (sparks + bullet holes + wounds, blood-gating) — disjoint from blockScene; T82 directional cutaway touches `blockScene`/visibility (coordinate, sequence after the house-geometry settles). Car + car-alarm = the already-speced T69 ("after that").

### Wave 11 — Playable loop: items, loot, the actual game (the missing core)

REALITY CHECK: Waves 0–10 built the engine + combat rendering, but the GAME is not playable — there are no items in the world, containers/corpses hold no loot, and interaction is dummy top-bar buttons. The handout's M1 "loot" was foundations only (registry + container model), never content or a loot loop. These tasks + Wave-6 interaction/menus (T59–T65) are the real remaining work. PARALLEL lanes S / U / A.

| id | st | lane | task | deps | cites |
|---|---|---|---|---|---|
| T83 | x | A | item catalog CONTENT: a real authored set of `ItemDef`s (melee/firearm weapons, ammo, food, drink, meds/bandages, tools, materials, valuables) with stats/weight/stack per the items config — populate the registry; validated (V4/V7) | T23 | V4,V7,items-config,inventory-config,PZ-research |
| T84 | x | S | loot population + tables: per-container-type + per-zombie-type loot tables (weighted, deterministic seed V26); world build fills furniture/floor containers, zombie DEATH (T54) spawns a corpse container with loot; searched/looted state persists (V9) | T23,T54,T63,T83 | V9,V26,inventory-config,PZ-research |
| T85 | . | S | item world-presence + pickup: dropped/loose items exist as world entities the floor-container surfaces; pick up / drop / transfer via `moveItem`; equipped weapon drives `runtime.fire` (T73) | T23,T63,T73 | V1,inventory-config |
| T86 | . | INT | M3 playable loot loop (integration): enter a building → open a container/corpse → loot items into inventory (T62) → equip a weapon → use the equipped weapon; via the interaction wheel (T60), NOT the dummy bar; delete `Controls.tsx` dummy buttons | T59,T60,T62,T63,T83,T84,T85 | V27,V45,milestone-3 |

W11 = the playable core. Build order: T83 (content) + T84/T85 (loot+pickup, lane S) ∥ T59→T60 + T62/T64 (interaction+menus, lane U), then T86 integration (delete the dummy bar). This — not the combat-render polish — is what makes it a game.

**Suggested 2-agent assignment** (parallel-safe by lane):
- **W0** — 1 agent: T1→T2→T3→T42 (contracts must be serial + frozen).
- **W1** — α=lane S (T8,T10,T11,T12,T13,T14); β=lane R (T5,T7,T9)+lane U (T4,T6). Lane A (T34) = optional 3rd agent, fully independent.
- **GATE 0** — 1 coordinator: T41 (stitch only, no concurrent lane edits to glue).
- **W2** — α=lane S systems (T16→T17/T18, T20→T21, T22,T23→T24, T25→T26, T27); β=lane R systems (T30,T19,T28,T29,T31,T32)+X (T35).
- **W3** — α=S (T33), β=R (T37)+X (T36,T39); then 1 coordinator for INT (T38→T40).
- **W4** — α=lane R (T43,T45,T48); β=lane S (T44,T46)+lane U (T49,T50,T51); lane A (T47,T52) independent. T48 deps T47 (cross-lane, sequence content→dressing).
- **W5** — α=lane R (T53,T55,T56); β=lane S (T54,T57). T55 deps T54 (cross-lane corpse-state→render), T56 deps T52 (char meshes).
- **W6** — α=lane S (T58,T59,T61,T63,T65); β=lane U (T60,T62,T64). T60 deps T59 (cross-lane resolution→wheel UI).
- **W7** — α=lane R (T67,T70); β=lane S (T68,T69)+lane U (T66). Independent except T69 builds on the T68 sound work.

Five decisions to lock before vertical-slice brief finalized (OPEN, §C): campaign+ending+sandbox role; death+save model (do modified worlds survive death); min desktop GPU + WebGPU/compat policy; max launch scope collapse/fire/obstruction; camera rotation+zoom+control model.

---

## §B — Bugs

| id | date | cause | fix |
|---|---|---|---|
| B1 | 2026-06-22 | `GameRuntime.update` ran every scheduler tick of a multi-tick frame with a constant `ctx.tick` (final index) → interval-cadence systems (perception/tier/sound) misfired under variable-dt rAF frames advancing >1 tick. GATE-0 tests only stepped 1 tick/update so never exposed it. | Per-tick index reconstruction in `update` (mirrors `FrameLoop`); invariant V32 + variable-dt multi-tick test. |
| B2 | 2026-06-22 | Crowd `instanceMatrix` bound as a WebGPU uniform buffer (core `MeshStandardMaterial`+`InstancedMesh` auto-convert on three r171); at desktop-high capacity 4000 → 256000 B > 65536 max uniform binding → `bindGroup_object` invalid → crowd draw silently dropped (canvas empty). GPU-free unit tests couldn't catch it; found via in-browser CDP smoke check. | Initial (r171): hand-rolled interleaved-buffer + `positionNode` workaround. Superseded 2026-06-23: upgraded three r171→r184 (whose `InstanceNode` auto-falls-back to instanced attributes past the uniform limit) → workaround removed; crowd rewritten to canonical storage-buffer instancing + TSL GPU-compute transform node (V2 GPU-readable animation). V33 + CDP assert zero WebGPU validation errors at max capacity. |
| B3 | 2026-06-23 | Walls rendered as cell-filling `BoxGeometry(navCellSize, h, navCellSize)` (`render/scene/blockScene.ts`) → visually too thick + cutaway reveal faces coplanar with retained wall/ground → z-fighting on reveal. | Thin wall-shell geometry (config panel thickness ≪ cell) + inset/`polygonOffset`/`renderOrder` on cutaway faces; invariant V34; T43. **✓ FIXED 2026-06-23 (code; CDP-verified).** |
| B4 | 2026-06-23 | Crowd uses soft steering separation only (`steerSeparationMeters` blend); movement integrate checks walkable but never resolves agent-agent penetration → visible-tier zombies interpenetrate ("glitch into each other"). | Hard min-spacing resolution for hero/active/visible tiers after integrate; invariant V35; T44. **✓ FIXED 2026-06-23 (V35-compliant: hero+active+visible resolved; benchmark baseline re-recorded for new cost).** |
| B5 | 2026-06-23 | Linear `Fog` near/far recomputed every frame from oscillating weather severity (`blockScene.ts`); near-ortho camera renders the moving fog boundary as bands sweeping the screen; fog colour == near-black background (`0x0b0d0a`) → "can't see anything". | Smooth/clamp fog distances (or exponential height fog), decouple from per-frame severity noise, lift fog floor colour; invariant V38; T45. **✓ FIXED 2026-06-23 (CDP-verified scene now lit).** |
| B6 | 2026-06-23 | Renderer never sets `toneMapping`/`toneMappingExposure`; `interiorExposure` computed in `lighting.ts` but never applied; night spawn (low sky key+ambient) crushes the scene to black, player barely visible. | Wire ACES/AgX tone mapping + exposure (incl. interior/exterior compensation) to the WebGPURenderer; ensure a viewable night floor; invariant V36; T45. **✓ FIXED 2026-06-23 (AgX tonemapping+exposure wired; T45 still owes cast shadows + contact AO).** |
| B7 | 2026-06-23 | Render lane built `GoreSystem` + the full VisualEvent contract (hitReaction/bloodSpray/partDetached) but the live path never calls `runtime.pollEvents()` and never constructs/feeds the GoreSystem → combat emits events into the ring queue, drained nowhere → no muzzle, hit flinch, blood, sever, or death feedback. | Drain VisualEvents per frame in viewport/scene; construct + feed GoreSystem; add muzzle/report on fire; invariant V39; T53. **✓ FIXED 2026-06-23 (pollEvents drained, GoreSystem fed, muzzle/tracer/blood/flinch).** |
| B8 | 2026-06-23 | Player avatar rotation `playerMesh.rotation.y = -playerAim() + π/2` (`blockScene.ts`) does not match the aim heading convention (`atan2(dz,dx)`) → the player does not point at the mouse cursor. | Single-source the heading convention; avatar faces aim target each frame; invariant V41; T56. |
| B9 | 2026-06-23 | Zombie death (`onEntityDied → despawn → zombies.free`) frees the slot immediately with no corpse or death state → bodies instantly disappear on a single hit, no body/blood remains. | Death state transition + persistent corpse (settled prop, pooled, saved); invariant V40; T54/T55. |
| B10 | 2026-06-23 | Movement integrate validates only the centre point against walkable cells (`hordeSystems.ts stepMovement` → `isWalkableWorld(nx,nz)`), ignoring agent radius → bodies clip half into walls; agent-agent penetration was steering-soft only → zombies overlap each other + walls. | Radius-aware static collision (reject/slide) + post-integrate agent-agent separation; invariants V42/V35; T58/T44. |
| B11 | 2026-06-23 | Dev scene gizmos drew at y=0.06, under the authored floor slab (y=0.2), with depthTest on → debug overlays invisible. | Lift gizmo Y clear of the slab + `depthTest:false`/`depthWrite:false` so the debug layer always draws on top (`render/debug/sceneGizmos.ts`). Fixed. |
| B12 | 2026-06-23 | Thin-wall rework (T43) produced TWO slim wall panels per span separated by a large gap, no window/door openings, low height → reads as parallel fences, not a house wall. | One solid wall per span at `buildingWallHeightMeters` with window/door openings; base+upper read as a single wall; V20/V34/V37; T70. |
| B13 | 2026-06-23 | Live scene still renders black street + no cast shadows: tone-mapped exposure (B6) + directional shadow casting (T45) not yet delivered in `blockScene` (computed but not applied / shadows not enabled). | Apply exposure + enable shadow map + ambient floor so the street is lit; in-browser verify; invariants V36/V38; T45 (still open). |
| B14 | 2026-06-23 | `hitReaction`/`bloodSpray` emit `energy` = RAW effective damage (`hitPath.ts:318`), but the VisualEvent contract + GoreSystem expect normalized 0..1; `combatFeedback` scales the blood quad by energy → `0.35×(0.5+0.5×~50) ≈ 9 m` axis-aligned square ("massive scaling square"). Spray is also one static quad at the body's GROUND position — no hit-vector/velocity, no ground splat, wrong height. | Render: clamp energy→[0,1] + directional velocity multi-particle spray from the struck region's height + persistent ground splat (V48; T71). Sim: emit normalized energy + true hit-point (combat lane, with T73). |
| B15 | 2026-06-23 | Firearm tracer drawn at full `tracerRangeMeters` (`combatFeedback.ts:285`) regardless of impact → beam visibly passes through every zombie to max range ("5 rows deep") although `runtime.fire`→`combat.fire()` damages only the FIRST body. No per-weapon penetration/stopping-power model (single global firearm config; `firePenetrating` exists but the runtime uses first-body `fire()`). | Tracer/impact terminate at actual stop distance (V49; T74) + per-weapon ballistics with a penetration budget (V50; T73). |
| B16 | 2026-06-23 | `hordeSystems.flowTargetCell` returned the sound lure whenever active (`investigateTicks`=120) WITHOUT checking sight → the whole horde chased an old gunshot for seconds and ignored a player standing in view; you could walk straight past them. | `flowTargetCell` drops the lure the moment any zombie senses the player (`stepPerception` caches `playerVisibleToHorde`); sight beats stale sound; V14; `sightLure.test`. Fixed. |
| B17 | 2026-06-23 | "Board wall" button crashed the UI: `applyStructureOp` (board/reinforce) called `wall.reinforce`, which THROWS on a breached/empty cell, instead of returning a failed `CommandResult` → uncaught exception surfaced as an error. Violated V1 (commands fail with an explicit reason, never an exception). | Guard `cell.breached` and return `{ ok:false, reason }`; V1. Fixed. (The dummy command bar itself is superseded by the Wave-6 interaction system, T59/T60.) |
| B18 | 2026-06-23 | Blood floor decals land at a fixed `y≈0.04` but interior floor slabs sit higher (≈0.2) → decals render BELOW the floor, invisible indoors; and blood only ever lands on the ground (no wall splats). | Project the decal onto the actual hit surface via render-side raycast — true floor height (incl. interior slab) or a wall plane, oriented to the surface normal (V54; T77). |
| B19 | 2026-06-23 | Blood spray reads too circular + excessive; floor decals too blobby + too many; player bloody footsteps too immediate/extreme/blobby after soaking. | Organic velocity-aligned teardrop/streak decals, varied size, reduced counts + caps, slow decay + long dried-blood phase; subtle delayed sparse footsteps (V54; T77). |
| B20 | 2026-06-23 | Firearm shots pass THROUGH walls (`gatherAlongRay`/`fire` never test structure occlusion) → hit zombies behind walls; and the muzzle/tracer spawns at the player's BACK and travels through the body before exiting the front (wrong origin + player not facing aim). | Combat ray stops at the first structure blocker, no shoot-through (V53; T79); muzzle/tracer origin at the weapon muzzle in front of the player along aim + face the aim heading (V55; T78). |
| B21 | 2026-06-23 | Blood floor decals invisible INDOORS: the cutaway-faded roof still depth-wrote, occluding the interior floor; an over-correction (`depthTest:false`) then drew blood OVER the player. Underlying: no coherent depth-layering policy. | Faded roof/upper-walls set `depthWrite=false` while faded (`blockScene`); decals keep depthTest ON + depthWrite OFF + polygon-offset bias; per V56. Also: horde jitter at target (separation vs steering) → arrival-stop ring (`hordeArriveRadiusMeters`, V19/V35); muzzle flash static rotation → orient to aim (V55); tracer drew full range through walls on a miss → wire `ShotResult.stopDistanceMeters` to `fireFeedback` (V49/V53). |
| B22 | 2026-06-23 | Blood appears to fire on EVERY shot regardless of range/hit — actually `bloodSpray` is hit-gated in `hitPath`, but the impact SPARK on a wall/miss looks red/blood-like, so a miss reads as "blood beyond range". No distinct wall response. | Distinct STRUCTURE impact: spark burst (opposite dir, not red) + bullet-hole decal; keep blood strictly on a zombie damage-hit within range; bodies get a wound decal (V57; T80/T81). |
| B23 | 2026-06-23 | Cutaway culls ALL walls of a room (all four sides) instead of only the camera-occluding ones → rooms read as roofless open boxes, loses enclosure. | Directional dynamic cutaway: fade only the roof/walls between camera and player; far walls stay; almost never all 4 (V58/V20, Project Zomboid ref; T82). |
|---|---|---|---|
