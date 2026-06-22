# Art Direction — Findings from `docs/inspo/`

Working notes distilled from the reference images. Goal: capture the **visual contract** — especially the *voxel-substrate vs. authored-mesh* tension and the overall art style — in a form we can later turn into SPEC §C / §I invariants and §T tasks.

Cross-references SPEC.md: `§C` (LOCKED stack + visual constraints), `§G` (central promise: physically altering the city changes survival + horde behavior).

---

## 1. The reference set splits into three visual languages

The inspo is not one look — it is a spectrum, and the spread is the point. Each end teaches us a different rule.

| Cluster | Examples | What it is | What we take | What we reject |
|---|---|---|---|---|
| **A. Hand-painted illustrated iso** ("Dead Zone: ISO") | scavenger/scout T-pose sheets, zombie type sheet, kitchen-cutaway gameplay, cul-de-sac, sneak HUD | Painterly 2.5D, strong dark outlines, detailed character meshes, gritty realism | **Character + zombie fidelity, outline language, HUD grammar, mood** | Fully-painted *static* world (no destructibility implied) |
| **B. Painterly-pixel iso** | sunken canal bridge, overgrown gray township (wide) | Crisp pixel/painterly hybrid, deep shadow, heavy overgrowth, big readable silhouettes | **Lighting depth, overgrowth density, environmental storytelling** | Pixel rendering pipeline (we are 3D/WebGPU) |
| **C. Low-poly / voxel diorama** | verdant crossroads, rusted crossroads, farmstead barn, voxel city intersection | Tabletop diorama on a literal wooden plinth, low-poly chunky forms, blocky trees | **Diorama framing, plinth/cutout staging, chunky readable massing, the *substrate* feel** | Voxel as the **final visible skin** (SPEC NON-GOAL: "permanently voxel-looking world") |

**The synthesis target is not any single cluster — it is A's character/material fidelity rendered inside C's diorama staging, lit like B.**

---

## 2. The voxel ↔ mesh contract (the core question)

SPEC §C already locks the principle:

> "Authored visible continuous geometry+materials; hidden sparse structural grid inside destructible modules (player sees no cubes unless tool exposes)."
> NON-GOAL: "Permanently voxel-looking world."

The inspo confirms the *reading* of that rule:

- **Voxel is the skeleton, not the skin.** Cluster C dioramas show what the *structural grid* would look like if exposed — chunky, modular, gridded. That is the hidden truth of every building. The player must NOT normally see it.
- **The visible surface is authored continuous mesh + painted material** — Cluster A fidelity: real window frames, ivy, rust streaks, torn fabric, individual planks on the canal bridge.
- **The seam between them only appears on destruction.** When a wall breaches / collapses / a tool excavates, the exposed interior may reveal the blockier substrate — and that is *desirable*, it sells the "this was solid, now it's broken" read. The voxel look is a **reveal state**, never the **rest state**.

### Practical translation for specs

1. **Two-layer authoring per destructible module:** authored surface shell (continuous, hi-detail, painted) wrapping a sparse structural voxel/cell grid (destruction bookkeeping + collapse logic).
2. **Surface dressing hides the grid:** overgrowth, trim, decals, beveled edges, AO break up any latent blockiness while intact. Cluster B's overgrowth is doing this job in the references — vines/moss soften hard geometry.
3. **Damage states expose progressively:** intact mesh → cracked/holed mesh → exposed substrate chunks → rubble. The chunk reveal is where C's voxel honesty is allowed to surface.
4. **Characters & zombies are always Cluster-A meshes** — never voxelized. They are the fidelity anchor that keeps the whole frame from reading as "blocky game." High-contrast outlined silhouettes (see §3) sit on top of chunkier environments and that contrast is the signature look.

> Signature frame = **detailed outlined survivor mesh, standing in a diorama-staged block of city, whose walls are continuous until you break them open.**

---

## 3. Character & creature style (Cluster A — the fidelity anchor)

From the T-pose sheets (`Survivor: Scavenger`, `Scout`, `Under-geared Scavenger`) and the zombie sheet (`Shambler / Bloated / Runner`):

