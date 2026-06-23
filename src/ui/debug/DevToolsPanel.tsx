// Dev-tools overlay control panel. Slick floating panel of toggle switches bound to the debug-flag store
// (lane X). Each switch flips one boolean flag the render lane / scene-gizmo layer reads to draw the
// corresponding overlay (perception radii, FSM-state markers, sound field, nav/structural gizmos). Reads
// via narrow selectors (V11); writes via the store's toggleFlag action. Dev-only (mounted behind DEV).

import { useDebugView } from './useDebugView';
import { debugViewStore } from '../../diagnostics/store';
import type { BooleanDebugFlag } from '../../diagnostics/flags';
import { useState } from 'react';
import './debug.css';

interface ToggleDef {
  readonly key: BooleanDebugFlag;
  readonly label: string;
  readonly hint?: string;
}

interface ToggleGroup {
  readonly title: string;
  readonly toggles: readonly ToggleDef[];
}

const GROUPS: readonly ToggleGroup[] = [
  {
    title: 'Perception',
    toggles: [
      { key: 'showSightRadius', label: 'Sight radius', hint: 'per-zombie sense range' },
      { key: 'showAttackRadius', label: 'Attack radius', hint: 'melee reach' },
      { key: 'showZombieState', label: 'State markers', hint: 'idle / pursue / attack …' },
      { key: 'showSoundField', label: 'Sound field', hint: 'heard sources @ player' },
    ],
  },
  {
    title: 'World',
    toggles: [
      { key: 'showSpatialGrids', label: 'Spatial grids' },
      { key: 'visualizeFlowFields', label: 'Flow fields' },
      { key: 'inspectDirtyNavTiles', label: 'Dirty nav tiles' },
      { key: 'showStructuralCells', label: 'Structural cells' },
    ],
  },
  {
    title: 'Sim',
    toggles: [{ key: 'freezeTiers', label: 'Freeze tiers', hint: 'pin tier assignment' }],
  },
];

/** State-marker colour legend (mirrors sceneGizmos STATE_COLOR). */
const STATE_LEGEND: readonly { label: string; color: string }[] = [
  { label: 'Idle', color: '#3b82f6' },
  { label: 'Wander', color: '#22d3ee' },
  { label: 'Pursue', color: '#f59e0b' },
  { label: 'Attack', color: '#ef4444' },
  { label: 'Stagger', color: '#eab308' },
  { label: 'Down', color: '#6b7280' },
];

function ToggleRow({ def }: { def: ToggleDef }) {
  const on = useDebugView((s) => s.flags[def.key]);
  return (
    <button
      type="button"
      className={`hbn-dev__toggle${on ? ' is-on' : ''}`}
      onClick={() => debugViewStore.getState().toggleFlag(def.key)}
      aria-pressed={on}
    >
      <span className="hbn-dev__switch" aria-hidden="true">
        <span className="hbn-dev__knob" />
      </span>
      <span className="hbn-dev__label">
        {def.label}
        {def.hint ? <span className="hbn-dev__hint">{def.hint}</span> : null}
      </span>
    </button>
  );
}

export function DevToolsPanel() {
  const [open, setOpen] = useState(true);
  const showLegend = useDebugView((s) => s.flags.showZombieState);

  return (
    <aside className={`hbn-dev${open ? '' : ' is-collapsed'}`} aria-label="Developer overlays">
      <header className="hbn-dev__head">
        <button type="button" className="hbn-dev__collapse" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="hbn-dev__dot" />
          devtools
          <span className="hbn-dev__chevron">{open ? '▾' : '▸'}</span>
        </button>
      </header>
      {open ? (
        <div className="hbn-dev__body">
          {GROUPS.map((g) => (
            <section key={g.title} className="hbn-dev__group">
              <h4 className="hbn-dev__group-title">{g.title}</h4>
              {g.toggles.map((t) => (
                <ToggleRow key={t.key} def={t} />
              ))}
            </section>
          ))}
          {showLegend ? (
            <section className="hbn-dev__group">
              <h4 className="hbn-dev__group-title">State legend</h4>
              <div className="hbn-dev__legend">
                {STATE_LEGEND.map((s) => (
                  <span key={s.label} className="hbn-dev__legend-item">
                    <span className="hbn-dev__swatch" style={{ background: s.color }} />
                    {s.label}
                  </span>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
