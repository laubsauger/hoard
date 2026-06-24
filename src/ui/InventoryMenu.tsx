// T62 / V1 / V11 — inventory menu. Dual-pane (player ↔ nearby container) over the inventory-view store.
// `I` toggles it, `Esc` closes. Click an item to transfer the stack (loot from the container → player, or
// store player → container). Reads narrow store selectors; never per-frame world state. Item names come
// from the T83 catalog. The player + container contents are the sim's LIVE inventory (runtime.inventorySnapshot()
// published by GameViewport) — NO UI mock seed; a container shows only when actually opened via the loot verb.

import { useEffect } from 'react';
import { useUi, useInventoryView } from '../stores/react';
import { uiStore } from '../stores/ui';
import { inventoryViewStore, type ContainerView } from '../stores/inventoryView';
import { buildDefaultCatalog, isConsumable } from '../game/inventory';
import type { EngineHandle } from './viewport/engineHandle';

const CATALOG = buildDefaultCatalog();
function itemName(id: number): string {
  try {
    return CATALOG.get(id as never).name;
  } catch {
    return `#${id}`;
  }
}
function itemCategory(id: number): string {
  try {
    return CATALOG.get(id as never).category;
  } catch {
    return 'misc';
  }
}


function weightOf(slots: ContainerView['slots']): number {
  return slots.reduce((w, s) => {
    try {
      return w + CATALOG.get(s.item as never).weightKg * s.count;
    } catch {
      return w;
    }
  }, 0);
}

function Pane({
  view,
  onItemClick,
  action,
  onUse,
}: {
  view: ContainerView | undefined;
  onItemClick: (item: number) => void;
  action: string;
  /** T138: when set, a CONSUMABLE item also gets a "Use" button (eat/drink/treat) — only the player pane wires it. */
  onUse?: (item: number) => void;
}) {
  if (!view) return <div className="hbn-inv__pane hbn-inv__pane--empty">nothing nearby</div>;
  return (
    <div className="hbn-inv__pane">
      <header className="hbn-inv__pane-head">
        <span className="hbn-inv__pane-title">{view.container === 'player' ? 'Inventory' : view.container}</span>
        <span className="hbn-inv__weight">{weightOf(view.slots).toFixed(1)} kg</span>
      </header>
      <ul className="hbn-inv__list">
        {view.slots.length === 0 && <li className="hbn-inv__empty">empty</li>}
        {view.slots.map((s) => (
          <li key={s.item} className="hbn-inv__row">
            <button type="button" className={`hbn-inv__item cat-${itemCategory(s.item)}`} onClick={() => onItemClick(s.item)} title={action}>
              <span className="hbn-inv__name">{itemName(s.item)}</span>
              {s.count > 1 && <span className="hbn-inv__count">×{s.count}</span>}
              <span className="hbn-inv__action">{action}</span>
            </button>
            {onUse && isConsumable(s.item) && (
              <button type="button" className="hbn-inv__use" onClick={() => onUse(s.item)} title="Use this item">
                use
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function InventoryMenu({ handle }: { handle: EngineHandle | null }) {
  const open = useUi((s) => s.activePanel === 'inventory');
  const containers = useInventoryView((s) => s.containers);
  const openContainer = useInventoryView((s) => s.openContainer);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'KeyI') {
        e.preventDefault();
        const cur = uiStore.getState().activePanel;
        // Manual inventory (T62): PLAYER-only. The real player + container contents are the sim's
        // `runtime.inventorySnapshot()` (GameViewport publishes it live) — there is NO mock seed. Clear the open
        // container + loot anchor so manual `I` shows ONLY the player and never a stale / auto-picked container
        // (the scene's real "Kitchen Cupboard" was being grabbed by the otherName fallback). A real container
        // shows only via the "Open / Loot" verb, which sets the open container + anchor (engineHandle.loot).
        inventoryViewStore.getState().setOpenContainer(null);
        inventoryViewStore.getState().setLootAnchor(null);
        uiStore.getState().openPanel(cur === 'inventory' ? 'none' : 'inventory');
      } else if (e.code === 'Escape' && uiStore.getState().activePanel === 'inventory') {
        inventoryViewStore.getState().setLootAnchor(null);
        uiStore.getState().closePanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) return null;
  const player = containers.find((c) => c.container === 'player');
  // Show the OPEN container only (the looted one, set by the Open/Loot verb). NO fallback to "first non-player
  // container" — that auto-picked the scene's real "Kitchen Cupboard" so manual `I` always showed it.
  const otherName = openContainer ?? '';
  const other = containers.find((c) => c.container === otherName);

  return (
    <div className="hbn-inv" role="dialog" aria-label="Inventory">
      <div className="hbn-inv__frame">
        <Pane
          view={player}
          action="store ▸"
          onItemClick={(item) => other && inventoryViewStore.getState().transfer('player', other.container, item)}
          onUse={(item) => handle?.useItem(item)}
        />
        <Pane view={other} action="◂ take" onItemClick={(item) => player && inventoryViewStore.getState().transfer(other!.container, 'player', item)} />
      </div>
      <p className="hbn-inv__hint">I / Esc to close · click to transfer · “use” to eat / drink / bandage</p>
    </div>
  );
}
