// T35 / V1 / V11 / V27 — HTML diagnostics overlay. Sections mirror the §I "Debug views (required)" list.
// Reads the published aggregate snapshot + flags via NARROW selectors (never per-frame world arrays).
// Debug-control toggles are wired through optional callbacks the render lane supplies (it owns the
// DebugFlagState + the actual 3D gizmo rendering; see flags.ts DEFERRED note).

import { useDebugView } from './useDebugView';
import { DebugFlagState, type BooleanDebugFlag, type DebugFlags } from '../../diagnostics/flags';
import './debug.css';

const NO_DATA = '—';

function fmtMs(v: number | null | undefined): string {
  return v === null || v === undefined ? NO_DATA : `${v.toFixed(2)} ms`;
}
function fmtInt(v: number | null | undefined): string {
  return v === null || v === undefined ? NO_DATA : Math.round(v).toLocaleString();
}
function fmtMiB(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? NO_DATA : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="hbn-dbg__row">
      <span className="hbn-dbg__k">{label}</span>
      <span className="hbn-dbg__v">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="hbn-dbg__section">
      <h3 className="hbn-dbg__title">{title}</h3>
      {children}
    </section>
  );
}

function FrameTimingSection() {
  const ft = useDebugView((s) => s.snapshot.frameTime);
  const lastFrameMs = useDebugView((s) => s.snapshot.lastFrameMs);
  const mainThreadMs = useDebugView((s) => s.snapshot.mainThreadMs);
  const gpuMs = useDebugView((s) => s.snapshot.gpuMs);
  return (
    <Section title="Frame timing">
      <Row label="median" value={fmtMs(ft?.medianMs)} />
      <Row label="95th" value={fmtMs(ft?.p95Ms)} />
      <Row label="99th" value={fmtMs(ft?.p99Ms)} />
      <Row label="last" value={fmtMs(lastFrameMs)} />
      <Row label="main-thread" value={fmtMs(mainThreadMs)} />
      <Row label="gpu" value={fmtMs(gpuMs)} />
      <Row label="samples" value={fmtInt(ft?.sampleCount ?? 0)} />
    </Section>
  );
}

function SimSection() {
  const sim = useDebugView((s) => s.snapshot.sim);
  return (
    <Section title="Sim timing">
      <Row label="tick" value={fmtMs(sim?.tickMs)} />
      <Row label="ticks/s" value={fmtInt(sim?.ticksPerSecond)} />
      <Row label="buckets run" value={fmtInt(sim?.bucketsRun)} />
    </Section>
  );
}

function WorkerSection() {
  const queues = useDebugView((s) => s.snapshot.workerQueues);
  return (
    <Section title="Worker queues">
      {queues.length === 0 ? (
        <Row label="depth" value={NO_DATA} />
      ) : (
        queues.map((q) => <Row key={q.name} label={q.name} value={fmtInt(q.depth)} />)
      )}
    </Section>
  );
}

function MarkerSection() {
  const markers = useDebugView((s) => s.snapshot.markers);
  const gc = markers.filter((m) => m.kind === 'gc').length;
  const save = markers.filter((m) => m.kind === 'save').length;
  const last = markers.length > 0 ? markers[markers.length - 1] : null;
  return (
    <Section title="GC / save markers">
      <Row label="gc events" value={fmtInt(gc)} />
      <Row label="save events" value={fmtInt(save)} />
      <Row label="last" value={last ? `${last.kind} ${last.durationMs.toFixed(1)} ms` : NO_DATA} />
    </Section>
  );
}

function RenderSection() {
  const r = useDebugView((s) => s.snapshot.render);
  return (
    <Section title="Render">
      <Row label="draw calls" value={fmtInt(r?.drawCalls)} />
      <Row label="triangles" value={fmtInt(r?.triangles)} />
      <Row label="instances" value={fmtInt(r?.instances)} />
      <Row label="anim groups" value={fmtInt(r?.animGroups)} />
      <Row label="lights" value={fmtInt(r?.lights)} />
      <Row label="shadow casters" value={fmtInt(r?.shadowCasters)} />
      <Row label="gpu mem est." value={fmtMiB(r?.gpuMemBytesEstimate)} />
      <Row label="textures" value={fmtInt(r?.textureResidentCount)} />
      <Row label="texture mem" value={fmtMiB(r?.textureResidentBytes)} />
    </Section>
  );
}

function ResourceSection() {
  const res = useDebugView((s) => s.snapshot.resources);
  return (
    <Section title="Tracked resources">
      <Row label="geometry" value={fmtInt(res?.geometry)} />
      <Row label="texture" value={fmtInt(res?.texture)} />
      <Row label="material" value={fmtInt(res?.material)} />
      <Row label="renderTarget" value={fmtInt(res?.renderTarget)} />
      <Row label="buffer" value={fmtInt(res?.buffer)} />
      <Row label="effect" value={fmtInt(res?.effect)} />
      <Row label="other" value={fmtInt(res?.other)} />
    </Section>
  );
}

