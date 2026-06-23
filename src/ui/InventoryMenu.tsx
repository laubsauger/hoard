// T62 / V1 / V11 — inventory menu. Dual-pane (player ↔ nearby container) over the inventory-view store.
// `I` toggles it, `Esc` closes. Click an item to transfer the stack (loot from the container → player, or
// store player → container). Reads narrow store selectors; never per-frame world state. Item names come
// from the T83 catalog. Seeded with real loot (T84) on first open until the sim publishes live inventory.

import { useEffect } from 'react';
import { useUi, useInventoryView } from '../stores/react';
import { uiStore } from '../stores/ui';
import { inventoryViewStore, type ContainerView } from '../stores/inventoryView';
import { buildDefaultCatalog, ITEM, rollLoot } from '../game/inventory';

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

/** Seeded PRNG (mulberry32) so the demo loot is stable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

/** First-open seed: a starting player kit + a lootable kitchen cupboard (real T84 loot). */
function seedIfEmpty(): void {
  if (inventoryViewStore.getState().containers.length > 0) return;
  const playerSlots = [
    { item: ITEM.KitchenKnife, count: 1 },
    { item: ITEM.Bandage, count: 2 },
    { item: ITEM.WaterBottle, count: 1 },
  ];
  const cupboardSlots = rollLoot('kitchen', mulberry32(0xc0ffee)).map((s) => ({ item: s.item as number, count: s.count }));
  inventoryViewStore.getState().setContainers([
    { container: 'player', capacity: 12, weight: weightOf(playerSlots), slots: playerSlots },
    { container: 'Kitchen Cupboard', capacity: 50, weight: weightOf(cupboardSlots), slots: cupboardSlots },
  ]);
  inventoryViewStore.getState().setOpenContainer('Kitchen Cupboard');
}

function Pane({
  view,
  onItemClick,
  action,
}: {
  view: ContainerView | undefined;
  onItemClick: (item: number) => void;
  action: string;
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
          <li key={s.item}>
            <button type="button" className={`hbn-inv__item cat-${itemCategory(s.item)}`} onClick={() => onItemClick(s.item)} title={action}>
              <span className="hbn-inv__name">{itemName(s.item)}</span>
              {s.count > 1 && <span className="hbn-inv__count">×{s.count}</span>}
              <span className="hbn-inv__action">{action}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function InventoryMenu() {
  const open = useUi((s) => s.activePanel === 'inventory');
  const containers = useInventoryView((s) => s.containers);
  const openContainer = useInventoryView((s) => s.openContainer);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'KeyI') {
        e.preventDefault();
        seedIfEmpty();
        const cur = uiStore.getState().activePanel;
        uiStore.getState().openPanel(cur === 'inventory' ? 'none' : 'inventory');
      } else if (e.code === 'Escape' && uiStore.getState().activePanel === 'inventory') {
        uiStore.getState().closePanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) return null;
  const player = containers.find((c) => c.container === 'player');
  const otherName = openContainer ?? containers.find((c) => c.container !== 'player')?.container ?? '';
  const other = containers.find((c) => c.container === otherName);

  return (
    <div className="hbn-inv" role="dialog" aria-label="Inventory">
      <div className="hbn-inv__frame">
        <Pane view={player} action="store ▸" onItemClick={(item) => other && inventoryViewStore.getState().transfer('player', other.container, item)} />
        <Pane view={other} action="◂ take" onItemClick={(item) => player && inventoryViewStore.getState().transfer(other!.container, 'player', item)} />
      </div>
      <p className="hbn-inv__hint">I / Esc to close · click an item to transfer</p>
    </div>
  );
}
