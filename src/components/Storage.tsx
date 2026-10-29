import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import type { CleanProgress, DriveInfo, ScanEvent, ScanInfo, SpaceNode, Suggestion } from "../types";
import { basename, dirname, formatSize, isDriveRoot, normPath, samePath } from "../util";
import { squarify, type Rect } from "../treemap";
import { loadStorageTipSeen, saveStorageTipSeen } from "../viewPrefs";
import { ContextMenu, DIVIDER, type MenuItem } from "./ContextMenu";
import { UIIcon } from "./Icon";

/** Treemap colours, in the order of the backend's categories. */
export const CATEGORIES = [
  "Photos, video & music",
  "Documents",
  "Code & builds",
  "Apps & games",
  "Archives & disk images",
  "AI models",
  "Other",
];

type Mode = "category" | "cleanup";
type Reclaim = { safe: number; review: number };

interface Props {
  tabId: number;
  /** This tab gets keyboard shortcuts. */
  focused: boolean;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  /** Show a folder in this tab. */
  onOpenFolder: (path: string) => void;
  onOpenInNewTab: (path: string) => void;
  onFsChanged: (dirs: string[]) => void;
  onError: (message: string) => void;
  onNotify: (message: string) => void;
}

// ---- the scan in progress (one at a time), shared by every Storage tab ----

interface Progress {
  files: number;
  bytes: number;
  dir: string;
}

const running: { root: string | null; progress: Progress; listeners: Set<() => void> } = {
  root: null,
  progress: { files: 0, bytes: 0, dir: "" },
  listeners: new Set(),
};
let scanRun = 0;
const notify = () => running.listeners.forEach((l) => l());

function startScan(root: string) {
  const run = ++scanRun;
  running.root = root;
  running.progress = { files: 0, bytes: 0, dir: root };
  notify();
  const finish = () => {
    if (run !== scanRun) return;
    running.root = null;
    notify();
  };
  api
    .scanSpace(root, (e: ScanEvent) => {
      if (run !== scanRun) return;
      if (e.kind === "progress") {
        running.progress = e;
        notify();
      } else finish();
    })
    .catch(finish);
}

function stopScan() {
  scanRun++;
  running.root = null;
  void api.cancelSpaceScan();
  notify();
}

// Per-tab place, kept while the tab shows a folder and comes back.
const memory = new Map<number, { root: string | null; path: string; mode: Mode }>();
export const forgetStorageTab = (tabId: number) => memory.delete(tabId);

// ---- formatting ----

const size = (bytes: number) => (bytes > 0 ? formatSize(bytes) : "0 B");

