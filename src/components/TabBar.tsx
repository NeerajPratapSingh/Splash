import { useEffect, useRef } from "react";
import type { Tab } from "../types";
import { basename, isDriveRoot } from "../util";
import { UIIcon } from "./Icon";

interface Props {
  tabs: Tab[];
  active: number;
  split: boolean;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  /** Hover button: split view with this tab, or move it to the other pane when split. */
  onSplit: (id: number) => void;
  onNew: () => void;
}

export function TabBar(p: Props) {
  const strip = useRef<HTMLDivElement>(null);

  // Keep the active tab visible when there are more tabs than fit.
  useEffect(() => {
    strip.current?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [p.active, p.tabs.length]);

  return (
    <div className="tabbar">
      <div
        ref={strip}
        className="tab-strip"
        onWheel={(e) => {
          // Vertical wheel scrolls the tabs sideways.
          if (strip.current && e.deltaY) strip.current.scrollLeft += e.deltaY;
        }}
      >
      {p.tabs.map((t) => {
        const drive = isDriveRoot(t.path);
        return (
          <div
            key={t.id}
            className={`tab ${t.id === p.active ? "active" : ""}`}
            title={t.path}
            data-drop={t.path}
            onClick={() => p.onSelect(t.id)}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onAuxClick={(e) => e.button === 1 && p.onClose(t.id)}
          >
            <span className="tab-icon">
              <UIIcon name={drive ? "drive" : "folder"} size={14} />
            </span>
            <span className="tab-title">{drive ? t.path.slice(0, 2) : basename(t.path)}</span>
            <button
              className="tab-btn tab-split"
              title={p.split ? "Move to other pane" : "Split view with this tab"}
              onClick={(e) => {
                e.stopPropagation();
                p.onSplit(t.id);
              }}
            >
              <UIIcon name={p.split ? "other-pane" : "split"} size={13} />
            </button>
            <button
              className="tab-btn tab-close"
              title="Close tab (Ctrl+W)"
              onClick={(e) => {
                e.stopPropagation();
                p.onClose(t.id);
              }}
            >
              <UIIcon name="x" size={13} />
            </button>
          </div>
        );
      })}
      </div>
      <button className="tab-new" title="New tab (Ctrl+T)" onClick={p.onNew}>
        <UIIcon name="plus" size={15} />
      </button>
    </div>
  );
}
