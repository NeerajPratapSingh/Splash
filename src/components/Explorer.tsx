import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { api, SEARCH_PC_SCOPE } from "../api";
import { SEARCH_PC, type Entry, type SortKey, type Clipboard, type FolderView, type Kind, type NativeItem } from "../types";
import { sortEntries, basename, dirname, samePath, kindOf, dateGroup, KINDS, isArchive } from "../util";
import { DEFAULT_DIR, folderView, saveFolderView } from "../viewPrefs";
import { canPreview } from "../thumbs";
import { Toolbar } from "./Toolbar";
import { FileView } from "./FileView";
import { ContextMenu, DIVIDER, type MenuItem } from "./ContextMenu";

/** What the app can ask a tab to do from outside (sidebar clicks, refreshes). */
export interface ExplorerHandle {
  navigate: (path: string) => void;
  /** Reload if this tab is showing any of `dirs`. */
  refreshIf: (dirs: string[]) => void;
}

interface Props {
  tabId: number;
  initialPath: string;
  /** This tab gets keyboard shortcuts (visible tab of the focused pane). */
  focused: boolean;
  clipboard: Clipboard | null;
  setClipboard: (c: Clipboard | null) => void;
  showHidden: boolean;
  onShowHidden: (on: boolean) => void;
  isPinned: (path: string) => boolean;
  onTogglePin: (path: string) => void;
  onPathChange: (tabId: number, path: string) => void;
  /** Folders whose contents changed, so other tabs showing them can refresh. */
  onFsChanged: (tabId: number, dirs: string[]) => void;
  onError: (message: string) => void;
  /** Short status notice (e.g. "Compressing…"). */
  onNotify: (message: string) => void;
  onOpenInNewTab: (path: string) => void;
  onOpenInOtherPane: (path: string) => void;
  onPreview: (items: Entry[], index: number) => void;
}

interface TabMemory {
  history: string[];
  histIndex: number;
}

// Per-tab history that outlives the component, so a tab moved to the other
// pane (which remounts it) keeps its back/forward history.
const memory = new Map<number, TabMemory>();

/** Drop a closed tab's remembered state. */
export const forgetTab = (tabId: number) => memory.delete(tabId);

const TYPEAHEAD_MS = 800;
const SEARCH_DELAY_MS = 250; // Search this PC starts this long after typing stops

interface SearchStats {
  scanned: number;
  ms: number;
  truncated: boolean;
  done: boolean;
}