function ago(secs: number) {
  const s = Date.now() / 1000 - secs;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(secs * 1000).toLocaleDateString();
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

export function Storage(p: Props) {
  const saved = memory.get(p.tabId);
  const [root, setRoot] = useState<string | null>(saved?.root ?? null);
  const [path, setPath] = useState(saved?.path ?? "");
  const [mode, setMode] = useState<Mode>(saved?.mode ?? "category");
  useEffect(() => {
    memory.set(p.tabId, { root, path, mode });
  }, [p.tabId, root, path, mode]);

  // Re-render on scan progress.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    running.listeners.add(bump);
    return () => void running.listeners.delete(bump);
  }, []);
  const scanning = !!root && !!running.root && samePath(running.root, root);

  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [home, setHome] = useState("");
  const [bin, setBin] = useState(0);
  const refreshMachine = useCallback(() => {
    api.listDrives().then(setDrives, () => {});
    api.recycleBinSize().then(setBin, () => {});
  }, []);
  useEffect(() => {
    refreshMachine();
    api.homeDir().then(setHome, () => {});
  }, [refreshMachine]);
  // Free space and the Recycle Bin change outside Splash too.
  useEffect(() => {
    const timer = setInterval(refreshMachine, 15_000);
    window.addEventListener("focus", refreshMachine);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshMachine);
    };
  }, [refreshMachine]);

  const [info, setInfo] = useState<ScanInfo | null>(null);
  const [node, setNode] = useState<SpaceNode | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const pickedFor = useRef<string | null>(null); // root whose safe items were picked by default
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [cleaning, setCleaning] = useState<CleanProgress | null>(null);
  // freed: bytes gone for good; binned: bytes now in the Recycle Bin.
  const [result, setResult] = useState<{ freed: number; binned: number; inUse: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [tip, setTip] = useState(() => !loadStorageTipSeen());
  const closeTip = () => {
    setTip(false);
    saveStorageTipSeen();
  };

  const load = useCallback(async (r: string, at: string) => {
    try {
      const [view, list] = await Promise.all([api.spaceView(r, at), api.spaceSuggestions(r)]);
      setInfo(view.info);
      setNode(view.node);
      setSuggestions(list);
      if (pickedFor.current !== r) {
        pickedFor.current = r;
        setPicked(new Set(list.filter((s) => s.safe).flatMap((s) => s.items.map((i) => i.path))));
      } else {
        // Keep picks that are still suggested.
        const still = new Set(list.flatMap((s) => s.items.map((i) => i.path)));
        setPicked((old) => new Set([...old].filter((x) => still.has(x))));
      }
    } catch {
      if (!samePath(at, r)) return setPath(r); // that folder is gone: back to the top
      setInfo(null);
      setNode(null);
      setSuggestions([]);
    }
  }, []);

  useEffect(() => {
    if (root && !scanning) void load(root, path || root);
  }, [root, path, scanning, load]);

  // Earlier scans, for the start page.
  const places = useMemo(
    () => [...(home ? [home] : []), ...drives.filter((d) => d.total > 0).map((d) => d.path)],
    [home, drives]
  );
  const [known, setKnown] = useState<Record<string, ScanInfo>>({});
  useEffect(() => {
    if (scanning) return;
    void Promise.all(places.map((r) => api.spaceInfo(r).catch(() => null))).then((list) =>
      setKnown(Object.fromEntries(list.flatMap((i, n) => (i ? [[places[n], i]] : []))))
    );
  }, [places, scanning]);

  const scan = (r: string) => {
    setRoot(r);
    setPath(r);
    setInfo(null);
    setNode(null);
    pickedFor.current = null;
    startScan(r);
  };
  /** A place from the chips or start page: show its last scan, or scan it. */
  const openPlace = (r: string) => {
    if (known[r] || (root && samePath(r, root) && info)) {
      setRoot(r);
      setPath(r);
    } else scan(r);
  };

  const label = (r: string) =>
    samePath(r, home) ? "Home" : isDriveRoot(r) ? r.slice(0, 2) : basename(r);
  const tilde = (x: string) =>
    home && normPath(x).startsWith(normPath(home) + "\\") ? "~" + x.slice(home.replace(/[\\/]+$/, "").length) : x;
  /** Long paths keep their start and their last four parts, which tell them apart. */
  const short = (x: string) => {
    const parts = tilde(x).split("\\");
    return parts.length > 6 ? [parts[0], "…", ...parts.slice(-4)].join("\\") : parts.join("\\");
  };
  const driveOf = (r: string) => drives.find((d) => normPath(r).startsWith(normPath(d.path)));

  // ---- cleanup ----

  const items = useMemo(
    () => suggestions.flatMap((s) => s.items.map((i) => ({ ...i, key: normPath(i.path), safe: s.safe }))),
    [suggestions]
  );
  const sizeOf = useMemo(() => new Map(items.map((i) => [i.path, i.size])), [items]);
  const pickedSize = [...picked].reduce((n, x) => n + (sizeOf.get(x) ?? 0), 0);
  const safeCount = items.filter((i) => i.safe).length;

  /** Bytes suggested for cleanup at or under `x`, safe and review-first. */
  const reclaimOf = useCallback(
    (x: string): Reclaim => {
      const k = normPath(x);
      const r = { safe: 0, review: 0 };
      for (const i of items) {
        if (i.key === k || i.key.startsWith(k + "\\")) r[i.safe ? "safe" : "review"] += i.size;
      }
      return r;
    },
    [items]
  );

  const togglePick = (paths: string[], on: boolean) =>
    setPicked((old) => {
      const next = new Set(old);
      paths.forEach((x) => (on ? next.add(x) : next.delete(x)));
      return next;
    });
  const toggleSet = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };

  /** Measure changed items again and reload the view. */
  const afterChange = async (paths: string[]) => {
    if (!root) return;
    try {
      await api.spaceRefresh(root, paths);
    } catch (e) {
      p.onError(String(e));
    }
    await load(root, path || root);
    refreshMachine();
    p.onFsChanged([...new Set(paths.map(dirname))]);
  };

  const cleanUp = async () => {
    const paths = [...picked];
    if (!paths.length || !root || !info) return;
    // Safe items (caches, temp files) are deleted for good: apps rebuild them,
    // and the Recycle Bin is very slow with their many small files. Review
    // items go to the Recycle Bin so they can be restored.
    const safe = new Set(items.filter((i) => i.safe).map((i) => i.path));
    const del = paths.filter((x) => safe.has(x));
    const trash = paths.filter((x) => !safe.has(x));
    const sum = (list: string[]) => list.reduce((n, x) => n + (sizeOf.get(x) ?? 0), 0);
    const lines = [
      del.length ? `• ${size(sum(del))} of caches and temp files will be deleted for good. Apps rebuild them as needed.` : "",
      trash.length ? `• ${size(sum(trash))} will go to the Recycle Bin, so you can restore it.` : "",
      "Folders are emptied, not removed, and files that are in use are skipped.",
    ].filter(Boolean);
    const ok = await confirm(`Clean up ${plural(paths.length, "item")} (${size(pickedSize)})?\n\n${lines.join("\n")}`, {
      title: "Clean up",
      kind: "warning",
      okLabel: "Clean up",
    });
    if (!ok) return;
    setBusy(true);
    setResult(null);
    setCleaning({ done: 0, total: paths.length, path: del[0] ?? trash[0] });
    const before = info.size;
    try {
      const inUse = await api.cleanUp(del, trash, (e) => {
        setCleaning(e);
        if (trash.length) api.recycleBinSize().then(setBin, () => {});
      });
      const after = await api.spaceRefresh(root, paths);
      await afterChange([]);
      const gone = Math.max(0, before - after.size);
      // What went to the Recycle Bin (the rest is gone for good).
      const binned = Math.min(gone, sum(trash));
      setResult({ freed: gone - binned, binned, inUse });
      p.onNotify(`Cleaned up ${size(gone)}`);
    } catch (e) {
      p.onError(String(e));
    } finally {
      setCleaning(null);
      setBusy(false);
    }
  };

  const emptyBin = async () => {
    const ok = await confirm(`Permanently delete everything in the Recycle Bin (${size(bin)})?`, {
      title: "Empty Recycle Bin",
      kind: "warning",
      okLabel: "Empty",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.emptyRecycleBin();
      setResult(null);
      p.onNotify(`Freed ${size(bin)}`);
    } catch (e) {
      p.onError(String(e));
    } finally {
      setBusy(false);
      refreshMachine();
    }
  };

  // ---- treemap actions ----

  const zoom = (x: string) => setPath(x);
  const atTop = !root || !path || samePath(path, root);
  const goUp = () => {
    if (root && !atTop) setPath(samePath(dirname(path), root) ? root : dirname(path));
  };

  const openTileMenu = (n: SpaceNode, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!n.path) return;
    const remove = async () => {
      const ok = await confirm(`Move ${n.name} (${size(n.size)}) to the Recycle Bin?`, {
        title: "Delete",
        kind: "warning",
      });
      if (!ok) return;
      try {
        await api.deleteToTrash([n.path]);
      } catch (err) {
        p.onError(String(err));
      }
      await afterChange([n.path]);
    };
    const items: MenuItem[] = n.isDir
      ? [
          { label: "Zoom in", icon: "search", onClick: () => zoom(n.path) },
          { label: "Open", icon: "open", onClick: () => p.onOpenFolder(n.path) },
          { label: "Open in new tab", icon: "new-tab", onClick: () => p.onOpenInNewTab(n.path) },
        ]
      : [
          { label: "Open", icon: "open", onClick: () => void api.openPath(n.path).catch((err) => p.onError(String(err))) },
          { label: "Show in folder", icon: "folder", onClick: () => p.onOpenFolder(dirname(n.path)) },
        ];
    items.push(
      { label: "Copy as path", icon: "copy-path", onClick: () => void navigator.clipboard.writeText(`"${n.path}"`) },
      { label: "Show in Windows Explorer", icon: "explorer", onClick: () => void api.reveal(n.path).catch(() => {}) },
      DIVIDER,
      { label: "Move to Recycle Bin", icon: "trash", danger: true, onClick: () => void remove() }
    );
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ---- keyboard (focused tab only) ----
  const keys = useRef({ goUp, atTop, p });
  keys.current = { goUp, atTop, p };
  useEffect(() => {
    if (!p.focused) return;
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (e.altKey && e.key === "ArrowLeft") return (e.preventDefault(), k.p.onBack());
      if (e.altKey && e.key === "ArrowRight") return (e.preventDefault(), k.p.onForward());
      if ((e.altKey && e.key === "ArrowUp") || e.key === "Backspace") {
        e.preventDefault();
        return k.atTop ? (e.key === "Backspace" ? k.p.onBack() : undefined) : k.goUp();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.focused]);

  // ---- layout ----

  const header = (
    <div className="st-head">
      <div className="nav-buttons">
        <button className="icon-btn" title="Back (Alt+Left)" disabled={!p.canBack} onClick={p.onBack}>
          <UIIcon name="back" />
        </button>
        <button className="icon-btn" title="Forward (Alt+Right)" disabled={!p.canForward} onClick={p.onForward}>
          <UIIcon name="forward" />
        </button>
      </div>
      <h1 className="st-title">Storage</h1>
      <div className="st-places" role="tablist">
        {places.map((r) => (
          <button
            key={r}
            role="tab"
            aria-selected={!!root && samePath(r, root)}
            className={`st-place ${root && samePath(r, root) ? "on" : ""}`}
            title={r}
            onClick={() => openPlace(r)}
          >
            <UIIcon name={samePath(r, home) ? "home" : "drive"} size={14} />
            {label(r)}
          </button>
        ))}
      </div>
      <span className="spacer" />
      {info && root && !scanning && (
        <>
          <span className="st-when">
            Scanned {ago(info.at)} · {(info.ms / 1000).toFixed(1)} s
          </span>
          <button className="text-btn" onClick={() => scan(root)} title="Scan again">
            <UIIcon name="refresh" size={15} /> Rescan
          </button>
        </>
      )}
    </div>
  );

  // Start page: pick what to scan.
  if (!root || (!scanning && !info)) {
    return (
      <div className="storage">
        {header}
        <div className="st-start">
          <div className="st-intro">
            <h2>See what's taking up space</h2>
            <p>
              Splash measures every folder, shows it as a map you can click into, and points out caches and leftovers
              that are safe to clean up. Nothing is deleted without asking.
            </p>
          </div>
          <div className="st-cards">
            {places.map((r) => {
              const d = isDriveRoot(r) ? driveOf(r) : undefined;
              const used = d && d.total ? (d.total - d.free) / d.total : 0;
              const last = known[r];
              return (
                <div key={r} className="st-card">
                  <div className="st-card-top">
                    <span className="st-card-icon">
                      <UIIcon name={samePath(r, home) ? "home" : "drive"} size={20} />
                    </span>
                    <div>
                      <div className="st-card-name">{samePath(r, home) ? "Home folder" : `Drive ${label(r)}`}</div>
                      <div className="st-card-sub">
                        {d ? `${size(d.total - d.free)} used of ${size(d.total)}` : r}
                      </div>
                    </div>
                  </div>
                  {d && (
                    <span className={`drive-bar ${used > 0.9 ? "full" : ""}`}>
                      <span style={{ width: `${Math.round(used * 100)}%` }} />
                    </span>
                  )}
                  <div className="st-card-note">
                    {last
                      ? `Scanned ${ago(last.at)} · ${size(last.safe)} safe to clean`
                      : samePath(r, home)
                        ? "Your files, app data and caches. The quickest scan."
                        : "Everything on the drive, including apps and games."}
                  </div>
                  <div className="st-card-actions">
                    {last && (
                      <button className="st-btn" onClick={() => openPlace(r)}>
                        View
                      </button>
                    )}
                    <button className={`st-btn ${last ? "" : "primary"}`} onClick={() => scan(r)}>
                      {last ? "Rescan" : "Scan"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // Scanning.
  if (scanning || !node || !info) {
    const pr = running.progress;
    const d = isDriveRoot(root) ? driveOf(root) : undefined;
    const share = d && d.total ? Math.min(1, pr.bytes / Math.max(1, d.total - d.free)) : null;
    return (
      <div className="storage">
        {header}
        <div className="st-scan">
          <div className="st-scan-title">Scanning {samePath(root, home) ? "your Home folder" : label(root)}…</div>
          <div className={`st-progress ${share === null ? "indeterminate" : ""}`}>
            <span style={share === null ? undefined : { width: `${Math.round(share * 100)}%` }} />
          </div>
          <div className="st-scan-stats">
            {plural(pr.files, "file")} · {size(pr.bytes)}
          </div>
          <div className="st-scan-dir" title={pr.dir}>
            {tilde(pr.dir)}
          </div>
          {scanning && (
            <button className="st-btn" onClick={stopScan}>
              Stop
            </button>
          )}
        </div>
      </div>
    );
  }

  // Results.
  const drive = driveOf(root);
  const isDrive = isDriveRoot(root);
  const reviewCount = items.length - safeCount;
  const crumbs = (() => {
    const base = root.replace(/[\\/]+$/, "");
    const rest = path && !samePath(path, root) ? path.slice(base.length).split(/[\\/]/).filter(Boolean) : [];
    return [
      { name: label(root), path: root },
      ...rest.map((name, i) => ({ name, path: base + "\\" + rest.slice(0, i + 1).join("\\") })),
    ];
  })();
  const safeList = suggestions.filter((s) => s.safe);
  const reviewList = suggestions.filter((s) => !s.safe);

  const recRow = (s: Suggestion) => {
    const paths = s.items.map((i) => i.path);
    const n = paths.filter((x) => picked.has(x)).length;
    const state = n === 0 ? "none" : n === paths.length ? "all" : "some";
    const open = expanded.has(s.id);
    const list = showAll.has(s.id) ? s.items : s.items.slice(0, 8);
    return (
      <div key={s.id} className={`rec ${open ? "open" : ""}`}>
        <div className="rec-row">
          <Check state={state} label={s.label} onChange={() => togglePick(paths, state !== "all")} />
          <button className="rec-main" onClick={() => setExpanded((x) => toggleSet(x, s.id))} title={s.note}>
            <span className="rec-title">{s.label}</span>
            <span className="rec-sub">
              {s.items.length === 1 ? short(s.items[0].path) : `${s.items.length} places · ${short(s.items[0].path)}`}
            </span>
          </button>
          <span className="rec-size">{size(s.size)}</span>
          <button
            className="rec-chevron"
            aria-label={open ? "Hide details" : "Show details"}
            onClick={() => setExpanded((x) => toggleSet(x, s.id))}
          >
            <UIIcon name="forward" size={14} />
          </button>
        </div>
        {open && (
          <div className="rec-detail">
            <p className="rec-note">{s.note}</p>
            {list.map((i) => (
              <div key={i.path} className="rec-item">
                <Check
                  state={picked.has(i.path) ? "all" : "none"}
                  label={i.path}
                  onChange={() => togglePick([i.path], !picked.has(i.path))}
                />
                <button
                  className="rec-path"
                  title={`${i.path}\nShow it on the map`}
                  onClick={() => {
                    setMode("cleanup");
                    zoom(samePath(dirname(i.path), root) || !normPath(i.path).startsWith(normPath(root)) ? root : dirname(i.path));
                  }}
                >
                  {/* Cut from the left, so the end that tells paths apart stays. */}
                  <bdi dir="ltr">{tilde(i.path)}</bdi>
                </button>
                <span className="rec-item-size">{size(i.size)}</span>
              </div>
            ))}
            {s.items.length > list.length && (
              <button className="rec-more" onClick={() => setShowAll((x) => toggleSet(x, s.id))}>
                Show all {s.items.length}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="storage">
      {header}
      <div className="st-stats">
        <Stat
          label={drive ? "Free after cleanup" : "Selected to clean"}
          value={size(drive ? drive.free + pickedSize : pickedSize)}
          sub={pickedSize > 0 ? `+${size(pickedSize)}` : drive ? `of ${size(drive.total)}` : ""}
          good={pickedSize > 0}
        />
        <Stat label="Safe to remove" dot="safe" value={size(info.safe)} sub={plural(safeCount, "item")} />
        <Stat label="Needs review" dot="review" value={size(info.review)} sub={plural(reviewCount, "item")} />
        {isDrive || !drive ? (
          <Stat
            label="Scanned"
            value={size(info.size)}
            sub={plural(info.files, "file") + (info.denied ? ` · ${info.denied.toLocaleString()} unreadable` : "")}
          />
        ) : (
          <Stat
            label={`Elsewhere on ${drive.name}`}
            value={size(Math.max(0, drive.total - drive.free - info.size))}
            sub="system & apps"
          />
        )}
      </div>

      <div className="st-main">
        <section className="st-panel st-map">
          <div className="st-panel-head">
            <div>
              <div className="st-panel-title">Explorer</div>
              <div className="st-crumbs">
                {!atTop && (
                  <button className="icon-btn st-up" title="Up a level (Backspace)" onClick={goUp}>
                    <UIIcon name="up" size={15} />
                  </button>
                )}
                {crumbs.map((c, i) => (
                  <span key={c.path} className="crumb-wrap">
                    {i > 0 && <span className="crumb-sep">›</span>}
                    <button className="crumb" onClick={() => zoom(c.path)} disabled={i === crumbs.length - 1}>
                      {c.name}
                    </button>
                  </span>
                ))}
                <span className="st-crumb-size">{size(node.size)}</span>
              </div>
            </div>
            <div className="st-seg" role="tablist" aria-label="Colour by">
              <button role="tab" aria-selected={mode === "category"} className={mode === "category" ? "on" : ""} onClick={() => setMode("category")}>
                Category
              </button>
              <button role="tab" aria-selected={mode === "cleanup"} className={mode === "cleanup" ? "on" : ""} onClick={() => setMode("cleanup")}>
                Cleanup
              </button>
            </div>
          </div>
          {tip && (
            <div className="st-tip" role="note">
              <UIIcon name="search" size={15} />
              <span>
                <b>Click any box to look inside it.</b> Go back up with the arrow, the path above, or{" "}
                <kbd>Backspace</kbd>. Right-click a box to open it, show it in its folder, or delete it.
              </span>
              <button className="st-btn" onClick={closeTip}>
                Got it
              </button>
            </div>
          )}
          {node.children.length ? (
            <Treemap key={node.path} node={node} mode={mode} reclaimOf={reclaimOf} onZoom={zoom} onMenu={openTileMenu} />
          ) : (
            <div className="st-empty">{node.denied ? "Splash couldn't read this folder." : "This folder is empty."}</div>
          )}
          <div className="st-legend">
            {mode === "category" ? (
              <>
                {CATEGORIES.map((c, i) => (
                  <span key={c}>
                    <i className={`sw cat-${i}`} />
                    {c}
                  </span>
                ))}
                <span>
                  <i className="sw hatch" />
                  Can be cleaned up
                </span>
              </>
            ) : (
              <>
                <span>
                  <i className="sw flag-safe" />
                  Safe to remove
                </span>
                <span>
                  <i className="sw flag-review" />
                  Review first
                </span>
                <span>
                  <i className="sw has-reclaim" />
                  Has items to clean inside
                </span>
              </>
            )}
          </div>
        </section>

        <aside className="st-panel st-recs">
          <div className="st-panel-head">
            <div>
              <div className="st-panel-title">Recommendations</div>
              <div className="st-panel-sub">Pick what to clean up. Review items go to the Recycle Bin.</div>
            </div>
          </div>
          <div className="rec-list">
            {result && (
              <div className="rec-result" role="status">
                <span className="rec-result-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                </span>
                <div className="rec-main">
                  <span className="rec-title">Cleaned up {size(result.freed + result.binned)}</span>
                  <span className="rec-result-note">
                    {result.freed > 0 && `${size(result.freed)} is free now.`}
                    {result.binned > 0 &&
                      ` ${size(result.binned)} is in the Recycle Bin; empty it below to get that space back too.`}
                    {result.inUse > 0 &&
                      ` ${plural(result.inUse, "item")} ${result.inUse === 1 ? "was" : "were"} in use and stayed; close the apps using them (like your browser) and clean up again.`}
                  </span>
                </div>
                <button className="icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => setResult(null)}>
                  <UIIcon name="x" size={14} />
                </button>
              </div>
            )}
            {bin > 0 && (
              <div className={`rec-bin ${result ? "attention" : ""}`}>
                <UIIcon name="trash" size={16} />
                <div className="rec-main">
                  <span className="rec-title">Recycle Bin</span>
                  <span className="rec-sub">Emptying it frees this space</span>
                </div>
                <span className="rec-size">{size(bin)}</span>
                <button className="st-btn" disabled={busy} onClick={() => void emptyBin()}>
                  Empty
                </button>
              </div>
            )}
            {safeList.length > 0 && (
              <div className="rec-group">
                <span className="tier safe">Safe to remove</span>
                <span>{size(info.safe)}</span>
              </div>
            )}
            {safeList.map(recRow)}
            {reviewList.length > 0 && (
              <div className="rec-group">
                <span className="tier review">Review first</span>
                <span>{size(info.review)}</span>
              </div>
            )}
            {reviewList.map(recRow)}
            {!suggestions.length && <div className="st-empty small">Nothing to clean up here. Nice and tidy.</div>}
          </div>
          {cleaning ? (
            <div className="rec-foot cleaning" role="status">
              <div className="rec-cleaning-text">
                <b>
                  Cleaning up… {Math.min(cleaning.done + 1, cleaning.total)} of {cleaning.total}
                </b>
                <span title={cleaning.path}>{cleaning.path ? short(cleaning.path) : "Finishing…"}</span>
              </div>
              <div className="st-progress">
                <span style={{ width: `${Math.round((cleaning.done / Math.max(1, cleaning.total)) * 100)}%` }} />
              </div>
            </div>
          ) : (
          <div className="rec-foot">
            <span className="rec-total">
              <b>{size(pickedSize)}</b> selected · {plural(picked.size, "item")}
            </span>
            <span className="spacer" />
            <button
              className="st-btn"
              disabled={busy || !safeCount}
              onClick={() => setPicked(new Set(items.filter((i) => i.safe).map((i) => i.path)))}
            >
              Select safe
            </button>
            <button className="st-btn primary" disabled={busy || !picked.size} onClick={() => void cleanUp()}>
              Clean up
            </button>
          </div>
          )}
        </aside>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function Stat({ label, value, sub, dot, good }: { label: string; value: string; sub: string; dot?: "safe" | "review"; good?: boolean }) {
  return (
    <div className="st-stat">
      <div className="st-stat-label">
        {dot && <i className={`dot ${dot}`} />}
        {label}
      </div>
      <div className="st-stat-value">
        {value}
        {sub && <span className={good ? "good" : ""}>{sub}</span>}
      </div>
    </div>
  );
}

function Check({ state, label, onChange }: { state: "all" | "some" | "none"; label: string; onChange: () => void }) {
  return (
    <button
      role="checkbox"
      aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
      aria-label={label}
      className={`check ${state}`}
      onClick={onChange}
    >
      {state === "all" && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      )}
      {state === "some" && <span className="check-dash" />}
    </button>
  );
}

// ---- treemap ----

const GAP = 3;
const HEAD = 24; // title strip of a box that shows its contents

interface MapProps {
  node: SpaceNode;
  mode: Mode;
  reclaimOf: (path: string) => Reclaim;
  onZoom: (path: string) => void;
  onMenu: (n: SpaceNode, e: React.MouseEvent) => void;
}

function Treemap(p: MapProps) {
  const box = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setDims({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const kids = p.node.children;
  const rects = squarify(
    kids.map((c) => c.size),
    { x: 0, y: 0, w: dims.w, h: dims.h }
  );
  return (
    <div className={`treemap ${p.mode}`} ref={box}>
      {dims.w > 0 && kids.map((c, i) => <Tile key={c.path || c.name} n={c} rect={rects[i]} depth={1} {...p} />)}
    </div>
  );
}

function Tile({ n, rect, depth, ...p }: MapProps & { n: SpaceNode; rect: Rect; depth: number }) {
  const r = { x: rect.x + GAP / 2, y: rect.y + GAP / 2, w: rect.w - GAP, h: rect.h - GAP };
  if (r.w < 3 || r.h < 3) return null;
  // Big boxes show what's inside them too, up to three levels deep (not
  // cleanable ones: a cache reads better as one striped block).
  const nested = depth < 3 && n.isDir && !n.flag && n.children.length > 0 && r.w > 120 && r.h > 90;
  const inner = nested
    ? squarify(
        n.children.map((c) => c.size),
        { x: 4, y: HEAD, w: r.w - 8, h: r.h - HEAD - 4 }
      )
    : [];
  // Cleanable things too deep to get their own box: a striped band along
  // the bottom, as tall as their share of this box.
  const parts = n.path && !n.flag && !nested ? p.reclaimOf(n.path) : { safe: 0, review: 0 };
  const reclaim = parts.safe + parts.review;
  const tiny = r.w < 64 || r.h < 30;
  const big = !nested && r.w > 110 && r.h > 70;
  const cls = [
    "tile",
    `cat-${n.cat}`,
    n.path ? (n.isDir ? "dir" : "file") : "group",
    n.flag ? `flag-${n.flag}` : "",
    reclaim && p.mode === "cleanup" ? "has-reclaim" : "",
    nested ? "nested" : "",
    big ? "big" : "",
  ].join(" ");
  const tip =
    `${n.path || n.name}\n${size(n.size)}` +
    (n.isDir ? ` · ${plural(n.files, "file")}` : "") +
    (n.flag ? `\n${n.flag === "safe" ? "Safe to remove" : "Review before removing"}` : "") +
    (reclaim ? `\n${size(reclaim)} to clean up inside` : "") +
    (n.denied ? "\nCouldn't be read" : "");
  return (
    <div
      className={cls}
      style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
      title={tip}
      onClick={(e) => {
        e.stopPropagation();
        if (n.path && n.isDir) p.onZoom(n.path);
      }}
      onContextMenu={(e) => p.onMenu(n, e)}
    >
      {reclaim > 0 && (
        <span className="tile-band" style={{ height: `max(4px, ${Math.min(100, (reclaim / n.size) * 100)}%)` }}>
          {parts.safe > 0 && <i className="band-safe" style={{ flexGrow: parts.safe }} />}
          {parts.review > 0 && <i className="band-review" style={{ flexGrow: parts.review }} />}
        </span>
      )}
      {!tiny && (
        <div className="tile-label">
          <span className="tile-name">{n.name}</span>
          {!big && <span className="tile-size">{size(n.size)}</span>}
        </div>
      )}
      {big && <span className="tile-big">{size(n.size)}</span>}
      {reclaim > 0 && p.mode === "cleanup" && r.w > 130 && r.h > 56 && <span className="tile-reclaim">{size(reclaim)} to clean</span>}
      {nested && n.children.map((c, i) => <Tile key={c.path || c.name} n={c} rect={inner[i]} depth={depth + 1} {...p} />)}
    </div>
  );
}
