import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Entry, SortDir, SortKey, ViewMode } from "../types";
import { formatSize, formatDate, iconFor } from "../util";
import { hasThumb, thumbUrl, whenVisible } from "../thumbs";
import { beginDrag } from "../dnd";
import { Icon } from "./Icon";

interface Props {
  cwd: string;
  entries: Entry[];
  view: ViewMode;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  /** Group heading for an entry; entries arrive already ordered by group. */
  groupOf: ((e: Entry) => string) | null;
  selected: Set<string>;
  cutPaths: Set<string>;
  renamingPath: string | null;
  loading: boolean;
  error: string | null;
  searchMode: boolean;
  onItemClick: (entry: Entry, e: React.MouseEvent) => void;
  onItemDoubleClick: (entry: Entry) => void;
  onItemMiddleClick: (entry: Entry) => void;
  onItemContextMenu: (entry: Entry, e: React.MouseEvent) => void;
  onBackgroundClick: () => void;
  onBackgroundContextMenu: (e: React.MouseEvent) => void;
  onRenameSubmit: (path: string, newName: string) => void;
  onRenameCancel: () => void;
  dragPathsFor: (entry: Entry) => string[];
  /** Item whose right-click menu is open (outlined, not selected). */
  menuTarget: string | null;
  /** Scroll this item into view (n changes on every request). */
  reveal: { path: string; n: number } | null;
  /** Items per row, for keyboard navigation in grid view. */
  onColumns: (cols: number) => void;
}

function RenameInput({
  entry,
  onSubmit,
  onCancel,
}: {
  entry: Entry;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false); // guard against blur firing after Enter/Escape
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the name without the extension.
    const dot = entry.name.lastIndexOf(".");
    if (!entry.is_dir && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [entry.name, entry.is_dir]);

  return (
    <input
      ref={ref}
      className="rename-input"
      defaultValue={entry.name}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        if (done.current) return;
        done.current = true;
        onSubmit(e.target.value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          done.current = true;
          onSubmit((e.target as HTMLInputElement).value);
        }
        if (e.key === "Escape") {
          done.current = true;
          onCancel();
        }
      }}
    />
  );
}

/** Shell thumbnail, requested only once it scrolls near view; the icon shows until it lands. */
function Thumb({ entry, px, fallback }: { entry: Entry; px: number; fallback: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<"wait" | "ok" | "fail">("wait");

  useEffect(() => {
    setState("wait");
    setSrc(null);
    const el = ref.current;
    return el ? whenVisible(el, () => setSrc(thumbUrl(entry, px))) : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.path, entry.modified, px]);

  return (
    <div ref={ref} className="thumb-box">
      {state !== "ok" && fallback}
      {src && state !== "fail" && (
        <img
          className={`thumb ${state === "ok" ? "in" : ""}`}
          src={src}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => setState("ok")}
          onError={() => setState("fail")}
        />
      )}
    </div>
  );
}

// Requested thumbnail sizes (device pixels) for each view.
const GRID_PX = (window.devicePixelRatio || 1) > 1 ? 256 : 128;
const LIST_PX = Math.ceil(22 * Math.min(2, window.devicePixelRatio || 1));

// Virtual scrolling: only rows near the viewport are rendered, so a folder with
// tens of thousands of items costs the same as one with forty. Every row has a
// fixed height so positions can be computed without measuring.
const LIST_ROW_H = 36;
const GROUP_H = 40;
const CELL_MIN_W = 116;
const CELL_H = 140;
const GRID_GAP = 6;
const OVERSCAN = 480; // px rendered above and below the viewport
const BOTTOM_SPACE = 64; // empty space after the last item, to click and clear the selection

interface Row {
  top: number;
  height: number;
  head?: { label: string; count: number };
  items?: Entry[];
}

