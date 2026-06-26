// T62 / V1 / V11 — inventory menu. Dual-pane (player ↔ nearby container) over the inventory-view store.
// `I` toggles it, `Esc` closes. Click an item to transfer the stack (loot from the container → player, or
// store player → container). Reads narrow store selectors; never per-frame world state. Item names come
// from the T83 catalog. The player + container contents are the sim's LIVE inventory (runtime.inventorySnapshot()
// published by GameViewport) — NO UI mock seed; a container shows only when actually opened via the loot verb.

import { useCallback, useEffect, useState } from 'react';
import { useUi, useInventoryView } from '../stores/react';
import { uiStore } from '../stores/ui';
import { inventoryViewStore, type ContainerView } from '../stores/inventoryView';
import type { CraftActionView } from '../stores/craftingView';
import { buildDefaultCatalog, isConsumable, isEquippable, ITEM } from '../game/inventory';
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
  /** T140: one-click equip+draw a weapon/tool/throwable (player pane only). Null hides the equip button. */
  onEquip?: (item: number) => void;
  /** T85: drop an item onto the floor (player pane only). Null hides the drop button. */
  onDrop?: (item: number) => void;
}) {
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
          const canEquip = onEquip && isEquippable(s.item);
          return (
            <li key={s.item} className="hbn-inv__row">
              <button type="button" className={`hbn-inv__item cat-${itemCategory(s.item)}`} onClick={() => onItemClick(s.item)} title={action}>
                <span className="hbn-inv__name">{itemName(s.item)}</span>
                {s.count > 1 && <span className="hbn-inv__count">×{s.count}</span>}
                <span className="hbn-inv__action">{action}</span>
              </button>
              {/* Actions wrap onto their own row so nothing is clipped by the pane width. */}
              {(extra || canEquip || onDrop) && (
                <div className="hbn-inv__actions">
                  {canEquip && (
                    <button type="button" className="hbn-inv__use hbn-inv__equip" onClick={() => onEquip?.(s.item)} title="equip + ready it in hand">
                      equip
                    </button>
                  )}
                  {extra && (
                    <button type="button" className="hbn-inv__use" onClick={extra.onClick} title={extra.label}>
                      {extra.label}
                    </button>
                  )}
                  {onDrop && (
                    <button type="button" className="hbn-inv__use hbn-inv__drop" onClick={() => onDrop(s.item)} title="drop on the floor">
                      drop
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** T24 — the Craft tab: the recipe list the engine computes from the live pack (label + availability + reason).
 *  Polls `handle.craftables()` on open + after each craft so the list reflects the consumed/produced items. */
function CraftPanel({ handle }: { handle: EngineHandle | null }) {
  const [rows, setRows] = useState<readonly CraftActionView[]>([]);
  const refresh = useCallback(() => setRows(handle?.craftables() ?? []), [handle]);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return (
    <div className="hbn-inv__craft">
      {rows.length === 0 && <p className="hbn-inv__empty">no recipes</p>}
      <ul className="hbn-inv__craftlist">
        {rows.map((r) => (
          <li key={r.id} className="hbn-inv__craftrow">
            <span className="hbn-inv__craftlabel">{r.label}</span>
            <button
              type="button"
              className="hbn-inv__use hbn-inv__craftbtn"
              disabled={!r.available}
              title={r.available ? 'craft this' : r.reason ?? 'unavailable'}
              onClick={() => {
                handle?.craft(r.id);
                refresh();
              }}
            >
              {r.available ? 'craft' : r.reason ?? 'n/a'}
            </button>
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
  const [tab, setTab] = useState<'items' | 'craft'>('items');

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
      <div className="hbn-inv__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'items'} className={`hbn-inv__tab${tab === 'items' ? ' is-active' : ''}`} onClick={() => setTab('items')}>
          Inventory
        </button>
        <button type="button" role="tab" aria-selected={tab === 'craft'} className={`hbn-inv__tab${tab === 'craft' ? ' is-active' : ''}`} onClick={() => setTab('craft')}>
          Craft
        </button>
      </div>
      {tab === 'items' ? (
        <div className="hbn-inv__frame">
          <Pane
            view={player}
            action="store ▸"
            onItemClick={(item) => other && inventoryViewStore.getState().transfer('player', other.container, item)}
            extraAction={(item) => {
              if (isConsumable(item)) return { label: 'use', onClick: () => handle?.useItem(item) };
              if (item === ITEM.Grenade || item === ITEM.Molotov) return { label: 'throw', onClick: () => handle?.throwGrenade() };
              if (item === ITEM.Torch) return { label: 'place', onClick: () => handle?.placeTorch() };
              if (item === ITEM.Backpack) {
                const worn = handle?.isBackpackEquipped() ?? false;
                return { label: worn ? 'remove' : 'wear', onClick: () => (worn ? handle?.unequipBackpack() : handle?.equipBackpack()) };
              }
              return null;
            }}
            onEquip={(item) => handle?.equipAndDraw(item)}
            onDrop={(item) => handle?.drop(item)}
          />
          <Pane view={other} action="◂ take" onItemClick={(item) => player && inventoryViewStore.getState().transfer(other!.container, 'player', item)} />
        </div>
      ) : (
        <CraftPanel handle={handle} />
      )}
      <p className="hbn-inv__hint">
        {tab === 'items'
          ? 'I / Esc to close · click to transfer · “equip” readies a weapon/grenade · “use” / “throw” / “drop”'
          : 'I / Esc to close · craft assembles items from your pack (needs the listed materials + any tool)'}
      </p>
    </div>
  );
}
