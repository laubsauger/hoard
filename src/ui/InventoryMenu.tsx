// T62 / V1 / V11 — inventory menu. Dual-pane (player ↔ nearby container) over the inventory-view store.
// `I` toggles it, `Esc` closes. Click an item to transfer the stack (loot from the container → player, or
// store player → container). Reads narrow store selectors; never per-frame world state. Item names come
// from the T83 catalog. The player + container contents are the sim's LIVE inventory (runtime.inventorySnapshot()
// published by GameViewport) — NO UI mock seed; a container shows only when actually opened via the loot verb.

import { useEffect, useState } from 'react';
import { useUi, useInventoryView } from '../stores/react';
import { uiStore } from '../stores/ui';
import { inventoryViewStore, type ContainerView } from '../stores/inventoryView';
import { buildDefaultCatalog, isConsumable, ITEM, slotsForItem, SLOT_LABELS, type EquipSlot } from '../game/inventory';
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
  extraAction,
  onEquip,
  onDrop,
}: {
  view: ContainerView | undefined;
  onItemClick: (item: number) => void;
  action: string;
  /** T138/T139: optional per-item extra button — "use" a consumable, "wear"/"remove" a backpack. Player pane only. */
  extraAction?: (item: number) => { readonly label: string; readonly onClick: () => void } | null;
  /** T140: equip a weapon/tool into a belt slot (player pane only). Null disables the attach picker. */
  onEquip?: (item: number, slot: EquipSlot) => void;
  /** T85: drop an item onto the floor (player pane only). Null hides the drop button. */
  onDrop?: (item: number) => void;
}) {
  // T140: which row's "equip ▾" slot-picker is currently expanded (one at a time).
  const [attachItem, setAttachItem] = useState<number | null>(null);
  if (!view) return <div className="hbn-inv__pane hbn-inv__pane--empty">nothing nearby</div>;
  return (
    <div className="hbn-inv__pane">
      <header className="hbn-inv__pane-head">
        <span className="hbn-inv__pane-title">{view.container === 'player' ? 'Inventory' : view.container}</span>
        <span className="hbn-inv__weight">
          {weightOf(view.slots).toFixed(1)}
          {view.capacity > 0 ? ` / ${view.capacity}` : ''} kg
        </span>
      </header>
      <ul className="hbn-inv__list">
        {view.slots.length === 0 && <li className="hbn-inv__empty">empty</li>}
        {view.slots.map((s) => {
          const extra = extraAction?.(s.item) ?? null;
          const equipSlots = onEquip ? slotsForItem(s.item) : [];
          const attachOpen = attachItem === s.item;
          return (
            <li key={s.item} className="hbn-inv__row">
              <button type="button" className={`hbn-inv__item cat-${itemCategory(s.item)}`} onClick={() => onItemClick(s.item)} title={action}>
                <span className="hbn-inv__name">{itemName(s.item)}</span>
                {s.count > 1 && <span className="hbn-inv__count">×{s.count}</span>}
                <span className="hbn-inv__action">{action}</span>
              </button>
              {extra && (
                <button type="button" className="hbn-inv__use" onClick={extra.onClick} title={extra.label}>
                  {extra.label}
                </button>
              )}
              {equipSlots.length > 0 && (
                <button
                  type="button"
                  className={`hbn-inv__use${attachOpen ? ' is-open' : ''}`}
                  onClick={() => setAttachItem(attachOpen ? null : s.item)}
                  title="equip to a belt slot"
                >
                  equip ▾
                </button>
              )}
              {onDrop && (
                <button type="button" className="hbn-inv__use hbn-inv__drop" onClick={() => onDrop(s.item)} title="drop on the floor">
                  drop
                </button>
              )}
              {attachOpen && equipSlots.length > 0 && (
                <div className="hbn-inv__attach">
                  {equipSlots.map((sl) => (
                    <button
                      key={sl}
                      type="button"
                      className="hbn-inv__attach-slot"
                      onClick={() => {
                        onEquip?.(s.item, sl);
                        setAttachItem(null);
                      }}
                    >
                      {SLOT_LABELS[sl]}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
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
        if (uiStore.getState().activePanel === 'inventory') {
          inventoryViewStore.getState().setOpenContainer(null);
          inventoryViewStore.getState().setLootAnchor(null);
          uiStore.getState().closePanel();
          return;
        }
        // Opening (T62): show the nearest CONTAINER in reach + LOS in the right pane (open `I` beside a cupboard →
        // loot it directly). Range+LOS-gated in the sim, so a far cupboard is NOT auto-grabbed. Manual `I` does NOT
        // set lootAnchor — the render-loop proximity auto-close only fires for anchored (loot-verb) panels, so a
        // manual inventory ALWAYS opens + stays open until I/Esc, even when a NON-container (door/window) is the
        // nearest interactable (previously anchoring to the container made the door the nearest target → instant
        // auto-close → "can't open inventory near an interactable"). null container nearby = player-only pane.
        inventoryViewStore.getState().setOpenContainer(handle?.nearestContainer() ?? null);
        inventoryViewStore.getState().setLootAnchor(null);
        uiStore.getState().openPanel('inventory');
      } else if (e.code === 'Escape' && uiStore.getState().activePanel === 'inventory') {
        inventoryViewStore.getState().setOpenContainer(null);
        inventoryViewStore.getState().setLootAnchor(null);
        uiStore.getState().closePanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handle]);

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
          extraAction={(item) => {
            if (isConsumable(item)) return { label: 'use', onClick: () => handle?.useItem(item) };
            if (item === ITEM.Grenade) return { label: 'throw', onClick: () => handle?.throwGrenade() };
            if (item === ITEM.Backpack) {
              const worn = handle?.isBackpackEquipped() ?? false;
              return { label: worn ? 'remove' : 'wear', onClick: () => (worn ? handle?.unequipBackpack() : handle?.equipBackpack()) };
            }
            return null;
          }}
          onEquip={(item, slot) => handle?.equipItem(item, slot)}
          onDrop={(item) => handle?.drop(item)}
        />
        <Pane view={other} action="◂ take" onItemClick={(item) => player && inventoryViewStore.getState().transfer(other!.container, 'player', item)} />
      </div>
      <p className="hbn-inv__hint">I / Esc to close · click to transfer · “use” to eat / drink / bandage · “equip ▾” a weapon to a belt slot (draw with 1–4) · “wear” a pack</p>
    </div>
  );
}
