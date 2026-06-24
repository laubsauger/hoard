// Config domain: perception. Owned by lane S. Stimulus-driven sensing ranges (T20, feeds T10 tiering).
// V14 — zombies never receive omniscient player coords; perception is stimulus-driven only.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const perceptionConfig = registerDomain('perception', {
  /** Base line-of-sight range for a default archetype. */
  sightRange: num({
    owner: 'perception',
    unit: 'meters',
    doc: 'Base line-of-sight detection range for a default archetype.',
    default: 24,
    min: 1,
    max: 200,
  }),
  /** Zombie field-of-view (full cone angle, degrees). A zombie only SEES the player within this cone of its
   *  facing — not 360° (V14). 360 = omnidirectional. */
  fieldOfViewDegrees: num({
    owner: 'perception',
    unit: 'degrees',
    doc: 'Full vision-cone angle a zombie can see within (centred on its heading). Not 360° by default.',
    default: 120,
    min: 10,
    max: 360,
  }),
  /** Player vision cone (full angle, degrees) — the Project-Zomboid-style forward awareness wedge used by
   *  the dev overlay (and the fog-of-war reveal). Widened to 135° (V62 perception v2) so the forward wedge
   *  reads as peripheral awareness, not a narrow flashlight beam. */
  playerFieldOfViewDegrees: num({
    owner: 'perception',
    unit: 'degrees',
    doc: 'Full angle of the player forward vision cone (overlay + fog-of-war reveal).',
    default: 135,
    min: 10,
    max: 360,
  }),
  /**
   * Near-proximity awareness radius (m) — PLAYER PERCEPTION v2 (V62), now the NIGHT FLOOR of the passive
   * awareness radius (T109/V72). A zombie/world cell within this radius is REVEALED regardless of cone direction
   * (you sense something right beside/behind you), BUT still gated on structural line-of-sight (hasLineOfSight)
   * — you do NOT sense it through a solid wall. Combines with the forward cone as one OR-term of the reveal:
   * revealVisibility = max(cone, near, memory, noise). The LIVE radius scales with ambient light from THIS floor
   * (full darkness) up to `passiveAwarenessRadiusMaxMeters` (full daylight) — see passiveRadiusFromAmbient.
   */
  playerNearAwarenessRadiusMeters: num({
    owner: 'perception',
    unit: 'meters',
    doc: 'Passive awareness radius (m) at full darkness — the night floor; LOS-gated, cone-independent (V62/V72).',
    default: 4,
    min: 0,
    max: 30,
  }),
  /**
   * Passive awareness radius (m) at full daylight — the bright-midday CEILING (T109/V72). Standing on an open
   * street at noon you passively see all around you out to this radius (still LOS-gated, so walls/solid props
   * stop it). The live radius lerps from `playerNearAwarenessRadiusMeters` (night) to this with the resolved
   * scene brightness. Must be >= the night floor (passiveRadiusFromAmbient throws otherwise).
   */
  passiveAwarenessRadiusMaxMeters: num({
    owner: 'perception',
    unit: 'meters',
    doc: 'Passive awareness radius (m) at full daylight — the bright-midday ceiling; LOS-gated (T109/V72).',
    default: 14,
    min: 0,
    max: 60,
  }),
  /**
   * Recently-seen memory window (s) — PLAYER PERCEPTION v2 (V62). A zombie that WAS revealed stays revealed for
   * this long after it leaves view, fading out (visibility ramps 1→0) over the window. This is a RENDER-side,
   * per-entity last-seen map held in the view layer, fed by dt — never sim state (V26 determinism is untouched).
   */
  playerSightMemorySeconds: num({
    owner: 'perception',
    unit: 'seconds',
    doc: 'Seconds a once-revealed zombie stays (fading) revealed after leaving the cone/LOS (render-side memory, V62).',
    default: 3,
    min: 0,
    max: 30,
  }),
  /** Player vision range (m) for the forward cone overlay. */
  playerVisionRange: num({
    owner: 'perception',
    unit: 'meters',
    doc: 'Range of the player forward vision cone (overlay + fog-of-war reveal).',
    default: 18,
    min: 1,
    max: 200,
  }),
  /** Soft fade band (m) at the FAR edge of the player vision reveal — crowd members within it shrink out
   *  instead of hard-popping (T98 fog-of-war). */
  playerVisionRangeFadeMeters: num({
    owner: 'perception',
    unit: 'meters',
    doc: 'Soft fade band at the far edge of the player vision reveal so threats fade out near max range (T98).',
    default: 3,
    min: 0,
    max: 50,
  }),
  /** Soft fade band (half-angle, degrees) at the CONE edge of the player vision reveal — members near the
   *  cone boundary fade out instead of hard-popping (T98 fog-of-war). */
  playerVisionConeFadeDegrees: num({
    owner: 'perception',
    unit: 'degrees',
    doc: 'Soft fade band at the cone edge of the player vision reveal so threats fade as they leave the wedge (T98).',
    default: 12,
    min: 0,
    max: 90,
  }),
  /**
   * Eye height (m) for SIGHT line-of-sight (V85). A standing observer sees OVER any solid obstacle SHORTER than
   * this — a waist-high picket fence (≈1 m) does not block vision, while a car / wall / tree (≥ eye height) does.
   * Governs the see-over sight gap only; movement + projectile occlusion are height-independent (nav-grid solid).
   * Matches the player aim-origin height (player.aimOriginHeight) so what you can SEE lines up with where you AIM.
   */
  eyeHeightMeters: num({
    owner: 'perception',
    unit: 'meters',
    doc: 'STANDING observer eye height (m): SIGHT passes OVER solid obstacles shorter than this (low fences); taller ones occlude (V85).',
    default: 1.6,
    min: 0.3,
    max: 3,
  }),
  /**
   * CROUCHED player eye height (m) — V86. While crouching (the sneak stance) the player's eye drops to this, so
   * (a) the player sees over LESS (a waist-high fence now blocks their own view) and (b) symmetrically the player
   * is HIDDEN behind any obstacle taller than this — a zombie cannot see a crouched player over a ~1 m fence or
   * below a window sill. The SAME dynamic height threshold gates both directions (every sightScene query is
   * player-referenced). Must be below `eyeHeightMeters`.
   */
  crouchEyeHeightMeters: num({
    owner: 'perception',
    unit: 'meters',
    doc: 'Crouched player eye height (m) — below a ~0.9 m window sill + the ~1 m fence so the player sees over less AND is hidden behind low cover / below a window (V86/V87).',
    default: 0.85,
    min: 0.2,
    max: 2,
  }),
  /** Sound reaching the horde through a wall is multiplied by this (V28 occlusion). 1 = no muffle. */
  soundWallOcclusion: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Intensity multiplier for a sound whose path to the horde is blocked by structure (V28).',
    default: 0.3,
    min: 0,
    max: 1,
  }),
  /**
   * P3 multi-floor: per-FLOOR sound attenuation. A sound made on one level reaching a hearer on another is
   * multiplied by this factor RAISED TO the floor distance (a gunshot one storey up/down is `× this`, two
   * storeys `× this²`) — the muffle of a sound bleeding through the floor via the stairwell (V4). 1 = no muffle.
   * Combines with the in-plane wall occlusion. A single-storey world never crosses floors, so it is inert there.
   */
  soundThroughFloorAttenuation: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Per-floor intensity multiplier for a sound heard one storey away (P3 sound-through-floor, V4).',
    default: 0.4,
    min: 0,
    max: 1,
  }),
  /** Base hearing range for a default-intensity stimulus. */
  hearingRange: num({
    owner: 'perception',
    unit: 'meters',
    doc: 'Base hearing range for a default-intensity sound stimulus.',
    default: 40,
    min: 1,
    max: 500,
  }),
  /** Threat contribution (0..1) of a confirmed visible player within sight range. */
  visibleThreatWeight: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Threat contribution of a confirmed visible threat within sight range.',
    default: 0.8,
    min: 0,
    max: 1,
  }),

  // ---- T20 utility scoring: per-stimulus-kind salience weights (V14) ----
  /** Utility weight applied to a heard sound stimulus when scoring what to pursue/investigate. */
  soundUtilityWeight: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Utility weight for a heard sound stimulus in behavior scoring (V14).',
    default: 0.7,
    min: 0,
    max: 1,
  }),
  /** Utility weight applied to a sight stimulus (confirmed visual contact is the strongest pull). */
  sightUtilityWeight: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Utility weight for a sight stimulus in behavior scoring (V14).',
    default: 1,
    min: 0,
    max: 1,
  }),
  /** Utility weight applied to nearby-agitation stimulus (herding/contagion of alertness). */
  agitationUtilityWeight: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Utility weight for a nearby-agitation stimulus (contagion of alertness, V14).',
    default: 0.5,
    min: 0,
    max: 1,
  }),
  /** Utility weight applied to a fire stimulus — NEGATIVE pull (avoidance), magnitude only here. */
  fireAvoidUtilityWeight: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Magnitude of fire-stimulus avoidance utility (subtracted, repels the agent, V14).',
    default: 0.9,
    min: 0,
    max: 1,
  }),
  /** Attenuated stimulus intensity at/above which it can flip a zombie out of idle/wander. */
  alertIntensityThreshold: num({
    owner: 'perception',
    unit: 'ratio',
    doc: 'Minimum attenuated stimulus intensity that can alert a zombie (V14).',
    default: 0.05,
    min: 0.001,
    max: 1,
  }),
  /** Ticks a zombie keeps investigating a stimulus origin after the stimulus fades. */
  investigateTicks: num({
    owner: 'perception',
    unit: 'ticks',
    doc: 'Ticks a zombie keeps investigating a last-known stimulus origin after it fades.',
    default: 120,
    min: 1,
    max: 6000,
    integer: true,
  }),
  /** Reach (meters) within which a zombie in pursuit transitions to attacking a target. */
  attackRangeMeters: num({
    owner: 'perception',
    unit: 'meters',
    doc: 'Reach within which a pursuing zombie transitions to its attack state.',
    default: 1.4,
    min: 0.2,
    max: 12,
  }),
  /**
   * Cap on the number of DISTINCT active target cells that each get their own shared flow field per tick
   * (V14/V15). Sound is localized perception, so the horde no longer follows one global field — each zombie
   * picks its own target (seen player / loudest heard sound) and zombies sharing a target cell share one
   * cached field. This bounds per-tick flow-field cost: the most-pursued targets win the budget; zombies
   * whose target falls outside it idle/wander until a more-pursued target frees a slot. Must stay <= the
   * navigation flowFieldCacheSize so the per-tick fields never thrash the LRU cache.
   */
  maxSimultaneousFlowFields: num({
    owner: 'perception',
    unit: 'count',
    doc: 'Max distinct per-tick target cells that get their own shared flow field (caps recompute cost, V15).',
    default: 4,
    min: 1,
    max: 32,
    integer: true,
  }),
});
