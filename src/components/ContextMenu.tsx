import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { UIIcon } from "./Icon";

export interface MenuItem {
  label: string;
  onClick: () => void;
  icon?: string;
  /** Image icon (e.g. from Windows' own menu), used when there's no `icon`. */
  iconUrl?: string;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string;
  divider?: boolean;
  /** Submenu, shown on hover. */
  children?: MenuItem[];
  /** Like `children`, fetched when the submenu first opens. */
  load?: () => Promise<MenuItem[]>;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  /** Icon buttons across the top (Cut, Copy, Rename, Delete), like Windows 11. */
  bar?: MenuItem[];
  onClose: () => void;
}

export const DIVIDER: MenuItem = { divider: true, label: "", onClick: () => {} };

const HOVER_MS = 140; // delay before a submenu opens/switches, so passing over items doesn't flicker

const hasSubmenu = (it: MenuItem) => !!(it.children || it.load);

/** Drop leading/trailing/doubled dividers left by conditional items. */
const tidy = (items: MenuItem[]) =>
  items.filter((it, i, all) => !it.divider || (i > 0 && i < all.length - 1 && !all[i - 1].divider));

/** Keep a fixed-position element on screen (flipping a submenu to the left if needed). */
function place(el: HTMLElement, left: number, top: number, flipLeft?: number) {
  const { width, height } = el.getBoundingClientRect();
  if (left + width > window.innerWidth - 8) left = flipLeft ?? window.innerWidth - width - 8;
  if (top + height > window.innerHeight - 8) top = window.innerHeight - height - 8;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

function Row({ it, open, onActivate }: { it: MenuItem; open: boolean; onActivate: () => void }) {
  return (
    <button
      className={`menu-item ${it.danger ? "danger" : ""} ${open ? "open" : ""}`}
      disabled={it.disabled}
      onClick={onActivate}
    >
      <span className="menu-icon">
        {it.icon ? (
          <UIIcon name={it.icon} size={16} />
        ) : it.iconUrl ? (
          <img src={it.iconUrl} width={16} height={16} alt="" draggable={false} />
        ) : null}
      </span>
      <span className="menu-label">{it.label}</span>
      {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
      {hasSubmenu(it) && <span className="menu-arrow">›</span>}
    </button>
  );
}

/** A list of items; hovering one with a submenu opens it beside the item. */
function Items({ items, onPick }: { items: MenuItem[]; onPick: (it: MenuItem) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const timer = useRef<number>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const hoverTo = (i: number | null) => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(i), HOVER_MS);
  };

  return (
    <>
      {tidy(items).map((it, i) =>
        it.divider ? (
          <div key={i} className="menu-divider" />
        ) : (
          <div key={i} className="menu-entry" onMouseEnter={() => hoverTo(hasSubmenu(it) ? i : null)}>
            <Row
              it={it}
              open={open === i}
              onActivate={() => {
                if (!hasSubmenu(it)) return onPick(it);
                clearTimeout(timer.current);
                setOpen(i);
              }}
            />
            {open === i && <Flyout item={it} onPick={onPick} />}
          </div>
        )
      )}
    </>
  );
}

/** Submenu panel next to its parent item; loads its items if needed. */
function Flyout({ item, onPick }: { item: MenuItem; onPick: (it: MenuItem) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<MenuItem[] | null>(item.children ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (item.children) return;
    let live = true;
    item.load!().then(
      (loaded) => live && setItems(loaded),
      (e) => live && setError(String(e))
    );
    return () => {
      live = false;
    };
  }, [item]);

  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = el?.parentElement?.getBoundingClientRect();
    if (!el || !anchor) return;
    const width = el.getBoundingClientRect().width;
    place(el, anchor.right - 2, anchor.top - 5, anchor.left - width + 2);
  }, [items, error]);

  return (
    <div ref={ref} className="context-menu flyout">
      {!items && !error && <div className="menu-note">Loading…</div>}
      {error && <div className="menu-note error-text">{error}</div>}
      {items?.length === 0 && <div className="menu-note">Nothing here</div>}
      {items && items.length > 0 && <Items items={items} onPick={onPick} />}
    </div>
  );
}

export function ContextMenu({ x, y, items, bar, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Any press outside the menu (including on another file) closes it.
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation(); // closing the menu shouldn't also clear the selection
      onClose();
    };
    window.addEventListener("mousedown", outside, true);
    window.addEventListener("keydown", esc, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    const scroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose(); // long submenus may scroll themselves
    };
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("mousedown", outside, true);
      window.removeEventListener("keydown", esc, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    if (ref.current) place(ref.current, x, y);
  }, [x, y]);

  const pick = (it: MenuItem) => {
    onClose();
    it.onClick();
  };

  return (
    <div ref={ref} className="context-menu" style={{ left: x, top: y }} onContextMenu={(e) => e.preventDefault()}>
      {bar && bar.length > 0 && (
        <div className="menu-bar">
          {bar.map((it) => (
            <button
              key={it.label}
              className={`menu-bar-btn ${it.danger ? "danger" : ""}`}
              disabled={it.disabled}
              title={it.shortcut ? `${it.label} (${it.shortcut})` : it.label}
              onClick={() => pick(it)}
            >
              {it.icon && <UIIcon name={it.icon} size={17} />}
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
      <Items items={items} onPick={pick} />
    </div>
  );
}
