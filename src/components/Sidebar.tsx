import { useState } from "react";
import { SEARCH_PC, STORAGE, type DriveInfo, type QuickLink } from "../types";
import { folderLabel, formatSize, samePath } from "../util";
import { api } from "../api";
import { APP_VERSION, SUPPORT_URL } from "../config";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { UIIcon } from "./Icon";

/** Drive name with a usage bar and "X free of Y" underneath, like This PC. */
function DriveLabel({ d }: { d: DriveInfo }) {
  if (!d.total) return <>{d.name}</>;
  const used = (d.total - d.free) / d.total;
  return (
    <span className="drive-info">
      <span>{d.name}</span>
      <span className={`drive-bar ${used > 0.9 ? "full" : ""}`}>
        <span style={{ width: `${Math.round(used * 100)}%` }} />
      </span>
      <span className="drive-free">
        {formatSize(d.free)} free of {formatSize(d.total)}
      </span>
    </span>
  );
}

// Sidebar icon per quick-access folder kind.
const KIND_ICON: Record<string, string> = {
  home: "home",
  cloud: "cloud",
  desktop: "desktop",
  documents: "documents",
  downloads: "downloads",
  pictures: "pictures",
  music: "music",
  videos: "videos",
};

interface Props {
  quickLinks: QuickLink[];
  drives: DriveInfo[];
  pins: string[];
  currentPath: string;
  onNavigate: (path: string) => void;
  onOpenInNewTab: (path: string) => void;
  onUnpin: (path: string) => void;
  onMovePin: (path: string, delta: -1 | 1) => void;
  onOpenSettings: () => void;
}

export function Sidebar(p: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const isActive = (path: string) => samePath(p.currentPath, path);

  /** Shared behaviour for every sidebar entry. */
  const itemProps = (path: string, extraMenu: MenuItem[] = []) => ({
    onClick: () => p.onNavigate(path),
    onMouseDown: (e: React.MouseEvent) => e.button === 1 && e.preventDefault(),
    onAuxClick: (e: React.MouseEvent) => e.button === 1 && p.onOpenInNewTab(path),
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: "Open in new tab", icon: "new-tab", shortcut: "Middle-click", onClick: () => p.onOpenInNewTab(path) },
          ...extraMenu,
        ],
      });
    },
    title: path,
    "data-drop": path,
  });

  return (
    <aside className="sidebar">
      <button
        className={`side-item search-pc ${isActive(SEARCH_PC) ? "active" : ""}`}
        onClick={() => p.onNavigate(SEARCH_PC)}
        title="Find any file or folder on this PC by name (Ctrl+Shift+F)"
      >
        <span className="side-icon">
          <UIIcon name="search" size={16} />
        </span>
        Search this PC
      </button>
      <button
        className={`side-item ${isActive(STORAGE) ? "active" : ""}`}
        onClick={() => p.onNavigate(STORAGE)}
        title="See what's taking up space and clean up"
      >
        <span className="side-icon">
          <UIIcon name="storage" size={16} />
        </span>
        Storage
      </button>

      <div className="sidebar-title">Quick access</div>
      {p.quickLinks.map((q) => (
        <button key={q.path} className={`side-item ${isActive(q.path) ? "active" : ""}`} {...itemProps(q.path)}>
          <span className="side-icon">
            <UIIcon name={KIND_ICON[q.kind] ?? "folder"} size={16} />
          </span>
          {q.name}
        </button>
      ))}

      <div className="sidebar-title">Pinned</div>
      {p.pins.length === 0 && (
        <div className="sidebar-hint">Right-click a folder → Pin to sidebar</div>
      )}
      {p.pins.map((path, i) => (
        <button
          key={path}
          className={`side-item ${isActive(path) ? "active" : ""}`}
          {...itemProps(path, [
            { divider: true, label: "", onClick: () => {} },
            { label: "Move up", icon: "up", onClick: () => p.onMovePin(path, -1), disabled: i === 0 },
            { label: "Move down", icon: "down", onClick: () => p.onMovePin(path, 1), disabled: i === p.pins.length - 1 },
            { divider: true, label: "", onClick: () => {} },
            { label: "Unpin from sidebar", icon: "pin", onClick: () => p.onUnpin(path) },
          ])}
        >
          <span className="side-icon">
            <UIIcon name="folder" size={16} />
          </span>
          <span className="side-name">{folderLabel(path)}</span>
        </button>
      ))}

      <div className="sidebar-title">This PC</div>
      {p.drives.map((d) => (
        <button
          key={d.path}
          className={`side-item drive ${isActive(d.path) ? "active" : ""}`}
          {...itemProps(d.path)}
          title={d.total ? `${d.path} — ${Math.round(((d.total - d.free) / d.total) * 100)}% used` : d.path}
        >
          <span className="side-icon">
            <UIIcon name="drive" size={16} />
          </span>
          <DriveLabel d={d} />
        </button>
      ))}

      <div className="sidebar-footer">
        {SUPPORT_URL && (
          <button className="support-link" onClick={() => void api.openPath(SUPPORT_URL)} title={SUPPORT_URL}>
            ☕ Support Splash
          </button>
        )}
        <div className="footer-row">
          <button className="settings-btn" onClick={p.onOpenSettings} title="Settings">
            <UIIcon name="settings" size={15} /> Settings
          </button>
          <span className="app-version">Splash {APP_VERSION}</span>
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </aside>
  );
}
