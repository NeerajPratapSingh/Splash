export interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number; // seconds since epoch
  created: number; // seconds since epoch
  extension: string;
  hidden: boolean; // hidden/system attribute
}

export interface DriveInfo {
  name: string;
  path: string;
  total: number; // bytes; 0 if unknown
  free: number; // bytes available to this user
}

export interface QuickLink {
  name: string;
  path: string;
  kind: string;
}

export type SortKey = "name" | "size" | "modified" | "created" | "type";
export type SortDir = "asc" | "desc";
export type ViewMode = "grid" | "list";
export type GroupBy = "none" | "date" | "type";
export type Kind =
  | "folder" | "image" | "video" | "audio" | "document" | "archive" | "code" | "app" | "other";

/** How a folder is displayed; remembered per folder. */
export interface FolderView {
  view: ViewMode;
  sortKey: SortKey;
  sortDir: SortDir;
  groupBy: GroupBy;
  foldersFirst: boolean;
}

/** Streamed from a name search. */
export type SearchEvent =
  | { kind: "batch"; entries: Entry[]; scanned: number }
  | { kind: "done"; scanned: number; found: number; ms: number; truncated: boolean; cancelled: boolean };

/** Tab "path" of the Search this PC view (not a real folder). */
export const SEARCH_PC = "search:";

/** An entry from Windows' own right-click menu (WinRAR, Send to…). */
export interface NativeItem {
  id: number;
  label: string;
  verb: string | null; // language-independent action, e.g. "openas"
  icon: string | null; // PNG data URL
  disabled: boolean;
  separator: boolean;
  children: NativeItem[];
}

export interface Tab {
  id: number;
  /** Folder the tab is showing (kept in sync as the tab navigates). */
  path: string;
}

export interface PaneState {
  id: number;
  tabs: Tab[];
  active: number; // id of the visible tab
}

export interface Clipboard {
  paths: string[];
  mode: "copy" | "cut";
}

/** Tab "path" of the Storage view (not a real folder). */
export const STORAGE = "storage:";

/** Views that live in a tab but aren't folders. */
export const isVirtual = (path: string) => path === SEARCH_PC || path === STORAGE;

/** A finished storage scan. */
export interface ScanInfo {
  root: string;
  size: number; // bytes found
  files: number;
  denied: number; // folders that couldn't be read
  ms: number;
  at: number; // epoch seconds
  safe: number; // bytes in "safe to remove" suggestions
  review: number; // bytes in "review first" suggestions
}

/** Streamed from a storage scan. */
export type ScanEvent =
  | { kind: "progress"; files: number; bytes: number; dir: string }
  | { kind: "done"; info: ScanInfo | null; cancelled: boolean };

/** A box in the storage treemap. Groups ("12 small files") have no path. */
export interface SpaceNode {
  name: string;
  path: string;
  size: number;
  files: number;
  isDir: boolean;
  cat: number; // index into CATEGORIES
  modified: number;
  flag: "safe" | "review" | null;
  denied: boolean;
  children: SpaceNode[];
}

/** Streamed while cleaning up: `done` of `total` suggested items finished. */
export interface CleanProgress {
  done: number;
  total: number;
  path: string; // the item being cleaned now
}

/** Things worth cleaning up, grouped by why. */
export interface Suggestion {
  id: string;
  label: string;
  note: string;
  safe: boolean; // false: review first
  size: number;
  items: { path: string; size: number }[];
}
