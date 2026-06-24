// T6 / V1 / V11 — minimal HUD. PROVES the boundary: every value comes from a NARROW primitive selector
// over a published *ViewSnapshot. The HUD NEVER subscribes to a per-frame world array (no zombie
// positions, no instance buffers) — only throttled snapshot fields the engine deliberately published.

import { usePlayerView, useMapView, useUi, useTimeOfDay } from '../stores/react';
import { dayPhaseOf, formatTimeOfDay, type DayPhase } from '../render/scene/sky';

function Vital({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="hbn-vital">
      <span className="hbn-vital__label">{label}</span>
      <span className="hbn-vital__value">{value === null ? '--' : Math.round(value)}</span>
    </div>
  );
}

const PHASE_LABEL: Record<DayPhase, string> = { dawn: 'Dawn', day: 'Day', dusk: 'Dusk', night: 'Night' };

/** T126: HH:MM clock + day/night phase, sourced from the SAME day fraction the lighting uses (timeOfDayStore.current).
 *  Subscribes to two primitives only (V11/B24); the engine pushes `current` at minute granularity so this re-renders
 *  at most a couple of times a second, not per frame. A dev-frozen (override) clock is flagged. */
function TimeReadout() {
  const t = useTimeOfDay((s) => s.current); // primitive; engine guards to minute steps
  const frozen = useTimeOfDay((s) => s.overrideEnabled);
  return (
    <div className="hbn-vital hbn-vital--time" aria-label="time of day">
      <span className="hbn-vital__label">{PHASE_LABEL[dayPhaseOf(t)]}{frozen ? ' ❄' : ''}</span>
      <span className="hbn-vital__value">{formatTimeOfDay(t)}</span>
    </div>
  );
}

export function Hud() {
  // V11: each hook subscribes to the smallest practical slice — a single primitive.
  const hudVisible = useUi((s) => s.hudVisible);
  const health = usePlayerView((s) => s.snapshot?.health ?? null);
  const bleeding = usePlayerView((s) => s.snapshot?.bleeding ?? null);
  const stress = usePlayerView((s) => s.snapshot?.stress ?? null);
  const hunger = usePlayerView((s) => s.snapshot?.hunger ?? null);
  const thirst = usePlayerView((s) => s.snapshot?.thirst ?? null);
  const stamina = usePlayerView((s) => s.snapshot?.stamina ?? null);
  const ammoMag = usePlayerView((s) => s.snapshot?.ammoMagazine ?? null);
  const ammoReserve = usePlayerView((s) => s.snapshot?.ammoReserve ?? null);
  const weapon = usePlayerView((s) => s.snapshot?.weapon ?? null);
  // Coarse horde pressure counts — NOT entities (V1).
  const visibleZombies = useMapView((s) => s.horde?.visibleCount ?? null);
  const nearestThreat = useMapView((s) => s.horde?.nearestThreatMeters ?? null);
  // M2 mission status (objective + decisive event + district streaming) — coarse, throttled (V11).
  const directive = useMapView((s) => s.mission?.directive ?? null);
  const partsFound = useMapView((s) => s.mission?.partsFound ?? null);
  const partsRequired = useMapView((s) => s.mission?.partsRequired ?? null);
  const evacRemaining = useMapView((s) => s.mission?.evacuationTicksRemaining ?? null);
  const eventPhase = useMapView((s) => s.mission?.eventPhase ?? null);
  const eventOutcome = useMapView((s) => s.mission?.eventOutcome ?? null);
  const openRoutes = useMapView((s) => s.mission?.openRoutes ?? null);
  const reinforcedRoutes = useMapView((s) => s.mission?.reinforcedRoutes ?? null);
  const liveDistrictPop = useMapView((s) => s.mission?.liveDistrictPop ?? null);
  const abstractDistrictPop = useMapView((s) => s.mission?.abstractDistrictPop ?? null);

  if (!hudVisible) return null;

  return (
    <div className="hbn-hud" aria-label="heads-up display">
      <div className="hbn-hud__vitals">
        <Vital label="HP" value={health} />
        <Vital label="Bleed" value={bleeding} />
        <Vital label="Stress" value={stress} />
        <Vital label="Hunger" value={hunger} />
        <Vital label="Thirst" value={thirst} />
        <Vital label="Stam" value={stamina === null ? null : stamina * 100} />
        <div className="hbn-vital">
          <span className="hbn-vital__label">Weapon</span>
          <span className="hbn-vital__value">{weapon === null ? '--' : weapon.charAt(0).toUpperCase() + weapon.slice(1)}</span>
        </div>
        <div className="hbn-vital">
          <span className="hbn-vital__label">AMMO</span>
          <span className="hbn-vital__value">
            {ammoMag === null ? '--' : ammoMag === Infinity ? '∞' : `${Math.round(ammoMag)}/${Math.round(ammoReserve ?? 0)}`}
          </span>
        </div>
      </div>
      <div className="hbn-hud__threat">
        <TimeReadout />
        <Vital label="Visible Z" value={visibleZombies} />
        <Vital label="Nearest m" value={nearestThreat} />
        <Vital label="District live" value={liveDistrictPop} />
        <Vital label="District abstract" value={abstractDistrictPop} />
      </div>
      {directive && (
        <div className="hbn-hud__objective" aria-label="objective">
          <span className="hbn-hud__directive">{directive}</span>
          {partsRequired !== null && partsFound !== null && (
            <span className="hbn-hud__parts">Parts {partsFound}/{partsRequired}</span>
          )}
          {evacRemaining !== null && <span className="hbn-hud__evac">Evac in {Math.ceil(evacRemaining)}</span>}
          {eventPhase && eventPhase !== 'idle' && (
            <span className="hbn-hud__event">
              Horde event: {eventOutcome ?? eventPhase} · routes open {openRoutes} / reinforced {reinforcedRoutes}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