- **Proportions:** grounded, realistic 7–7.5 heads; *not* chibi, *not* heroic-8-head. Survival-worn adults.
- **Silhouette first:** every archetype reads at iso distance by silhouette + palette alone — scavenger vest+belt-pouches, scout backpack+bedroll, bloated belly, runner lean-forward sprint.
- **Outline language:** selective strong dark outlines (matches SPEC "selective strong outlines"). Outlines on character/creature + key props, lighter or absent on ground. This is the unifying ink that lets a detailed mesh sit on a chunkier world without clashing.
- **Material storytelling = gear tier.** Under-geared = patches, mismatched fabric, mud/blood stains, fingerless gloves, scavenged belt rigs. Gear visibly upgrades the silhouette. Loadout should be *legible on the model*, not just inventory UI.
- **Zombie types are visually distinct classes**, each with 3/4 turnaround consistency: Shambler (rag, slumped), Bloated (mass, exposed gut, slow), Runner (lean, aggressive, mid-stride). Supports SPEC "multiple zombie types, individual hit reactions, dismemberment" — sheets are turnaround refs ready for rigging + dismemberment seams.
- **Gore:** explicit, anatomical (SPEC "explicit gore, individual anatomical damage") — blood decals, wounds, exposed flesh tones already on the sheets.

---

## 4. Environment style (Clusters B + C)

- **Diorama staging:** scenes are framed as discrete cutout blocks (often on a wooden plinth in concept renders). Translate to: **district/chunk presented as a contained near-orthographic diorama**, soft-vignetted edges, mini-map insert top-right. Matches SPEC "Cinematic near-isometric diorama presentation."
- **Cutaway interiors:** the kitchen shot shows roof/wall fade so interiors read from iso. Need a **wall-cull / fade-on-occlude** system for player-occupied interiors (god-rays through holes = bonus mood).
- **Overgrowth as a time/danger signal:** ivy, moss, corn fields, weeds reclaiming streets. Density of overgrowth = how long since collapse / how abandoned. A cheap, beautiful environmental-storytelling lever; also functions as the geometry-softener from §2.
- **Decay vocabulary:** cracked asphalt, rusted abandoned cars/buses, downed power lines, chain-link + barbed wire, billboards, dumpsters, tires, scattered rubble. Consistent props across all env refs — this is the kit-bash library.
- **Palette:** desaturated olive/khaki/concrete-gray base, warm rust + sodium-light accents, sickly zombie green-gray skin. Color is muted so blood-red, UI-red, and pickup-glints pop.
- **Lighting:** deep ambient occlusion in recesses (Cluster B canal), strong directional key with long shadows, volumetric shafts through broken roofs. Mood = oppressive but readable.

---

## 5. HUD / presentation grammar (consistent across refs)

- Top-left: **Health + Stamina** twin bars (red / green-yellow), portrait optional.
- Top-right: **mini-map** showing district road grid + objective arrow.
- Bottom: **quick-access hotbar** (weapon, tools, meds) + small icon row (medkit / flashlight / wrench seen repeatedly).
- Bottom-center contextual: **objective line** + state read (e.g. `SNEAK: C`).
- Same dark-outline, gritty-stencil treatment on UI chrome as on world — UI and world share one ink.

---

## 6. Open questions to route into SPEC (`?` flags)

These are art-driven product decisions, not yet locked:

1. **Substrate reveal fidelity** — how blocky is "exposed structural grid" allowed to look on breach? (chunky-honest vs. mesh-fractured). Affects destruction tech + asset pipeline.
2. **Outline rendering tech** — post-process edge detect vs. inverted-hull vs. baked. Drives WebGPU pass budget.
3. **Wall-fade vs. wall-removal** for occluding interiors — fade, dither, or full cull?
4. **Plinth/cutout framing** — literal diorama vignette edges, or seamless continuous city with diorama *lighting* only? (concept renders use plinth; gameplay shots mostly don't.)
5. **Overgrowth as system vs. dressing** — does vine density carry gameplay meaning (cover, age, navigation) or pure decoration?
6. **Character LOD floor** — SPEC NON-GOAL says no "photoreal close-up fidelity for every crowd member"; where is the crowd-member simplification line before it reads as voxel/blob?

---

## 7. One-line art pillar (proposed)

> **Hand-painted, hard-outlined survivors fighting through a diorama-staged, overgrown dead city whose buildings look solid until you break them open — then the bones show.**
