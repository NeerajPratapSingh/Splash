import { useEffect, useRef } from "react";
import type { FolderView, GroupBy, Kind, SortKey } from "../types";
import { KINDS } from "../util";
import { DEFAULT_DIR, KEY_LABEL, orderLabel } from "../viewPrefs";
import { Breadcrumb } from "./Breadcrumb";
import { Dropdown, DDItem, DDLabel, DDDivider } from "./Dropdown";
import { UIIcon } from "./Icon";

interface Props {
  path: string;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onNavigate: (path: string) => void;
  onNewFolder: () => void;
  fv: FolderView;
  onView: (patch: Partial<FolderView>) => void;
  kindFilter: Kind | null;
  onKindFilter: (kind: Kind | null) => void;
  showHidden: boolean;
  onShowHidden: (on: boolean) => void;
  query: string;
  onQuery: (q: string) => void;
  onSubmitSearch: () => void;
  editingAddress: boolean;
  onEditAddress: (on: boolean) => void;
  onSubmitAddress: (text: string) => void;
  /** Showing Search this PC (not a folder). */
  pcSearch: boolean;
}

const SORT_KEYS: SortKey[] = ["name", "modified", "created", "size", "type"];
const GROUPS: { value: GroupBy; label: string }[] = [
  { value: "none", label: "None" },
  { value: "date", label: "Date" },
  { value: "type", label: "Type" },
];

/** Address bar: breadcrumbs, or a text box for typing/pasting a path. */
function Address(p: Props) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (p.editingAddress) input.current?.select();
  }, [p.editingAddress]);

  if (p.editingAddress)
    return (
      <div className="address editing">
        <input
          ref={input}
          className="address-input"
          defaultValue={p.path}
          spellCheck={false}
          autoFocus
          onBlur={() => p.onEditAddress(false)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") p.onSubmitAddress(e.currentTarget.value);
            if (e.key === "Escape") p.onEditAddress(false);
          }}
        />
      </div>
    );

  return (
    <div
      className="address"
      title="Click to type a path (Ctrl+L)"
      onClick={(e) => {
        if (!(e.target as Element).closest(".crumb")) p.onEditAddress(true);
      }}
    >
      <Breadcrumb path={p.path} onNavigate={p.onNavigate} />
    </div>
  );
}

/** Search this PC: the address bar itself is the (only) search box. */
function PcSearchBox(p: Props) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div className="address pc-search">
      <UIIcon name="search" size={16} />
      <input
        ref={input}
        className="address-input"
        placeholder="Search this PC: type a file or folder name"
        value={p.query}
        spellCheck={false}
        onChange={(e) => p.onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") p.onSubmitSearch();
          if (e.key === "Escape" && p.query) p.onQuery("");
        }}
      />
      {p.query && (
        <button className="search-clear" onClick={() => p.onQuery("")} title="Clear">
          <UIIcon name="x" size={14} />
        </button>
      )}
    </div>
  );
}

export function Toolbar(p: Props) {
  const { fv } = p;
  const filterLabel = p.kindFilter ? KINDS.find((k) => k.kind === p.kindFilter)!.label : "Filter";

  return (
    <div className="toolbar">
      <div className="toolbar-row">
        <div className="nav-buttons">
          <button className="icon-btn" disabled={!p.canBack} onClick={p.onBack} title="Back (Alt+←)">
            <UIIcon name="back" />
          </button>
          <button className="icon-btn" disabled={!p.canForward} onClick={p.onForward} title="Forward (Alt+→)">
            <UIIcon name="forward" />
          </button>
          <button className="icon-btn" onClick={p.onUp} title="Up (Alt+↑)">
            <UIIcon name="up" />
          </button>
          <button className="icon-btn" onClick={p.onRefresh} title="Refresh (F5)">
            <UIIcon name="refresh" />
          </button>
        </div>

        {p.pcSearch && !p.editingAddress ? <PcSearchBox {...p} /> : <Address {...p} />}

        {!p.pcSearch && (
          <div className="search">
            <span className="search-icon">
              <UIIcon name="search" size={16} />
            </span>
            <input
              placeholder="Search this folder"
              title="Type to filter; Enter searches subfolders too"
              value={p.query}
              onChange={(e) => p.onQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") p.onSubmitSearch();
              }}
            />
            {p.query && (
              <button className="search-clear" onClick={() => p.onQuery("")} title="Clear">
                <UIIcon name="x" size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="toolbar-row secondary">
        {!p.pcSearch && (
          <button className="text-btn" onClick={p.onNewFolder} title="New folder (Ctrl+Shift+N)">
            <UIIcon name="new-folder" size={16} /> New folder
          </button>
        )}

        <div className="spacer" />

        <Dropdown label={filterLabel} title="Filter by kind" active={!!p.kindFilter}>
          {(close) => (
            <>
              <DDLabel>Show</DDLabel>
              <DDItem checked={!p.kindFilter} onClick={() => (p.onKindFilter(null), close())}>
                All items
              </DDItem>
              {KINDS.filter((k) => k.kind !== "other").map((k) => (
                <DDItem
                  key={k.kind}
                  checked={p.kindFilter === k.kind}
                  onClick={() => (p.onKindFilter(k.kind), close())}
                >
                  {k.label}
                </DDItem>
              ))}
              <DDDivider />
              <DDItem checked={p.showHidden} onClick={() => p.onShowHidden(!p.showHidden)}>
                Show hidden items
              </DDItem>
            </>
          )}
        </Dropdown>

        <Dropdown
          title="Sort and group"
          label={
            <>
              <span className="dd-key">{KEY_LABEL[fv.sortKey]}</span>
              <span className="dd-order">{orderLabel(fv.sortKey, fv.sortDir)}</span>
            </>
          }
        >
          {() => (
            <>
              <DDLabel>Sort by</DDLabel>
              {SORT_KEYS.map((k) => (
                <DDItem
                  key={k}
                  checked={fv.sortKey === k}
                  onClick={() => p.onView({ sortKey: k, sortDir: DEFAULT_DIR[k] })}
                >
                  {KEY_LABEL[k]}
                </DDItem>
              ))}
              <DDDivider />
              <DDLabel>Order</DDLabel>
              {(["asc", "desc"] as const).map((d) => (
                <DDItem key={d} checked={fv.sortDir === d} onClick={() => p.onView({ sortDir: d })}>
                  {orderLabel(fv.sortKey, d)}
                </DDItem>
              ))}
              <DDDivider />
              <DDLabel>Group by</DDLabel>
              {GROUPS.map((g) => (
                <DDItem key={g.value} checked={fv.groupBy === g.value} onClick={() => p.onView({ groupBy: g.value })}>
                  {g.label}
                </DDItem>
              ))}
              <DDDivider />
              <DDItem checked={fv.foldersFirst} onClick={() => p.onView({ foldersFirst: !fv.foldersFirst })}>
                Folders first
              </DDItem>
            </>
          )}
        </Dropdown>

        <button
          className="icon-btn"
          onClick={() => p.onView({ view: fv.view === "grid" ? "list" : "grid" })}
          title="Toggle view (Ctrl+Shift+V)"
        >
          <UIIcon name={fv.view === "grid" ? "list" : "grid"} />
        </button>
      </div>
    </div>
  );
}
