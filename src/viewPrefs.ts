import type { FolderView, SortDir, SortKey } from "./types";
import { normPath } from "./util";

export const KEY_LABEL: Record<SortKey, string> = {
  name: "Name",
  modified: "Date modified",
  created: "Date created",
  size: "Size",
  type: "Type",
};

/** Direction a sort starts in when picked: dates and sizes biggest/newest first. */
export const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  type: "asc",
  modified: "desc",
  created: "desc",
  size: "desc",
};

/** Plain-language order, e.g. "A → Z", "Newest first". */
export function orderLabel(key: SortKey, dir: SortDir): string {
  const asc = dir === "asc";
  switch (key) {
    case "modified":
    case "created":
      return asc ? "Oldest first" : "Newest first";
    case "size":
      return asc ? "Smallest first" : "Largest first";
    default:
      return asc ? "A → Z" : "Z → A";
  }
}

/**
 * Display preferences kept in this app's local storage: how each folder is
 * sorted/grouped/viewed (like Explorer remembers per folder), and whether
 * hidden items are shown.
 */

const FOLDERS_KEY = "splash.folderViews";
const HIDDEN_KEY = "splash.showHidden";

export const DEFAULT_VIEW: FolderView = {
  view: "list",
  sortKey: "name",
  sortDir: "asc",
  groupBy: "none",
  foldersFirst: true,
};

// Like Explorer: newest downloads on top, grouped by date.
const DOWNLOADS_VIEW: FolderView = {
  ...DEFAULT_VIEW,
  sortKey: "modified",
  sortDir: "desc",
  groupBy: "date",
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: preferences just won't persist.
  }
}

const saved = read<Record<string, FolderView>>(FOLDERS_KEY, {});
let downloads = "";

export function setDownloadsFolder(path: string) {
  downloads = normPath(path);
}

export function folderView(path: string): FolderView {
  const key = normPath(path);
  const own = saved[key];
  if (own) return { ...DEFAULT_VIEW, ...own };
  return downloads && key === downloads ? DOWNLOADS_VIEW : DEFAULT_VIEW;
}

export function saveFolderView(path: string, view: FolderView) {
  saved[normPath(path)] = view;
  write(FOLDERS_KEY, saved);
}

export const loadShowHidden = () => read<boolean>(HIDDEN_KEY, false);
export const saveShowHidden = (on: boolean) => write(HIDDEN_KEY, on);

/** "Instant search" (whole-PC name index); on unless turned off. */
const INDEX_KEY = "splash.searchIndex";
export const loadSearchIndex = () => read<boolean>(INDEX_KEY, true);
export const saveSearchIndex = (on: boolean) => write(INDEX_KEY, on);

/** Folders pinned to the sidebar, in display order. */
const PINS_KEY = "splash.pins";
export const loadPins = () => read<string[]>(PINS_KEY, []);
export const savePins = (pins: string[]) => write(PINS_KEY, pins);

/** The Storage map's "how to get around" tip, until dismissed. */
const STORAGE_TIP_KEY = "splash.storageTipSeen";
export const loadStorageTipSeen = () => read<boolean>(STORAGE_TIP_KEY, false);
export const saveStorageTipSeen = () => write(STORAGE_TIP_KEY, true);
