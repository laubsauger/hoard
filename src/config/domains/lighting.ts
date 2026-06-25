// Config domain: lighting. Owned by lane R (render). Self-registers on import (copies time.ts pattern).
// T29 / V8 — directional sun/moon, dynamic local lights, contact+ambient AO near player, fog/weather
// extinction + interior exposure transitions. V4 — every tunable carries unit/owner/default/range/tier.
// V22 — dynamic local lights are an EARLY scaling victim (#5), so their budget is per-tier.

import { num } from '../spec';
import { registerDomain } from '../registry';

export const lightingConfig = registerDomain('lighting', {
  // ---- Key directional light (sun by day / moon by night) ----
  sunIntensity: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Directional key-light intensity at midday (relative luminance multiplier).',
    default: 1,
    min: 0,
    max: 10,
  }),
  moonIntensity: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Directional key-light intensity at night (moonlight).',
    default: 0.15,
    min: 0,
    max: 10,
  }),
  ambientIntensity: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Baked/precomputed indirect ambient floor for static architecture.',
    default: 0.25,
    min: 0,
    max: 5,
  }),
  minAmbientIntensity: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Hard floor on ambient fill so a night spawn never crushes the scene to black (B6 viewable-night floor). LOWERED for the moonlit-night opening so roof-shadowed interiors + moon-shadowed exterior faces go genuinely dark (close to pitch black, flashlight-dependent) while moon-facing surfaces still catch the directional moonlight.',
    default: 0.07,
    min: 0,
    max: 2,
  }),

  // ---- Dynamic local lights (flashlight/fire/alarm/vehicle) — V22 scaling step #5 ----
  localLightBudget: num({
    owner: 'lighting',
    unit: 'count',
    doc: 'Max simultaneously active dynamic local lights (scaled down under GPU pressure, V22 #5).',
    default: 16,
    min: 0,
    max: 256,
    integer: true,
    tiers: { 'desktop-high': 32, 'desktop-medium': 16, 'desktop-compat': 8, 'mobile-webgpu': 4 },
  }),

  // ---- Contact + ambient occlusion near the player ----
  contactAoRadiusMeters: num({
    owner: 'lighting',
    unit: 'meters',
    doc: 'World-space radius around the player within which contact/ambient occlusion is emphasized.',
    default: 6,
    min: 0.5,
    max: 50,
  }),
  ambientOcclusionStrength: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Strength of near-player ambient occlusion darkening (0 = off). Drives the centre alpha of the cheap contact-AO grounding disc (T45/V36).',
    default: 0.6,
    min: 0,
    max: 1,
    tiers: { 'desktop-high': 0.7, 'desktop-compat': 0.4, 'mobile-webgpu': 0.3 },
  }),
  contactAoGroundLiftMeters: num({
    owner: 'lighting',
    unit: 'meters',
    doc: 'Height the contact-AO grounding disc sits above the ground/floor plane so it composites over it without z-fighting (T45/V36).',
    default: 0.03,
    min: 0,
    max: 1,
  }),

  // ---- Atmospheric fog / weather extinction ----
  fogExtinctionPerMeter: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Base atmospheric extinction coefficient per world meter (clear weather).',
    default: 0.006,
    min: 0,
    max: 1,
  }),
  weatherExtinctionMultiplierMax: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Upper multiplier on fog extinction at maximum weather severity (rain/smoke/fog).',
    default: 6,
    min: 1,
    max: 50,
  }),
  fogVisibilityTransmittance: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Transmittance at which the scene has fully faded to fog colour — sets the analytic fog far plane (B5).',
    default: 0.12,
    min: 0.001,
    max: 0.99,
  }),
  fogFarMinMeters: num({
    owner: 'lighting',
    unit: 'meters',
    doc: 'Lower clamp on the fog far distance (heavy weather) so the far plane never collapses onto the player (B5).',
    default: 60,
    min: 5,
    max: 2000,
  }),
  fogFarMaxMeters: num({
    owner: 'lighting',
    unit: 'meters',
    doc: 'Upper clamp on the fog far distance (clear weather) so distant geometry still fades into atmosphere (B5).',
    default: 360,
    min: 10,
    max: 4000,
  }),
  fogNearRatio: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Fog near distance as a fraction of the fog far distance (linear fog onset).',
    default: 0.35,
    min: 0,
    max: 0.95,
  }),
  fogDistanceSmoothingPerSecond: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Per-second exponential approach rate for fog near/far toward their target — decouples fog from per-frame severity changes so the boundary never sweeps the screen as bands (B5).',
    default: 4,
    min: 0.1,
    max: 60,
  }),
  fogFloorLuminance: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Minimum luminance of the fog/background colour (lifts it off near-black so the scene reads against the far plane — B5).',
    default: 0.16,
    min: 0,
    max: 1,
  }),
  nightExposureBoostStops: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Extra exposure stops applied at full darkness (scene-brightness 0) so a night scene stays just viewable after tone mapping (B6). LOWERED for the moonlit-night opening: the old +1.5 lifted the night street ~2× into flat grey; +0.6 keeps a faint floor (never crushed to pure black) while the open ground reads genuinely dark — picked out by the moon directional + the flashlight, not washed flat.',
    default: 0.6,
    min: 0,
    max: 6,
  }),

  // ---- Interior exposure transitions (eyes adapting going in/out of buildings) ----
  interiorExposureStops: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Exposure compensation (stops) applied when fully inside an enclosed interior AT NIGHT. Faded toward zero in daylight by interiorExposureDaylightFalloff — see that field. LOWERED so a roof-shadowed night interior stays NEAR-BLACK without the flashlight (the intended PZ-style "the torch is your only light indoors"): the old +1.2 over-brightened the interior so it read brighter than the moonlit street (inversion bug). A small residual lift keeps you from 100% blind while the flashlight remains the dominant interior light.',
    default: 0.25,
    min: 0,
    max: 6,
  }),
  interiorExposureDaylightFalloff: num({
    owner: 'lighting',
    unit: 'ratio',
    doc:
      'How much the interior exposure boost FADES OUT in full daylight, 0..1 (1 = fully gone at midday, 0 = always full). ' +
      'B44 fix: the cutaway view keeps the roof casting shadow but lets the camera see in, so a DAYLIT interior is only a touch dimmer than the sunlit street — NOT the dark cave a first-person interior would be. A flat interior boost therefore made interiors read BRIGHTER than the exterior, and stepping OUTSIDE dropped exposure ~2.3x with no matching rise in scene radiance, so the street suddenly looked much darker (the reported "outside is darker than inside" bug). Scaling the boost by darkness (1 - sceneBrightness) removes it in daylight (seamless in/out, sunlit street reads bright) while keeping the full lift for a genuinely dark night interior lit mainly by the flashlight.',
    default: 1,
    min: 0,
    max: 1,
  }),
  exposureTransitionSeconds: num({
    owner: 'lighting',
    unit: 'seconds',
    doc: 'Time to blend exposure when crossing the interior/exterior threshold.',
    default: 0.8,
    min: 0,
    max: 10,
  }),

  // ---- Player flashlight (T98) — a SpotLight at the player aimed along playerAim(), lighting the same
  //      forward wedge the vision-cone fog-of-war reveals (lit area == visible area). At night it is the main
  //      light; by day it is subtle (intensity scaled by scene brightness). V4: every tunable typed here. ----
  flashlightIntensity: num({
    owner: 'lighting',
    unit: 'ratio',
    doc:
      'Player flashlight SpotLight intensity at night (full darkness). Scaled down by daylight (flashlightDayIntensityScale). ' +
      'Raised (B44) so the beam still READS outdoors at dusk/night — outside the open sky/moon ambient competes with the additive cone, and the wider near-floor cone (flashlightConeHalfAngleDegrees) spreads the same flux over more ground, so it needs more punch to stay the player\'s main light.',
    default: 60,
    min: 0,
    max: 400,
    tiers: { 'desktop-high': 68, 'mobile-webgpu': 44 },
  }),
  flashlightDayIntensityScale: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Fraction of flashlightIntensity that remains in full daylight (subtle by day, dominant at night). Raised so the beam still reads OUTSIDE/at dusk where ambient stays high — it was washed out (too weak) below this.',
    default: 0.32,
    min: 0,
    max: 1,
  }),
  flashlightRangeMarginMeters: num({
    owner: 'lighting',
    unit: 'meters',
    doc: 'Extra reach added to the player vision range so the lit cone slightly overshoots the revealed wedge (no dark fringe at the cull edge).',
    default: 4,
    min: 0,
    max: 50,
  }),
  flashlightAngleMarginDegrees: num({
    owner: 'lighting',
    unit: 'degrees',
    doc: 'Extra half-angle added to the player FOV half-angle for the SpotLight cone so its penumbra covers the revealed wedge edge. (Legacy — the flashlight cone now uses its OWN flashlightConeHalfAngleDegrees, decoupled from the vision FOV.)',
    default: 8,
    min: 0,
    max: 60,
  }),
  flashlightConeHalfAngleDegrees: num({
    owner: 'lighting',
    unit: 'degrees',
    doc: 'Flashlight SpotLight cone HALF-angle — its OWN value, decoupled from the (wide) player vision FOV. Widened (B44) from a tight torch so the cone\'s lower edge reaches the GROUND close to the player (kills the dark ring at the feet) while the axis still throws forward. Nudged 24→28 for a slightly broader spill.',
    default: 28,
    min: 4,
    max: 80,
  }),
  flashlightAimGroundDistanceMeters: num({
    owner: 'lighting',
    unit: 'meters',
    doc:
      'Ground distance AHEAD of the player the beam AXIS aims at — deliberately CLOSER than the full reach (flashlightRangeMeters). B44 fix for the dark gap right at the feet: the SpotLight sits at flashlightHeightMeters, so aiming its target at the ground at FULL range made the axis a shallow downward slope whose lower cone edge only met the floor far downrange (near floor sat below the beam). Aiming the axis at a near ground point tilts the cone steeply DOWN so the lit pool begins near the feet and rakes forward; the beam still REACHES flashlightRangeMeters (set via SpotLight.distance, independent of the target point), so the throw is preserved.',
    default: 4,
    min: 0.5,
    max: 40,
  }),
  flashlightRangeMeters: num({
    owner: 'lighting',
    unit: 'meters',
    doc: 'Flashlight beam reach (m) — its OWN range, decoupled from the player vision range. Clamped to the first wall along the aim (V67).',
    default: 15,
    min: 2,
    max: 80,
  }),
  flashlightNoseOffsetMeters: num({
    owner: 'lighting',
    unit: 'meters',
    doc: 'How far IN FRONT of the player centre the flashlight beam originates — just at the avatar nose, not the body centre. Small: 0.4 read as pushed way out front; a nose-tip nudge is enough.',
    default: 0.12,
    min: 0,
    max: 2,
  }),
  flashlightPenumbra: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'SpotLight penumbra (0 = hard edge, 1 = fully soft) — softens the flashlight cone edge so threats fade in rather than pop, and (B44) lets the soft lower edge fill the near ground in front of the player quickly.',
    default: 0.7,
    min: 0,
    max: 1,
  }),
  flashlightDecay: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'SpotLight physical distance decay exponent (2 = inverse-square). Lower = flatter falloff across the wedge.',
    default: 1.1,
    min: 0,
    max: 4,
  }),
  flashlightHeightMeters: num({
    owner: 'lighting',
    unit: 'meters',
    doc: 'Height above the ground the flashlight is mounted (chest/torch height). 1.35 (raised from the B44 1.05): high enough to shine IN/OUT of windows (above the ~0.9 m sill) and OVER low furniture, while the near-ground AIM (flashlightAimGroundDistanceMeters) still rakes the cone down to light the floor at the feet — so no feet dead-zone returns.',
    default: 1.35,
    min: 0.1,
    max: 4,
  }),
  flashlightWallClampMarginMeters: num({
    owner: 'lighting',
    unit: 'meters',
    doc: 'RAYCAST-CLAMPED flashlight cone (V67): the SpotLight reach is clamped to the distance to the first STRUCTURAL wall along the aim (via rayDistanceToWall on the nav grid), PLUS this margin so the struck wall face itself stays lit instead of going black. Stops the beam shining THROUGH/past a wall the player faces (no light spilling outside the building). Reuses the SAME wall grid the shots + perception LOS use — not a second wall representation.',
    default: 0.6,
    min: 0,
    max: 5,
  }),
  flashlightColor: num({
    owner: 'lighting',
    unit: 'ratio',
    doc: 'Flashlight beam colour as a packed 0xRRGGBB hex (cool-white torch).',
    default: 0xfff1d0,
    min: 0,
    max: 0xffffff,
    integer: true,
  }),
});