function ZombieSection() {
  const z = useDebugView((s) => s.snapshot.zombies);
  return (
    <Section title="Zombies">
      <Row label="sim tiers" value={z ? z.simTierCounts.map((c) => fmtInt(c)).join(' / ') : NO_DATA} />
      <Row label="render tiers" value={z ? z.renderTierCounts.map((c) => fmtInt(c)).join(' / ') : NO_DATA} />
      <Row label="with target" value={fmtInt(z?.withTarget)} />
      {z &&
        Object.entries(z.stateCounts).map(([k, v]) => <Row key={`st-${k}`} label={`state:${k}`} value={fmtInt(v)} />)}
      {z &&
        Object.entries(z.updateFreqCounts).map(([k, v]) => (
          <Row key={`uf-${k}`} label={`freq:${k}`} value={fmtInt(v)} />
        ))}
    </Section>
  );
}

function SpatialSection() {
  const sh = useDebugView((s) => s.snapshot.spatialHash);
  const st = useDebugView((s) => s.snapshot.structural);
  const nf = useDebugView((s) => s.snapshot.navField);
  return (
    <Section title="Spatial / structural / nav">
      <Row label="hash occupied cells" value={fmtInt(sh?.occupiedCells)} />
      <Row label="collision candidates" value={fmtInt(sh?.candidatePairs)} />
      <Row label="max bucket depth" value={fmtInt(sh?.maxBucketDepth)} />
      <Row label="struct occupied cells" value={fmtInt(st?.occupiedCells)} />
      <Row label="support links" value={fmtInt(st?.supportLinks)} />
      <Row label="dirty regions" value={fmtInt(st?.dirtyRegions)} />
      <Row label="flow fields" value={fmtInt(nf?.flowFields)} />
      <Row label="portals" value={fmtInt(nf?.portals)} />
      <Row label="blocked links" value={fmtInt(nf?.blockedLinks)} />
      <Row label="dirty nav tiles" value={fmtInt(nf?.dirtyNavTiles)} />
    </Section>
  );
}

/** Optional control callbacks supplied by render integration; absent => read-only display. */
export interface DebugControlHandlers {
  onToggleFlag(key: BooleanDebugFlag): void;
  onSetForceLod(level: number | null): void;
}

function ControlSection({ controls }: { controls?: DebugControlHandlers }) {
  const flags = useDebugView((s) => s.flags);
  const readOnly = controls === undefined;
  return (
    <Section title="Debug controls">
      {DebugFlagState.booleanKeys().map((key) => (
        <label key={key} className="hbn-dbg__toggle">
          <input
            type="checkbox"
            checked={flags[key]}
            disabled={readOnly}
            onChange={() => controls?.onToggleFlag(key)}
          />
          <span>{key}</span>
        </label>
      ))}
      <Row
        label="forceLodLevel"
        value={flags.forceLodLevel === null ? 'auto' : fmtInt(flags.forceLodLevel)}
      />
      {!readOnly && <ForceLodControls flags={flags} controls={controls!} />}
    </Section>
  );
}

function ForceLodControls({ flags, controls }: { flags: DebugFlags; controls: DebugControlHandlers }) {
  return (
    <div className="hbn-dbg__lod">
      <button type="button" onClick={() => controls.onSetForceLod(null)}>
        auto
      </button>
      {[0, 1, 2].map((lvl) => (
        <button
          key={lvl}
          type="button"
          aria-pressed={flags.forceLodLevel === lvl}
          onClick={() => controls.onSetForceLod(lvl)}
        >
          {`LOD ${lvl}`}
        </button>
      ))}
    </div>
  );
}

export interface DebugOverlayProps {
  /** Control handlers from render integration. Omit for a read-only diagnostics panel. */
  controls?: DebugControlHandlers;
}

/** Toggleable diagnostics panel. Renders nothing when overlayVisible is false. */
export function DebugOverlay({ controls }: DebugOverlayProps) {
  const visible = useDebugView((s) => s.overlayVisible);
  if (!visible) return null;
  return (
    <aside className="hbn-dbg" aria-label="diagnostics overlay">
      <FrameTimingSection />
      <SimSection />
      <WorkerSection />
      <MarkerSection />
      <RenderSection />
      <ResourceSection />
      <ZombieSection />
      <SpatialSection />
      <ControlSection {...(controls !== undefined ? { controls } : {})} />
    </aside>
  );
}
