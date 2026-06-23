# Project Zomboid — Interaction Model Research (for our interaction/menu design)

Cross-verified mechanics breakdown of how player↔environment interaction works in Project Zomboid, captured to drive our SPEC §T "Interaction & menus" wave. Build 41 baseline; B42 = current crafting-overhaul beta (flagged). PZ wikis block automated fetch — a few figures are single-source snippets worth in-engine verification.

## 1. Context interaction model (right-click)
Right-click a world tile → `ISContextMenu` lists every valid interaction for that tile; the engine bundles door/window/frame/thumpable/hoppable/tree on the tile into one menu. Menu is filtered by **(targeted object type, items held/in-inventory, skills/profession/recipe knowledge)**. `E` = default action (open door, climb window) without opening the menu; held/tap `E` = urgent variant (smash). Examples: barricade only with hammer+planks; disassemble only with hammer+saw; cut tree only with axe; connect generator only Electrical 3 OR electrician OR read the magazine.
**Takeaway:** one context menu filtered by `(targetType, heldItems, skills)`; never show an unperformable action — omit or grey with the missing requirement.

## 2. Doors & windows
Door states: Open↔Closed, Locked↔Unlocked, Barricaded (1–4 plank layers/side → 8; or metal), Damaged→Destroyed. Inside = lock/unlock without key; outside = needs matching per-building key. **No vanilla lockpicking** (key, climb a window, or destroy). Sledgehammer right-click "Destroy" = near-instant, only tool that does it, no salvage. Barricade = **1 plank + 2 nails + hammer** per layer (max 4/side), or 1 metal sheet + propane torch + welding mask (no skill req). Door takes no damage until barricade layers fall. Window adds: Smashed/glass-removed/curtained/sheeted; **sheet = no tool/nail**, blocks LOS both ways, operable from inside; climbing glass → laceration.
**Takeaway:** model openings as a state machine (open/closed × locked × barricade-layers × glass) with the barricade a separate destructible HP layer *in front of* the door — one abstraction drives player defense + zombie siege.

## 3. Containers & looting
Dual-pane loot UI: left = open container, right = player + every in-range container + the **Floor** (ground tile is a container). Proximity auto-populates; transfers are timed (progress bar). Drag / right-click Grab / **Loot All**. Vehicles expose trunk + seats + glovebox as containers. A zombie corpse becomes a container (stand on its tile). Bags nest but capacity does **not** multiply recursively and weight-reduction doesn't stack through nesting.
**Takeaway:** treat furniture = floor = corpse = vehicle compartment as the SAME container type; one dual-pane transfer UI + Grab-All; flat "no recursive capacity" rule.

## 4. Barricades & carpentry
Two-stage build: frame → upgrade to wall. Wooden wall gated Carpentry 2/4/7 by tier; metal gated Metalworking/Welding 3. **Skill raises wall HP and visual quality**, not just unlock. Zombie-vs-structure (B41 decompiled, directional): barricade consumed before the door/wall; player-built walls ignore zombie *strength* (count-driven, ~`thumpDmg=8` → 1 dmg/hit needs 8+ zombies); pre-existing map doors use strength + need ≥2 zombies; barricades have no min-zombie threshold but huge HP. B42 adds a dedicated Build panel with categories + required-items/skill + ghost preview.
**Takeaway:** gate tiers by skill AND let skill raise HP; barricade = sacrificial HP layer; zombie **count** (not strength) drives wall damage so hordes matter more than individuals.

## 5. Inventory UI
Dual-pane (player / nearby+floor+containers); equipped items at bottom; encumbrance top-right. Primary/secondary hand slots (some weapons two-handed). Hotbar via belt/holster slots, keys 1–5 equip, hold = radial. **Carry limit = hard strength number** (base 12 @ Str 5; 6 @ Str 0; 20 @ Str 10). **Worn bags don't raise the cap — they reduce contents' encumbrance** (e.g. military backpack ~85%, −6% move) only while worn. Heavy-load penalty tiers at >100/125/150/175% (move/sprint/run loss, then non-lethal HP damage). Item context: Equip/Eat/Read/Disassemble/Drop/Grab/Attach/Loot-All.
**Takeaway:** separate hard carry cap (strength) from soft encumbrance curve (bag reduction %); the multi-tier penalty ramp makes loot-hauling a real risk/reward decision.

## 6. Character / health UI
Health panel: body split into **17 sections**; right-click a part to treat. Injuries → treatment: scratch/laceration → bandage; deep wound → suture; fracture → splint (not head/torso); lodged glass/bullet → tweezers; bleeding blocks regen until bandaged; clean/sterile bandages lower wound-infection. **Two infections:** wound/bacterial (shown, curable via disinfectant/antibiotics) vs **Knox zombie virus (always fatal, NOT shown in UI — inferred from generic anxiety/queasy/sick moodles; ~72h)**. Moodles = circular icons, multi-tier (hunger/thirst/tired/panic/stress/pain/heat/cold/wet/heavy/sick/...). Skills cap at 10; skill books give XP multipliers. Clothing has per-part Bite/Scratch/Bullet defense + thermal stats; holes zero protection.
**Takeaway:** two parallel channels — explicit per-body-part panel for *treatable* injuries + a deliberately *ambiguous* moodle layer for the zombie infection (no UI confirmation = dread). Per-part coverage ties clothing protection + injuries to one body map.

## 7. Timed actions
Most interactions are timed actions consuming in-game time with an on-character progress bar; they queue (`ISTimedActionQueue`) and run sequentially. `Esc` cancels current + clears; movement (jog/sprint) usually cancels; being attacked breaks actions; per-action `cancellable` flag. Skill scales duration/result; Tired/Heavy-Load slow physical actions; Panic narrows vision + cuts combat.
**Takeaway:** a single timed-action queue + on-character progress bar + Esc-clear + auto-cancel-on-threat is the backbone — skill scales duration, danger interrupts.

## 8. Crafting / contextual building
Two paradigms: (a) **contextual common-sense** actions surfaced by world right-click based on held item + proximity (barricade, place wall/floor, saw log, dismantle, chop) — no master list; (b) **recipe-based crafting** with explicit ingredients/tools/skill/success-rate menu. B42 formalized much context-building into a searchable Build panel + Crafting menu with required-items/substitutes shown up front.
**Takeaway:** contextual right-click for *placement/common-sense* verbs tied to a world tile; searchable recipe panel for *fabrication*; show requirements/substitutes up front (don't ship hidden "secret" actions — PZ players find them undiscoverable).

## What to steal vs simplify
**Steal:** one filtered context menu `(targetType, heldItems, skills)`; sacrificial barricade HP-layer + count-driven zombie damage; unified container model + dual-pane + Grab-All; timed-action queue (progress, Esc, threat-cancel); two-channel health feedback (explicit injuries + ambiguous infection); skill raises unlock AND result quality/HP/speed.
**Simplify:** one clean wall-HP formula (`base + skill×k`); one carry model (hard cap + soft bag %); flat no-recursive-capacity; trim ~23 moodles to a core dozen; put a searchable build/recipe panel up front (don't hide common-sense actions); bake in a deliberate lock-bypass verb (PZ leaves lockpicking to mods).
