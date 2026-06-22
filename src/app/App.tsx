// V1: React owns the shell only. The world engine mounts here later (T5) but never
// writes per-frame world state into React. Wave-0 shell is intentionally inert.
export function App() {
  return (
    <div className="app-shell">
      <h1>Ho(a)rdish by Nature</h1>
      <p>Engine not yet mounted (Wave 0 foundation).</p>
    </div>
  );
}
