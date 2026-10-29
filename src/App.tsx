import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { SEARCH_PC, isVirtual, type Entry, type DriveInfo, type QuickLink, type Clipboard, type PaneState, type Tab } from "./types";
import { basename, dirname, folderLabel, samePath } from "./util";
import { watchDrops, type OnDrop } from "./dnd";
import { Sidebar } from "./components/Sidebar";
import { Pane } from "./components/Pane";
import { QuickLook } from "./components/QuickLook";
import { Settings } from "./components/Settings";
import { Toast, type ToastAction, type ToastData } from "./components/Toast";
import { forgetTab, type ExplorerHandle } from "./components/Explorer";
import {
  loadPins,
  loadSearchIndex,
  loadShowHidden,
  savePins,
  saveSearchIndex,
  saveShowHidden,
  setDownloadsFolder,
} from "./viewPrefs";

let nextId = 1;
let toastId = 0;
const makeTab = (path: string): Tab => ({ id: nextId++, path });
const makePane = (tab: Tab): PaneState => ({ id: nextId++, tabs: [tab], active: tab.id });

export default function App() {
  const [quickLinks, setQuickLinks] = useState<QuickLink[]>([]);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [home, setHome] = useState("");

  // One pane, or two side by side (split view). Each pane has its own tabs.
  const [panes, setPanes] = useState<PaneState[]>([]);
  const [focused, setFocused] = useState(0);

  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [preview, setPreview] = useState<{ items: Entry[]; index: number } | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [showHidden, setShowHiddenState] = useState(loadShowHidden);
  const setShowHidden = useCallback((on: boolean) => {
    setShowHiddenState(on);
    saveShowHidden(on);
  }, []);

  // ---- sidebar pins ----
  const [pins, setPinsState] = useState<string[]>(loadPins);
  const setPins = (next: string[]) => {
    setPinsState(next);
    savePins(next);
  };
  const isPinned = useCallback((path: string) => pins.some((p) => samePath(p, path)), [pins]);
  const togglePin = useCallback(
    (path: string) => {
      const next = pins.some((p) => samePath(p, path))
        ? pins.filter((p) => !samePath(p, path))
        : [...pins, path];
      setPinsState(next);
      savePins(next);
    },
    [pins]
  );
  const movePin = (path: string, delta: -1 | 1) => {
    const i = pins.indexOf(path);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= pins.length) return;
    const next = [...pins];
    [next[i], next[j]] = [next[j], next[i]];
    setPins(next);
  };

  const explorers = useRef(new Map<number, ExplorerHandle>());
  const homeRef = useRef("");
  homeRef.current = home;

  // Initial load.
  useEffect(() => {
    (async () => {
      const [ql, dr, h, launched] = await Promise.all([
        api.quickLinks(),
        api.listDrives(),
        api.homeDir(),
        api.launchPath().catch(() => null),
      ]);
      const downloads = ql.find((q) => q.kind === "downloads");
      if (downloads) setDownloadsFolder(downloads.path);
      setQuickLinks(ql);
      setDrives(dr);
      const homePath = h || (dr[0]?.path ?? "");
      setHome(homePath);
      // Opened on a folder (e.g. by Windows, when Splash is the default) → start there.
      const start = launched || homePath;
      setPanes((ps) => (ps.length ? ps : [makePane(makeTab(start))]));
    })();
  }, []);

  // Drive usage bars: refresh after file operations (see refreshDirs), every
  // 30s, and when the window regains focus (space may change outside the app).
  const refreshDrives = useCallback(() => {
    api.listDrives().then(setDrives, () => {});
  }, []);
  useEffect(() => {
    const timer = setInterval(refreshDrives, 30_000);
    window.addEventListener("focus", refreshDrives);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshDrives);
    };
  }, [refreshDrives]);

  // Keep the focused index valid when a pane closes.
  useEffect(() => {
    if (panes.length && focused >= panes.length) setFocused(panes.length - 1);
  }, [panes.length, focused]);

  const show = useCallback(
    (kind: ToastData["kind"], text: string, actions?: ToastAction[]) =>
      setToast({ id: ++toastId, kind, text, actions }),
    []
  );
  const closeToast = useCallback(() => setToast(null), []);

  const split = panes.length > 1;
  const focusedPane = panes[Math.min(focused, panes.length - 1)];
  const activeTab = focusedPane?.tabs.find((t) => t.id === focusedPane.active);

  // ---- tab & pane operations ----
  const updatePane = (index: number, fn: (p: PaneState) => PaneState) =>
    setPanes((ps) => ps.map((p, i) => (i === index ? fn(p) : p)));

  const selectTab = (paneIndex: number, id: number) => {
    updatePane(paneIndex, (p) => ({ ...p, active: id }));
    setFocused(paneIndex);
  };

  const newTab = (paneIndex: number, path = homeRef.current, background = false) => {
    const tab = makeTab(path);
    updatePane(paneIndex, (p) => {
      const at = p.tabs.findIndex((t) => t.id === p.active) + 1;
      const tabs = [...p.tabs.slice(0, at), tab, ...p.tabs.slice(at)];
      return { ...p, tabs, active: background ? p.active : tab.id };
    });
  };

  const closeTab = (paneIndex: number, id: number) => {
    forgetTab(id);
    const replacement = makeTab(homeRef.current);
    setPanes((ps) => {
      const p = ps[paneIndex];
      if (!p) return ps;
      const idx = p.tabs.findIndex((t) => t.id === id);
      const tabs = p.tabs.filter((t) => t.id !== id);
      if (tabs.length === 0) {
        // Last tab: close the pane if split, otherwise keep one Home tab open.
        if (ps.length > 1) return ps.filter((_, i) => i !== paneIndex);
        tabs.push(replacement);
      }
      const active = p.active === id ? tabs[Math.min(idx, tabs.length - 1)].id : p.active;
      return ps.map((q, i) => (i === paneIndex ? { ...q, tabs, active } : q));
    });
  };

  /**
   * The split button on a tab. Not split yet: the hovered tab opens beside the
   * current one (or, on the current tab itself, a fresh Home tab opens beside
   * it). Already split: the tab moves to the other pane, and a pane left with
   * no tabs closes.
   */
  const splitTab = (paneIndex: number, id: number) => {
    const fresh = makeTab(homeRef.current);
    const fallbackPane = makePane(fresh);
    setPanes((ps) => {
      const src = ps[paneIndex];
      const tab = src?.tabs.find((t) => t.id === id);
      if (!src || !tab) return ps;

      if (ps.length === 1) {
        if (id === src.active || src.tabs.length === 1) return [src, fallbackPane];
        const rest = src.tabs.filter((t) => t.id !== id);
        return [{ ...src, tabs: rest }, { ...fallbackPane, tabs: [tab], active: tab.id }];
      }

      const destIndex = paneIndex === 0 ? 1 : 0;
      const rest = src.tabs.filter((t) => t.id !== id);
      const dest = ps[destIndex];
      const moved = { ...dest, tabs: [...dest.tabs, tab], active: tab.id };
      if (rest.length === 0) return [moved];
      const source = {
        ...src,
        tabs: rest,
        active: src.active === id ? rest[Math.max(0, src.tabs.indexOf(tab) - 1)].id : src.active,
      };
      return destIndex === 0 ? [moved, source] : [source, moved];
    });
    setFocused(panes.length === 1 ? 1 : paneIndex === 0 ? 1 : 0);
  };

  /** F3: open a second pane on Home, or fold the second pane's tabs back into the first. */
  const toggleSplit = () => {
    const fresh = makePane(makeTab(homeRef.current));
    setPanes((ps) => {
      if (ps.length === 1) return [ps[0], fresh];
      const [a, b] = ps;
      return [{ ...a, tabs: [...a.tabs, ...b.tabs] }];
    });
    setFocused(split ? 0 : 1);
  };

  const openInOtherPane = (fromPane: number, path: string) => {
    if (!split) {
      setPanes((ps) => [ps[0], makePane(makeTab(path))]);
    } else {
      newTab(fromPane === 0 ? 1 : 0, path);
    }
  };

  const cycleTab = (dir: 1 | -1) => {
    if (!focusedPane) return;
    const { tabs } = focusedPane;
    const i = tabs.findIndex((t) => t.id === focusedPane.active);
    selectTab(focused, tabs[(i + dir + tabs.length) % tabs.length].id);
  };

  // Stable callbacks: explorers depend on these in effects.
  const onPathChange = useCallback((tabId: number, path: string) => {
    setPanes((ps) => {
      let changed = false;
      const next = ps.map((p) => {
        if (!p.tabs.some((t) => t.id === tabId && t.path !== path)) return p;
        changed = true;
        return { ...p, tabs: p.tabs.map((t) => (t.id === tabId ? { ...t, path } : t)) };
      });
      return changed ? next : ps;
    });
  }, []);

  const refreshDirs = useCallback(
    (dirs: string[], exceptTab?: number) => {
      explorers.current.forEach((h, id) => id !== exceptTab && h.refreshIf(dirs));
      refreshDrives();
    },
    [refreshDrives]
  );

  const onFsChanged = useCallback(
    (tabId: number, dirs: string[]) => refreshDirs(dirs, tabId),
    [refreshDirs]
  );

  const onError = useCallback((message: string) => show("error", message), [show]);
  const onNotify = useCallback((message: string) => show("info", message), [show]);

  /**
   * A drop acts immediately with the smart default (move within a drive, copy
   * across drives), then says what happened and offers to change it. Anything
   * removed by those actions goes to the Recycle Bin.
   */
  const onDropPaths: OnDrop = useCallback(
    async (paths, kind, dest) => {
      const what = paths.length === 1 ? basename(paths[0]) : `${paths.length} items`;
      const where = folderLabel(dest);
      const sources = [...new Set(paths.map(dirname))];
      // Run a follow-up action, reporting failures instead of throwing.
      const attempt = (fn: () => Promise<void>) => async () => {
        try {
          await fn();
        } catch (e) {
          show("error", String(e));
        }
        refreshDirs([dest, ...sources]);
      };

      try {
        if (kind === "copy") {
          const copies = await api.copyEntries(paths, dest);
          refreshDirs([dest]);
          show("info", `Copied ${what} to ${where}`, [
            {
              label: "Move instead",
              run: attempt(async () => {
                await api.deleteToTrash(paths);
                show("info", `Moved ${what} to ${where}`);
              }),
            },
            {
              label: "Undo",
              run: attempt(async () => {
                await api.deleteToTrash(copies);
                show("info", "Copy undone");
              }),
            },
          ]);
        } else {
          const moved = await api.moveEntries(paths, dest);
          refreshDirs([dest, ...sources]);
          show("info", `Moved ${what} to ${where}`, [
            {
              label: "Undo",
              run: attempt(async () => {
                await api.restore(moved.map((m, i) => [m, paths[i]]));
                show("info", "Move undone");
              }),
            },
          ]);
        }
      } catch (e) {
        show("error", String(e));
        refreshDirs([dest, ...sources]);
      }
    },
    [refreshDirs, show]
  );

  // Native drops onto the window: from another pane or tab, or from Explorer.
  useEffect(() => watchDrops(onDropPaths), [onDropPaths]);

  // Auto-refresh: watch every folder open in a tab, reload tabs when one changes
  // outside the app (e.g. a download finishing).
  const openFolders = [...new Set(panes.flatMap((p) => p.tabs.map((t) => t.path)))]
    .filter((path) => !isVirtual(path))
    .sort()
    .join("\n");
  useEffect(() => {
    if (openFolders) api.watchDirs(openFolders.split("\n")).catch(() => {});
  }, [openFolders]);
  useEffect(() => {
    const unlisten = listen<string[]>("dir-changed", (e) => refreshDirs(e.payload));
    return () => void unlisten.then((f) => f());
  }, [refreshDirs]);

  // Splash launched again (a folder double-clicked while it's the default):
  // open that folder (or Home, for Win+E) as a new tab here.
  const openFromOutside = useRef<(path: string | null) => void>(() => {});
  openFromOutside.current = (path) => newTab(focused, path || homeRef.current);
  useEffect(() => {
    const unlisten = listen<string | null>("open-path", (e) => openFromOutside.current(e.payload));
    return () => void unlisten.then((f) => f());
  }, []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // Instant search (whole-PC name index): tell the backend the saved choice.
  const [searchIndex, setSearchIndexState] = useState(loadSearchIndex);
  useEffect(() => {
    api.setSearchIndex(searchIndex).catch(() => {});
  }, [searchIndex]);
  const setSearchIndex = (on: boolean) => {
    setSearchIndexState(on);
    saveSearchIndex(on);
  };

  const onPreview = useCallback(
    (items: Entry[], index: number) => setPreview({ items, index }),
    []
  );

  const explorerRef = useCallback((tabId: number, h: ExplorerHandle | null) => {
    if (h) explorers.current.set(tabId, h);
    else explorers.current.delete(tabId);
  }, []);

  const navigateFocused = (path: string) => {
    if (activeTab) explorers.current.get(activeTab.id)?.navigate(path);
  };

  // ---- app-level shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (e.ctrlKey && !e.shiftKey && key === "t") {
        e.preventDefault();
        newTab(focused);
      } else if (e.ctrlKey && key === "w") {
        e.preventDefault();
        if (focusedPane) closeTab(focused, focusedPane.active);
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
      } else if (e.key === "F3") {
        e.preventDefault();
        toggleSplit();
      } else if (e.ctrlKey && e.shiftKey && key === "f") {
        e.preventDefault();
        navigateFocused(SEARCH_PC);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const closePreview = useCallback(() => setPreview(null), []);

  return (
    <div className="app">
      <Sidebar
        quickLinks={quickLinks}
        drives={drives}
        pins={pins}
        currentPath={activeTab?.path ?? ""}
        onNavigate={navigateFocused}
        onOpenInNewTab={(path) => newTab(focused, path)}
        onUnpin={togglePin}
        onMovePin={movePin}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className={`panes ${split ? "split" : ""}`}>
        {panes.map((pane, i) => (
          <Pane
            key={pane.id}
            pane={pane}
            focused={i === focused}
            split={split}
            clipboard={clipboard}
            setClipboard={setClipboard}
            showHidden={showHidden}
            onShowHidden={setShowHidden}
            isPinned={isPinned}
            onTogglePin={togglePin}
            explorerRef={explorerRef}
            onFocus={() => i !== focused && setFocused(i)}
            onSelectTab={(id) => selectTab(i, id)}
            onCloseTab={(id) => closeTab(i, id)}
            onSplitTab={(id) => splitTab(i, id)}
            onNewTab={(path, background) => newTab(i, path, background)}
            onOpenInOtherPane={(path) => openInOtherPane(i, path)}
            onPathChange={onPathChange}
            onFsChanged={onFsChanged}
            onError={onError}
            onNotify={onNotify}
            onPreview={onPreview}
          />
        ))}
      </main>

      {preview && (
        <QuickLook items={preview.items} index={preview.index} onClose={closePreview} />
      )}
      {settingsOpen && (
        <Settings
          showHidden={showHidden}
          onShowHidden={setShowHidden}
          searchIndex={searchIndex}
          onSearchIndex={setSearchIndex}
          onError={onError}
          onClose={closeSettings}
        />
      )}
      {toast && <Toast key={toast.id} toast={toast} onClose={closeToast} />}
    </div>
  );
}