function buildRows(entries: Entry[], groupOf: ((e: Entry) => string) | null, grid: boolean, cols: number) {
  const rows: Row[] = [];
  const rowOf = new Map<string, number>();
  const per = grid ? cols : 1;
  const itemH = grid ? CELL_H + GRID_GAP : LIST_ROW_H;
  let top = 0;
  const pushItems = (list: Entry[]) => {
    for (let i = 0; i < list.length; i += per) {
      const items = list.slice(i, i + per);
      for (const e of items) rowOf.set(e.path, rows.length);
      rows.push({ top, height: itemH, items });
      top += itemH;
    }
  };
  if (groupOf) {
    // Entries arrive ordered by group; add a heading at each change.
    for (let i = 0; i < entries.length; ) {
      const label = groupOf(entries[i]);
      let j = i + 1;
      while (j < entries.length && groupOf(entries[j]) === label) j++;
      rows.push({ top, height: GROUP_H, head: { label, count: j - i } });
      top += GROUP_H;
      pushItems(entries.slice(i, j));
      i = j;
    }
  } else {
    pushItems(entries);
  }
  return { rows, rowOf, height: top + BOTTOM_SPACE };
}

export function FileView(p: Props) {
  const [, setTick] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 900, width: 1000 });
  const grid = p.view === "grid";
  const showing = !p.loading && !p.error && p.entries.length > 0;

  // Track scroll position and size (throttled to one update per frame).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const body = bodyRef.current;
      setViewport({
        top: el.scrollTop - (body?.offsetTop ?? 0),
        height: el.clientHeight,
        width: body?.clientWidth ?? el.clientWidth,
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [showing, grid]);

  const cols = Math.max(1, Math.floor((viewport.width + GRID_GAP) / (CELL_MIN_W + GRID_GAP)));
  const { onColumns } = p;
  useEffect(() => onColumns(grid ? cols : 1), [grid, cols, onColumns]);

  const layout = useMemo(
    () => buildRows(p.entries, p.groupOf, grid, cols),
    [p.entries, p.groupOf, grid, cols]
  );

  /** Scroll just enough to show `path` (it may not be rendered yet). */
  const revealPath = (path: string) => {
    const el = scrollRef.current;
    const r = layout.rowOf.get(path);
    if (!el || r === undefined) return;
    const row = layout.rows[r];
    const offset = bodyRef.current?.offsetTop ?? 0;
    const header = el.querySelector<HTMLElement>(".list-head")?.offsetHeight ?? 0; // sticky
    const top = offset + row.top;
    if (top - header < el.scrollTop) el.scrollTop = top - header;
    else if (top + row.height > el.scrollTop + el.clientHeight) el.scrollTop = top + row.height - el.clientHeight;
  };
  useEffect(() => {
    if (p.reveal) revealPath(p.reveal.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.reveal]);
  useEffect(() => {
    if (p.renamingPath) revealPath(p.renamingPath); // e.g. a new folder at the end of a long list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.renamingPath]);

  if (p.loading) return <div className="file-area empty">Loading…</div>;
  if (p.error)
    return (
      <div className="file-area empty error-text" onClick={p.onBackgroundClick}>
        {p.error}
      </div>
    );
  if (p.entries.length === 0)
    return (
      <div
        className="file-area empty"
        data-drop={p.cwd}
        onClick={p.onBackgroundClick}
        onContextMenu={p.onBackgroundContextMenu}
      >
        {p.searchMode ? "No matches found" : "This folder is empty"}
      </div>
    );

  // The date column shows whichever date the folder is sorted by.
  const showCreated = p.sortKey === "created";

  const item = (entry: Entry, style?: React.CSSProperties) => {
    const sel = p.selected.has(entry.path);
    const cut = p.cutPaths.has(entry.path);
    const spec = iconFor(entry);
    const renaming = p.renamingPath === entry.path;
    const cls = `${sel ? "selected" : ""} ${cut ? "cut" : ""} ${entry.hidden ? "is-hidden" : ""} ${
      p.menuTarget === entry.path ? "menu-target" : ""
    }`;

    const label = renaming ? (
      <RenameInput
        entry={entry}
        onSubmit={(name) => {
          if (name && name !== entry.name) p.onRenameSubmit(entry.path, name);
          else p.onRenameCancel();
          setTick((t) => t + 1);
        }}
        onCancel={p.onRenameCancel}
      />
    ) : (
      <span className="item-name" title={entry.name}>
        {entry.name}
      </span>
    );

    const handlers = {
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!renaming) p.onItemClick(entry, e);
      },
      onDoubleClick: (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!renaming) p.onItemDoubleClick(entry);
      },
      onMouseDown: (e: React.MouseEvent) => {
        if (e.button === 1) e.preventDefault(); // no autoscroll on middle-click
        if (!renaming) beginDrag(e, () => p.dragPathsFor(entry));
      },
      onAuxClick: (e: React.MouseEvent) => {
        if (e.button === 1 && !renaming) p.onItemMiddleClick(entry);
      },
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!renaming) p.onItemContextMenu(entry, e);
      },
      "data-drop": entry.is_dir ? entry.path : undefined,
      "data-path": entry.path,
    };

    if (p.view === "grid") {
      const icon = <Icon glyph={spec.glyph} color={spec.color} size={44} />;
      return (
        <div key={entry.path} className={`grid-cell ${cls}`} {...handlers}>
          <div className="grid-icon">
            {hasThumb(entry) ? <Thumb entry={entry} px={GRID_PX} fallback={icon} /> : icon}
          </div>
          {label}
        </div>
      );
    }
    const icon = <Icon glyph={spec.glyph} color={spec.color} size={20} />;
    return (
      <div key={entry.path} className={`list-row ${cls}`} style={style} {...handlers}>
        <div className="col-name">
          <span className="list-icon">
            {hasThumb(entry) ? <Thumb entry={entry} px={LIST_PX} fallback={icon} /> : icon}
          </span>
          {label}
        </div>
        <div className="col-date">
          {p.searchMode ? "" : formatDate(showCreated ? entry.created : entry.modified)}
        </div>
        <div className="col-type">{entry.is_dir ? "Folder" : entry.extension ? entry.extension.toUpperCase() : "File"}</div>
        <div className="col-size">{formatSize(entry.size)}</div>
      </div>
    );
  };

  // Only the rows overlapping the viewport (plus some overscan) are rendered.
  const { rows, height } = layout;
  const from = viewport.top - OVERSCAN;
  const to = viewport.top + viewport.height + OVERSCAN;
  let first = 0;
  for (let hi = rows.length; first < hi; ) {
    const mid = (first + hi) >> 1;
    if (rows[mid].top + rows[mid].height < from) first = mid + 1;
    else hi = mid;
  }
  const rendered: React.ReactNode[] = [];
  for (let i = first; i < rows.length && rows[i].top <= to; i++) {
    const row = rows[i];
    const pos = { top: row.top, height: row.height };
    if (row.head) {
      rendered.push(
        <div key={`group:${row.head.label}`} className="group-head" style={pos}>
          {row.head.label}
          <span className="group-count">{row.head.count}</span>
        </div>
      );
    } else if (grid) {
      rendered.push(
        <div
          key={`row:${row.items![0].path}`}
          className="grid-row"
          style={{ ...pos, height: CELL_H, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {row.items!.map((e) => item(e))}
        </div>
      );
    } else {
      rendered.push(item(row.items![0], pos));
    }
  }
  const body = (
    <div ref={bodyRef} className={grid ? "grid" : "list"} style={{ height }}>
      {rendered}
    </div>
  );

  const areaProps = {
    ref: scrollRef,
    className: "file-area",
    "data-drop": p.cwd,
    onClick: p.onBackgroundClick,
    onContextMenu: p.onBackgroundContextMenu,
  };

  if (grid) return <div {...areaProps}>{body}</div>;

  const head = (key: SortKey, label: string, className: string) => (
    <button
      className={`${className} head-btn ${p.sortKey === key ? "sorted" : ""}`}
      onClick={(e) => {
        e.stopPropagation(); // keep the selection
        p.onSort(key);
      }}
      title={`Sort by ${label.toLowerCase()}`}
    >
      {label}
      {p.sortKey === key && <span className="sort-arrow">{p.sortDir === "asc" ? "▲" : "▼"}</span>}
    </button>
  );

  return (
    <div {...areaProps}>
      <div className="list-head">
        {head("name", "Name", "col-name")}
        {showCreated ? head("created", "Created", "col-date") : head("modified", "Modified", "col-date")}
        {head("type", "Type", "col-type")}
        {head("size", "Size", "col-size")}
      </div>
      {body}
    </div>
  );
}
