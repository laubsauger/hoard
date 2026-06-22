// T6 — the world viewport. React owns the <canvas> element (shell concern) and mounts the engine via a
// ref, but it NEVER reads per-frame world state back into React (V1). The direct Three.js engine renders
// into this canvas (NOT R3F, §C). For the Wave-1 spike this drives a stand-in publisher that pushes
// throttled snapshots into the view-stores, demonstrating the engine->store->HUD boundary end to end.

import { useEffect, useRef } from 'react';
import type { EntityId } from '../game/core/contracts';
import { createPlayerSnapshotGate, playerViewStore } from '../stores/playerView';
import { createHordeSnapshotGate, mapViewStore } from '../stores/mapView';
import { sessionStore } from '../stores/session';

const PLAYER_ENTITY = 0 as unknown as EntityId;

export function GameViewport() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    sessionStore.getState().setPhase('playing');

    // Stand-in for the authoritative sim publishing throttled snapshots (real engine lands at GATE 0).
    // Tier is fixed here; the live engine resolves it from capability detection (T5).
    const playerGate = createPlayerSnapshotGate(playerViewStore, 'desktop-high');
    const hordeGate = createHordeSnapshotGate(mapViewStore, 'desktop-high');

    let frame = 0;
    const handle = window.setInterval(() => {
      frame += 1;
      const wobble = Math.sin(frame / 10);
      playerGate.push({
        entity: PLAYER_ENTITY,
        health: 80 + wobble * 5,
        bleeding: Math.max(0, wobble * 3),
        pain: Math.max(0, wobble * 2),
        hunger: 40,
        thirst: 35,
        fatigue: 25,
        stress: 30 + wobble * 4,
        encumbrance: 12,
      });
      hordeGate.push({
        visibleCount: 320 + Math.round(wobble * 40),
        activeCount: 900,
        abstractCount: 12000,
        nearestThreatMeters: 18 + wobble * 6,
      });
    }, 33);

    return () => {
      window.clearInterval(handle);
      sessionStore.getState().setPhase('menu');
    };
  }, []);

  return <canvas ref={canvasRef} className="hbn-viewport" aria-hidden="true" />;
}