/** One tab: its own history, listing, selection, sort and search. */
export const Explorer = forwardRef<ExplorerHandle, Props>(function Explorer(p, ref) {
  const saved = memory.get(p.tabId);
  const [history, setHistory] = useState<string[]>(saved?.history ?? [p.initialPath]);
  const [histIndex, setHistIndex] = useState(saved?.histIndex ?? 0);
  const currentPath = history[histIndex] ?? "";

  useEffect(() => {
    memory.set(p.tabId, { history, histIndex });
  }, [p.tabId, history, histIndex]);

  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastIndex, setLastIndex] = useState<number>(-1); // range-select anchor
  const [cursor, setCursor] = useState<number>(-1); // keyboard position
  const [reveal, setReveal] = useState<{ path: string; n: number } | null>(null);

  // Sort/group/view are per folder (Downloads defaults to newest first).
  const [fv, setFv] = useState<FolderView>(() => folderView(currentPath));
  const [kindFilter, setKindFilter] = useState<Kind | null>(null);

  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Entry[]>([]);
  const [searchMode, setSearchMode] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchStats, setSearchStats] = useState<SearchStats | null>(null);
  const searchRun = useRef(0); // bumped per search; stale stream events are ignored
  const searchingRef = useRef(false);
  const searchDebounce = useRef<number>();
  // This tab's last "Search this PC", restored when navigating back to it.
  const pcMemory = useRef<{ query: string; results: Entry[]; stats: SearchStats | null }>({
    query: "",
    results: [],
    stats: null,
  });
  // Select this item once its folder has loaded ("Open file location").
  const pendingSelect = useRef<string | null>(null);
  const isPc = currentPath === SEARCH_PC;

  const [editingAddress, setEditingAddress] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; bar?: MenuItem[] } | null>(null);
  // Item right-clicked outside the selection: outlined while its menu is open,
  // but not selected (so a stray right-click doesn't change the selection).
  const [menuTarget, setMenuTarget] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", at: 0 });

  const { clipboard, setClipboard, onError, showHidden } = p;

  // ---- data loading ----
  const loadDir = useCallback(async (path: string) => {
    // Leaving a search: drop its stream (and stop it if still running).
    if (searchRun.current && searchingRef.current) void api.cancelSearch();
    searchRun.current++;
    searchingRef.current = false;
    clearTimeout(searchDebounce.current);
    setSearching(false);
    setSelected(new Set());
    setLastIndex(-1);
    setCursor(-1);
    setKindFilter(null);
    setFv(folderView(path));
    setError(null);

    if (path === SEARCH_PC) {
      const memo = pcMemory.current;
      setLoading(false);
      setEntries([]);
      setSearchMode(true);
      setQuery(memo.query);
      setSearchResults(memo.results);
      setSearchStats(memo.stats);
      return;
    }

    setLoading(true);
    setSearchMode(false);
    setSearchResults([]);
    setSearchStats(null);
    setQuery("");
    try {
      const list = await api.listDir(path);
      setEntries(list);
      const target = pendingSelect.current;
      pendingSelect.current = null;
      if (target && list.some((e) => e.path === target)) {
        setSelected(new Set([target]));
        setReveal({ path: target, n: performance.now() });
      }
    } catch (e) {
      setEntries([]);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  /** Stream a name search under `scope` (a folder, or the whole PC). */
  const startSearch = (scope: string, q: string) => {
    const run = ++searchRun.current;
    let found: Entry[] = [];
    searchingRef.current = true;
    setSearchMode(true);
    setSearchResults([]);
    setSelected(new Set());
    setSearchStats(null);
    setSearching(true);
    api
      .searchFiles(scope, q, (ev) => {
        if (run !== searchRun.current) return; // an older search
        if (ev.kind === "batch") {
          found = found.concat(ev.entries);
          setSearchResults(found);
          setSearchStats({ scanned: ev.scanned, ms: 0, truncated: false, done: false });
        } else {
          searchingRef.current = false;
          setSearching(false);
          const stats = { scanned: ev.scanned, ms: ev.ms, truncated: ev.truncated, done: true };
          setSearchStats(stats);
          if (scope === SEARCH_PC_SCOPE) pcMemory.current = { query: q, results: found, stats };
        }
      })
      .catch((e) => {
        if (run !== searchRun.current) return;
        searchingRef.current = false;
        setSearching(false);
        onError(String(e));
      });
  };

  const reload = useCallback(async () => {
    if (!currentPath) return;
    if (currentPath === SEARCH_PC) {
      // Refresh = run the search again (e.g. after renaming or deleting a result).
      if (query.trim().length >= 2) startSearch(SEARCH_PC_SCOPE, query.trim());
      return;
    }
    try {
      const list = await api.listDir(currentPath);
      setEntries(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, query]);

  const navigate = useCallback(
    (path: string) => {
      setHistory((h) => {
        const trimmed = h.slice(0, histIndex + 1);
        trimmed.push(path);
        return trimmed;
      });
      setHistIndex((i) => i + 1);
      loadDir(path);
    },
    [histIndex, loadDir]
  );

  // Initial load.
  useEffect(() => {
    loadDir(currentPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the tab title in sync.
  const { tabId, onPathChange, onFsChanged } = p;
  useEffect(() => {
    if (currentPath) onPathChange(tabId, currentPath);
  }, [tabId, currentPath, onPathChange]);

  useImperativeHandle(
    ref,
    () => ({
      navigate,
      refreshIf: (dirs) => {
        if (dirs.some((d) => samePath(d, currentPath))) void reload();
      },
    }),
    [navigate, reload, currentPath]
  );

  /** After a file operation: refresh this tab, then any other tab showing `dirs`. */
  const changed = useCallback(
    async (dirs: string[]) => {
      // Search this PC isn't a folder: its results are patched in place instead.
      if (currentPath !== SEARCH_PC) await reload();
      onFsChanged(tabId, dirs);
    },
    [reload, onFsChanged, tabId, currentPath]
  );

  // ---- view settings ----
  const updateView = (patch: Partial<FolderView>) => {
    const next = { ...fv, ...patch };
    setFv(next);
    saveFolderView(currentPath, next);
  };
  const onSort = (key: SortKey) =>
    key === fv.sortKey
      ? updateView({ sortDir: fv.sortDir === "asc" ? "desc" : "asc" })
      : updateView({ sortKey: key, sortDir: DEFAULT_DIR[key] });

  // ---- navigation ----
  const canBack = histIndex > 0;
  const canForward = histIndex < history.length - 1;
  const goBack = useCallback(() => {
    if (!canBack) return;
    const i = histIndex - 1;
    setHistIndex(i);
    loadDir(history[i]);
  }, [canBack, histIndex, history, loadDir]);
  const goForward = useCallback(() => {
    if (!canForward) return;
    const i = histIndex + 1;
    setHistIndex(i);
    loadDir(history[i]);
  }, [canForward, histIndex, history, loadDir]);
  const goUp = useCallback(async () => {
    if (!currentPath) return;
    const parent = await api.parentDir(currentPath);
    if (parent) navigate(parent);
  }, [currentPath, navigate]);

  const submitAddress = async (raw: string) => {
    let path = raw.trim().replace(/^"(.*)"$/, "$1"); // pasted "C:\some path"
    if (!path || samePath(path, currentPath)) return setEditingAddress(false);
    if (/^[a-zA-Z]:$/.test(path)) path += "\\";
    try {
      await api.listDir(path);
    } catch (e) {
      // e.g. "Can't open this folder: It doesn't exist…" / "…: Access denied…"
      return onError(`${path} — ${String(e).replace(/^Can't open this folder: /, "")}`);
    }
    setEditingAddress(false);
    navigate(path);
  };

  // ---- grouping ----
  const grouping = useMemo(() => {
    if (fv.groupBy === "none" || searchMode) return null;
    if (fv.groupBy === "date") {
      const now = new Date();
      const created = fv.sortKey === "created";
      // Oldest-first date sorts list the oldest groups first too.
      const flip = (fv.sortKey === "modified" || created) && fv.sortDir === "asc";
      const group = (e: Entry) => dateGroup(created ? e.created : e.modified, now);
      return {
        rank: (e: Entry) => (flip ? -1 : 1) * group(e).rank,
        label: (e: Entry) => group(e).label,
      };
    }
    const order = new Map(KINDS.map((k, i) => [k.kind, i]));
    return {
      rank: (e: Entry) => order.get(kindOf(e))!,
      label: (e: Entry) => KINDS[order.get(kindOf(e))!].label,
    };
  }, [fv.groupBy, fv.sortKey, fv.sortDir, searchMode]);

  // ---- displayed (filtered + sorted + grouped) list ----
  const visible = useMemo(() => {
    const base = searchMode ? searchResults : entries;
    return showHidden ? base : base.filter((e) => !e.hidden);
  }, [entries, searchResults, searchMode, showHidden]);

  const displayed = useMemo(() => {
    let list = visible;
    if (kindFilter) list = list.filter((e) => kindOf(e) === kindFilter);
    const q = query.trim().toLowerCase();
    if (!searchMode && q) list = list.filter((e) => e.name.toLowerCase().includes(q));
    const sorted = sortEntries(list, fv.sortKey, fv.sortDir, fv.foldersFirst);
    if (!grouping) return sorted;
    // Stable sort by group keeps the chosen order inside each group.
    const rank = new Map(sorted.map((e) => [e.path, grouping.rank(e)]));
    return sorted.sort((a, b) => rank.get(a.path)! - rank.get(b.path)!);
  }, [visible, kindFilter, query, searchMode, fv.sortKey, fv.sortDir, fv.foldersFirst, grouping]);

  // ---- selection ----
  const selectOnly = (path: string) => setSelected(new Set([path]));

  const onItemClick = (entry: Entry, e: React.MouseEvent) => {
    const idx = displayed.findIndex((x) => x.path === entry.path);
    if (e.shiftKey && lastIndex >= 0) {
      const [a, b] = [lastIndex, idx].sort((x, y) => x - y);
      const range = displayed.slice(a, b + 1).map((x) => x.path);
      setSelected(new Set(range));
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path);
        return next;
      });
      setLastIndex(idx);
    } else {
      selectOnly(entry.path);
      setLastIndex(idx);
    }
    setCursor(idx);
  };

  /** Keyboard: select item `idx` (or extend the range to it) and scroll it into view. */
  const moveTo = (idx: number, extend: boolean) => {
    if (!displayed.length) return;
    const i = Math.max(0, Math.min(displayed.length - 1, idx));
    if (extend && lastIndex >= 0) {
      const [a, b] = [lastIndex, i].sort((x, y) => x - y);
      setSelected(new Set(displayed.slice(a, b + 1).map((x) => x.path)));
    } else {
      selectOnly(displayed[i].path);
      setLastIndex(i);
    }
    setCursor(i);
    // The list only renders what's on screen, so ask it to scroll there.
    setReveal({ path: displayed[i].path, n: performance.now() });
  };

  /** Items per row in grid view (arrow up/down jumps a whole row), reported by FileView. */
  const columns = useRef(1);
  const onColumns = useCallback((n: number) => {
    columns.current = n;
  }, []);
  const gridColumns = () => columns.current;

  /** Type-to-jump: select the next item whose name starts with what was typed. */
  const jumpTo = (key: string, pos: number) => {
    const now = performance.now();
    const ta = typeahead.current;
    ta.text = now - ta.at < TYPEAHEAD_MS ? ta.text + key.toLowerCase() : key.toLowerCase();
    ta.at = now;
    // Repeating one letter ("ccc") cycles through items starting with it.
    const single = [...ta.text].every((c) => c === ta.text[0]);
    const text = single ? ta.text[0] : ta.text;
    const start = single ? pos + 1 : Math.max(pos, 0);
    const n = displayed.length;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (displayed[i].name.toLowerCase().startsWith(text)) return moveTo(i, false);
    }
  };

  /** Paths to drag when a drag starts on `entry`: the selection if it's part of it. */
  const dragPathsFor = (entry: Entry) => {
    if (selected.has(entry.path)) return [...selected];
    selectOnly(entry.path);
    return [entry.path];
  };

  const openEntry = useCallback(
    async (entry: Entry) => {
      if (entry.is_dir) navigate(entry.path);
      else {
        try {
          await api.openPath(entry.path);
        } catch (e) {
          onError(String(e));
        }
      }
    },
    [navigate, onError]
  );

  const previewEntry = (entry: Entry) => {
    const items = displayed.filter(canPreview);
    const i = items.findIndex((x) => x.path === entry.path);
    if (i >= 0) p.onPreview(items, i);
  };

  // ---- file operations ----
  const selectedEntries = () => displayed.filter((e) => selected.has(e.path));

  const doCopy = () => {
    if (selected.size === 0) return;
    setClipboard({ paths: [...selected], mode: "copy" });
  };
  const doCut = () => {
    if (selected.size === 0) return;
    setClipboard({ paths: [...selected], mode: "cut" });
  };
  const pasteInto = useCallback(
    async (dir: string) => {
      if (!clipboard) return;
      try {
        if (clipboard.mode === "copy") {
          await api.copyEntries(clipboard.paths, dir);
          await changed([dir]);
        } else {
          await api.moveEntries(clipboard.paths, dir);
          setClipboard(null);
          await changed([dir, ...clipboard.paths.map(dirname)]);
        }
      } catch (e) {
        onError(String(e));
        await changed([dir]);
      }
    },
    [clipboard, setClipboard, changed, onError]
  );
  const doPaste = useCallback(async () => {
    if (currentPath && currentPath !== SEARCH_PC) await pasteInto(currentPath);
  }, [currentPath, pasteInto]);

  const doDelete = useCallback(async (targets?: string[]) => {
    const paths = targets ?? [...selected];
    if (paths.length === 0) return;
    const label =
      paths.length === 1 ? `"${basename(paths[0])}"` : `${paths.length} items`;
    const ok = await confirm(`Move ${label} to the Recycle Bin?`, {
      title: "Delete",
      kind: "warning",
    });
    if (!ok) return;
    try {
      await api.deleteToTrash(paths);
      setSelected(new Set());
      // Search results aren't re-listed, so drop the deleted items from them.
      setSearchResults((rs) => rs.filter((r) => !paths.includes(r.path)));
    } catch (e) {
      onError(String(e));
    }
    await changed([currentPath, ...paths.map(dirname)]);
  }, [selected, changed, currentPath, onError]);

  const startRename = () => {
    if (selected.size !== 1) return;
    setRenamingPath([...selected][0]);
  };
  const submitRename = async (path: string, newName: string) => {
    setRenamingPath(null);
    try {
      const newPath = await api.rename(path, newName);
      // Update the renamed item in search results in place.
      setSearchResults((rs) =>
        rs.map((r) =>
          r.path === path
            ? { ...r, path: newPath, name: basename(newPath), extension: r.is_dir ? "" : (newPath.match(/\.([^.\\/]+)$/)?.[1] ?? "").toLowerCase() }
            : r
        )
      );
      await changed([currentPath, dirname(path)]);
      selectOnly(newPath);
    } catch (e) {
      onError(String(e));
    }
  };

  const newFolder = useCallback(async () => {
    if (!currentPath || currentPath === SEARCH_PC) return;
    // Pick a non-clashing default name.
    const names = new Set(entries.map((e) => e.name.toLowerCase()));
    let name = "New folder";
    let n = 2;
    while (names.has(name.toLowerCase())) name = `New folder (${n++})`;
    try {
      const path = await api.createFolder(currentPath, name);
      await changed([currentPath]);
      selectOnly(path);
      setRenamingPath(path);
    } catch (e) {
      onError(String(e));
    }
  }, [currentPath, entries, changed, onError]);

  const newTextFile = async () => {
    if (!currentPath || isPc) return;
    const names = new Set(entries.map((e) => e.name.toLowerCase()));
    let name = "New Text Document.txt";
    let n = 2;
    while (names.has(name.toLowerCase())) name = `New Text Document (${n++}).txt`;
    try {
      const path = await api.createFile(currentPath, name);
      await changed([currentPath]);
      selectOnly(path);
      setRenamingPath(path);
    } catch (e) {
      onError(String(e));
    }
  };

  /** Explorer-style "Copy as path": quoted, one per line. */
  const copyAsPath = (paths: string[]) =>
    navigator.clipboard.writeText(paths.map((x) => `"${x}"`).join("\r\n")).catch(() => {});

  /** Run a shell action, reporting failures. */
  const shell = (fn: () => Promise<unknown>) => () => void fn().catch((e) => onError(String(e)));

  const compressItems = async (paths: string[]) => {
    const dir = dirname(paths[0]);
    p.onNotify(`Compressing ${paths.length === 1 ? basename(paths[0]) : `${paths.length} items`}…`);
    try {
      const zip = await api.compress(paths);
      await changed([dir]);
      p.onNotify(`Created ${basename(zip)}`);
      // Like Explorer: the new zip is selected and ready to rename.
      selectOnly(zip);
      setRenamingPath(zip);
    } catch (e) {
      onError(String(e));
    }
  };

  const extractArchive = async (entry: Entry, intoFolder: boolean) => {
    const dir = dirname(entry.path);
    p.onNotify(`Extracting ${entry.name}…`);
    try {
      const out = await api.extract(entry.path, intoFolder);
      await changed([dir]);
      p.onNotify(intoFolder ? `Extracted to ${basename(out)}` : `Extracted ${entry.name}`);
      if (intoFolder) selectOnly(out);
    } catch (e) {
      onError(String(e));
    }
  };

  // ---- search ----
  /** Enter in the search box: search this folder and everything below it (or the whole PC). */
  const runDeepSearch = () => {
    const q = query.trim();
    if (!q || !currentPath) return;
    clearTimeout(searchDebounce.current);
    startSearch(isPc ? SEARCH_PC_SCOPE : currentPath, q);
  };

  const stopSearch = () => {
    clearTimeout(searchDebounce.current);
    searchRun.current++;
    if (searchingRef.current) void api.cancelSearch();
    searchingRef.current = false;
    setSearching(false);
  };

  const onQueryChange = (q: string) => {
    setQuery(q);
    if (isPc) {
      // Search this PC: search as you type (after a short pause).
      stopSearch();
      if (q.trim().length >= 2) {
        searchDebounce.current = window.setTimeout(() => startSearch(SEARCH_PC_SCOPE, q.trim()), SEARCH_DELAY_MS);
      } else {
        setSearchResults([]);
        setSearchStats(null);
        pcMemory.current = { query: q, results: [], stats: null };
      }
      return;
    }
    // In a folder, typing filters it; Enter searches subfolders.
    if (!q) {
      stopSearch();
      setSearchMode(false);
      setSearchResults([]);
      setSearchStats(null);
    }
  };

  /** "Open file location": go to the item's folder with it selected. */
  const openLocation = (entry: Entry) => {
    pendingSelect.current = entry.path;
    navigate(dirname(entry.path));
  };

  // ---- context menus ----
  /** Windows' own menu entries as our menu items. */
  const toMenuItems = (list: NativeItem[]): MenuItem[] =>
    list.map((n) =>
      n.separator
        ? DIVIDER
        : {
            label: n.label,
            iconUrl: n.icon ?? undefined,
            disabled: n.disabled,
            children: n.children.length ? toMenuItems(n.children) : undefined,
            onClick: () =>
              void api
                .shellMenuInvoke(n.id)
                // The entry may have changed files here (e.g. WinRAR extract).
                .then(() => setTimeout(() => void changed([currentPath]), 800))
                .catch((err) => onError(String(err))),
          }
    );

  // Windows' "Open with" submenu is the one holding the "Choose another app" (openas) entry.
  const isOpenWith = (n: NativeItem) => n.children.some((c) => c.verb === "openas");

  const openItemMenu = (entry: Entry, e: React.MouseEvent) => {
    const inSel = selected.has(entry.path);
    setMenuTarget(inSel ? null : entry.path);
    // Act on what was right-clicked: the selection if it's part of it, else just this item.
    const paths = inSel ? [...selected] : [entry.path];
    const single = paths.length === 1;
    const folder = entry.is_dir && single;
    const stem = entry.name.replace(/(\.tar)?\.[^.]+$/i, "");

    // Windows' entries, fetched once per menu and shared by "Open with" and "Show more options".
    let nativePromise: Promise<NativeItem[]> | null = null;
    const native = () => (nativePromise ??= api.shellMenuItems(paths));
    const chooseApp: MenuItem = {
      label: "Choose another app…",
      icon: "open-with",
      onClick: shell(() => api.openWith(entry.path)),
    };
    const openWithApps = async () => {
      const list = (await native()).find(isOpenWith);
      return list ? toMenuItems(list.children) : [chooseApp];
    };
    const moreOptions = async () =>
      toMenuItems((await native()).filter((n) => !(single && !entry.is_dir && isOpenWith(n))));
    // Start the (slowish, ~1s cold) lookup now, so the submenus are usually ready by the time
    // the pointer reaches them. Errors surface when a submenu actually opens.
    setTimeout(() => void native().catch(() => {}), 0);

    const bar: MenuItem[] = [
      { label: "Cut", icon: "cut", shortcut: "Ctrl+X", onClick: () => setClipboard({ paths, mode: "cut" }) },
      { label: "Copy", icon: "copy", shortcut: "Ctrl+C", onClick: () => setClipboard({ paths, mode: "copy" }) },
      { label: "Rename", icon: "rename", shortcut: "F2", onClick: () => setRenamingPath(entry.path), disabled: !single },
      { label: "Delete", icon: "trash", shortcut: "Del", onClick: () => void doDelete(paths), danger: true },
    ];

    const items: MenuItem[] = [
      { label: "Open", icon: "open", shortcut: "Enter", onClick: () => openEntry(entry) },
      ...(searchMode && single
        ? [{ label: "Open file location", icon: "explorer", onClick: () => openLocation(entry) }]
        : []),
      ...(!entry.is_dir && single
        ? [{ label: "Open with", icon: "open-with", onClick: () => {}, load: openWithApps }]
        : []),
      ...(canPreview(entry) && single
        ? [{ label: "Preview", icon: "eye", shortcut: "Space", onClick: () => previewEntry(entry) }]
        : []),
      ...(folder
        ? [
            { label: "Open in new tab", icon: "new-tab", shortcut: "Middle-click", onClick: () => p.onOpenInNewTab(entry.path) },
            { label: "Open in other pane", icon: "other-pane", onClick: () => p.onOpenInOtherPane(entry.path) },
            {
              label: p.isPinned(entry.path) ? "Unpin from sidebar" : "Pin to sidebar",
              icon: "pin",
              onClick: () => p.onTogglePin(entry.path),
            },
          ]
        : []),
      DIVIDER,
      { label: "Compress to ZIP file", icon: "zip", onClick: () => void compressItems(paths) },
      ...(isArchive(entry) && single
        ? [
            { label: `Extract to "${stem}\\"`, icon: "extract", onClick: () => void extractArchive(entry, true) },
            { label: "Extract here", icon: "extract", onClick: () => void extractArchive(entry, false) },
          ]
        : []),
      { label: "Copy as path", icon: "copy-path", shortcut: "Ctrl+Shift+C", onClick: () => copyAsPath(paths) },
      ...(folder && clipboard
        ? [{ label: "Paste into folder", icon: "paste", onClick: () => void pasteInto(entry.path) }]
        : []),
      DIVIDER,
      ...(folder
        ? [{ label: "Open in Terminal", icon: "terminal", onClick: shell(() => api.openTerminal(entry.path)) }]
        : []),
      { label: "Show in Windows Explorer", icon: "explorer", onClick: shell(() => api.reveal(entry.path)) },
      ...(single
        ? [{ label: "Properties", icon: "properties", shortcut: "Alt+Enter", onClick: shell(() => api.properties(entry.path)) }]
        : []),
      DIVIDER,
      { label: "Show more options", icon: "more", onClick: () => {}, load: moreOptions },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items, bar });
  };

  const openBackgroundMenu = (e: React.MouseEvent) => {
    if (isPc) {
      // Search results aren't a folder: nothing to create or paste here.
      const items: MenuItem[] = [
        {
          label: "Select all",
          icon: "select-all",
          shortcut: "Ctrl+A",
          onClick: () => setSelected(new Set(displayed.map((x) => x.path))),
        },
        { label: "Search again", icon: "refresh", shortcut: "F5", onClick: reload },
      ];
      return setMenu({ x: e.clientX, y: e.clientY, items });
    }
    const items: MenuItem[] = [
      { label: "New folder", icon: "new-folder", shortcut: "Ctrl+Shift+N", onClick: newFolder },
      { label: "New text document", icon: "new-file", onClick: () => void newTextFile() },
      { label: "Paste", icon: "paste", shortcut: "Ctrl+V", onClick: doPaste, disabled: !clipboard },
      DIVIDER,
      {
        label: "Select all",
        icon: "select-all",
        shortcut: "Ctrl+A",
        onClick: () => setSelected(new Set(displayed.map((x) => x.path))),
      },
      { label: "Refresh", icon: "refresh", shortcut: "F5", onClick: reload },
      DIVIDER,
      {
        label: p.isPinned(currentPath) ? "Unpin this folder from sidebar" : "Pin this folder to sidebar",
        icon: "pin",
        onClick: () => p.onTogglePin(currentPath),
      },
      { label: "Copy as path", icon: "copy-path", onClick: () => copyAsPath([currentPath]) },
      { label: "Open in Terminal", icon: "terminal", onClick: shell(() => api.openTerminal(currentPath)) },
      { label: "Open in Windows Explorer", icon: "explorer", onClick: shell(() => api.openPath(currentPath)) },
      { label: "Properties", icon: "properties", onClick: shell(() => api.properties(currentPath)) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ---- keyboard shortcuts (only for the focused tab) ----
  useEffect(() => {
    if (!p.focused) return;
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Jump to the address bar works even from the search box, like Explorer.
      if ((ctrl && key === "l") || (e.altKey && key === "d") || e.key === "F4")
        return (e.preventDefault(), setEditingAddress(true));
      // Back/Forward/Up also work from the search box, like Explorer.
      if (e.altKey && e.key === "ArrowLeft") return (e.preventDefault(), goBack());
      if (e.altKey && e.key === "ArrowRight") return (e.preventDefault(), goForward());
      if (e.altKey && e.key === "ArrowUp") return (e.preventDefault(), goUp());
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA";
      if (typing) return;
      const pos = cursor >= 0 ? cursor : lastIndex;
      const grid = fv.view === "grid";

      if (e.key === "Backspace") return (e.preventDefault(), goBack());
      if (e.ctrlKey && e.shiftKey && key === "c") {
        e.preventDefault();
        return void copyAsPath(selected.size ? [...selected] : [currentPath]);
      }
      if (e.altKey && e.key === "Enter") {
        e.preventDefault();
        const target = selected.size === 1 ? [...selected][0] : currentPath;
        return void api.properties(target).catch((err) => onError(String(err)));
      }

      // Arrow keys move the selection; Shift extends it.
      if (!e.altKey && !ctrl) {
        const step = grid ? gridColumns() : 1;
        const moves: Record<string, number> = {
          ArrowDown: pos < 0 ? 0 : pos + step,
          ArrowUp: pos < 0 ? 0 : pos - step,
          Home: 0,
          End: displayed.length - 1,
          ...(grid ? { ArrowRight: pos + 1, ArrowLeft: Math.max(0, pos - 1) } : {}),
        };
        if (e.key in moves) return (e.preventDefault(), moveTo(moves[e.key], e.shiftKey));
      }

      // Letters jump to matching names (a space continues a name being typed).
      const typingAhead = performance.now() - typeahead.current.at < TYPEAHEAD_MS;
      if (e.key.length === 1 && !ctrl && !e.altKey && (e.key !== " " || typingAhead))
        return (e.preventDefault(), jumpTo(e.key, pos));

      if (e.key === "F5") return (e.preventDefault(), void reload());
      if (e.key === "F2") return (e.preventDefault(), startRename());
      if (e.key === "Delete") return (e.preventDefault(), void doDelete());
      if (e.key === "Enter") {
        const sel = selectedEntries();
        if (sel.length === 1) return (e.preventDefault(), void openEntry(sel[0]));
      }
      if (e.key === " ") {
        const sel = selectedEntries();
        if (sel.length === 1) return (e.preventDefault(), previewEntry(sel[0]));
      }
      if (e.key === "Escape") return setSelected(new Set());
      if (ctrl && !e.shiftKey && key === "a")
        return (e.preventDefault(), setSelected(new Set(displayed.map((x) => x.path))));
      if (ctrl && !e.shiftKey && key === "c") return doCopy();
      if (ctrl && !e.shiftKey && key === "x") return doCut();
      if (ctrl && !e.shiftKey && key === "v") return void doPaste();
      if (e.ctrlKey && e.shiftKey && key === "n") return (e.preventDefault(), void newFolder());
      if (e.ctrlKey && e.shiftKey && key === "v")
        return (e.preventDefault(), updateView({ view: grid ? "list" : "grid" }));
      if (ctrl && !e.shiftKey && key === "f") {
        e.preventDefault();
        (document.querySelector(".pane.focused .search input") as HTMLInputElement)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focused, displayed, selected, clipboard, cursor, lastIndex, fv, goBack, goForward, goUp, reload, doPaste, doDelete, newFolder]);

  const cutPaths = useMemo(
    () => new Set(clipboard?.mode === "cut" ? clipboard.paths : []),
    [clipboard]
  );

  const filtered = kindFilter || (!searchMode && query.trim());

  return (
    <div className="explorer" ref={rootRef}>
      <Toolbar
        path={currentPath}
        canBack={canBack}
        canForward={canForward}
        onBack={goBack}
        onForward={goForward}
        onUp={goUp}
        onRefresh={reload}
        onNavigate={navigate}
        onNewFolder={newFolder}
        fv={fv}
        onView={updateView}
        kindFilter={kindFilter}
        onKindFilter={setKindFilter}
        showHidden={showHidden}
        onShowHidden={p.onShowHidden}
        query={query}
        onQuery={onQueryChange}
        onSubmitSearch={runDeepSearch}
        editingAddress={editingAddress}
        onEditAddress={setEditingAddress}
        onSubmitAddress={submitAddress}
        pcSearch={isPc}
      />
      <FileView
        cwd={isPc ? "" : currentPath}
        emptyText={
          isPc && query.trim().length < 2
            ? "Type a file or folder name to search every drive on this PC"
            : searching
              ? "Searching…"
              : undefined
        }
        entries={displayed}
        view={fv.view}
        sortKey={fv.sortKey}
        sortDir={fv.sortDir}
        onSort={onSort}
        groupOf={grouping?.label ?? null}
        selected={selected}
        cutPaths={cutPaths}
        renamingPath={renamingPath}
        loading={loading}
        error={error}
        searchMode={searchMode}
        onItemClick={onItemClick}
        onItemDoubleClick={openEntry}
        onItemMiddleClick={(entry) => entry.is_dir && p.onOpenInNewTab(entry.path)}
        onItemContextMenu={openItemMenu}
        onBackgroundClick={() => setSelected(new Set())}
        onBackgroundContextMenu={openBackgroundMenu}
        onRenameSubmit={submitRename}
        onRenameCancel={() => setRenamingPath(null)}
        dragPathsFor={dragPathsFor}
        menuTarget={menuTarget}
        reveal={reveal}
        onColumns={onColumns}
      />
      <div className="statusbar">
        <span>
          {searchMode
            ? searching
              ? `Searching… ${displayed.length.toLocaleString()} found · ${(searchStats?.scanned ?? 0).toLocaleString()} items checked`
              : searchStats?.done
                ? `${displayed.length.toLocaleString()} result${displayed.length === 1 ? "" : "s"} · ${(searchStats.ms / 1000).toFixed(1)} s` +
                  (searchStats.truncated ? " · showing the first 5,000 — type more to narrow it down" : "")
                : isPc
                  ? "Search every drive by name"
                  : `${displayed.length} result${displayed.length === 1 ? "" : "s"}`
            : filtered
              ? `${displayed.length} of ${visible.length} items`
              : `${displayed.length} item${displayed.length === 1 ? "" : "s"}`}
        </span>
        {selected.size > 0 && <span>{selected.size} selected</span>}
        {clipboard && (
          <span className="clip-note">
            {clipboard.paths.length} {clipboard.mode === "cut" ? "cut" : "copied"}
          </span>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          bar={menu.bar}
          onClose={() => {
            setMenu(null);
            setMenuTarget(null);
          }}
        />
      )}
    </div>
  );
});
