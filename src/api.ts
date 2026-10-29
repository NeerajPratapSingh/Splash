import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Entry,
  DriveInfo,
  QuickLink,
  NativeItem,
  SearchEvent,
  ScanEvent,
  ScanInfo,
  SpaceNode,
  Suggestion,
} from "./types";

/** `scope` for searchFiles meaning the whole PC (user folders first, then every drive). */
export const SEARCH_PC_SCOPE = "pc";

/**
 * A fresh id for one file operation. If Tauri's IPC re-sends a request (its
 * fallback after a failed first attempt), the backend sees the same id and
 * returns the first result instead of doing the work twice.
 */
const op = () => crypto.randomUUID();

export const api = {
  listDir: (path: string) => invoke<Entry[]>("list_dir", { path }),
  listDrives: () => invoke<DriveInfo[]>("list_drives"),
  quickLinks: () => invoke<QuickLink[]>("quick_links"),
  homeDir: () => invoke<string>("home_dir"),
  parentDir: (path: string) => invoke<string | null>("parent_dir", { path }),
  rename: (path: string, newName: string) =>
    invoke<string>("rename", { path, newName, opId: op() }),
  deleteToTrash: (paths: string[]) =>
    invoke<void>("delete_to_trash", { paths, opId: op() }),
  createFolder: (parent: string, name: string) =>
    invoke<string>("create_folder", { parent, name, opId: op() }),
  createFile: (parent: string, name: string) =>
    invoke<string>("create_file", { parent, name, opId: op() }),
  /** Resolves to the new paths, in the same order as `paths`. */
  copyEntries: (paths: string[], destDir: string) =>
    invoke<string[]>("copy_entries", { paths, destDir, opId: op() }),
  /** Resolves to the new paths, in the same order as `paths`. */
  moveEntries: (paths: string[], destDir: string) =>
    invoke<string[]>("move_entries", { paths, destDir, opId: op() }),
  /** Undo a move: [currentPath, originalPath] pairs. */
  restore: (items: [string, string][]) => invoke<void>("restore", { items, opId: op() }),
  openPath: (path: string) => invoke<void>("open_path", { path, opId: op() }),
  reveal: (path: string) => invoke<void>("reveal", { path, opId: op() }),
  /**
   * Search names under `scope` (a folder path, or SEARCH_PC_SCOPE for every
   * drive). Matches stream to `onEvent`; a new search cancels the previous one.
   */
  searchFiles: (scope: string, query: string, onEvent: (e: SearchEvent) => void) => {
    const channel = new Channel<SearchEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("search_files", { scope, query, onEvent: channel });
  },
  cancelSearch: () => invoke<void>("cancel_search"),
  /** Instant search: keep a name index of every drive (built on first PC search). */
  setSearchIndex: (enabled: boolean) => invoke<void>("set_search_index", { enabled }),
  /** Zip items (from one folder) into "<first>.zip" beside them; resolves to its path. */
  compress: (paths: string[]) => invoke<string>("compress", { paths, opId: op() }),
  /** Unpack an archive next to itself; resolves to the new folder (or the containing one). */
  extract: (archive: string, intoFolder: boolean) =>
    invoke<string>("extract", { archive, intoFolder, opId: op() }),
  /** Extra right-click entries other apps add (Show more options). */
  shellMenuItems: (paths: string[]) => invoke<NativeItem[]>("shell_menu_items", { paths }),
  /** Run an entry from the last shellMenuItems call. */
  shellMenuInvoke: (id: number) => invoke<void>("shell_menu_invoke", { id, opId: op() }),
  properties: (path: string) => invoke<void>("properties", { path }),
  openWith: (path: string) => invoke<void>("open_with", { path }),
  openTerminal: (dir: string) => invoke<void>("open_terminal", { dir, opId: op() }),
  /** Folder Splash was started with (once), e.g. when opened as the default file manager. */
  launchPath: () => invoke<string | null>("launch_path"),
  isDefaultApp: () => invoke<boolean>("is_default_app"),
  /** Make Splash open folders, drives and Win+E (or hand them back to Explorer). */
  setDefaultApp: (on: boolean) => invoke<void>("set_default_app", { on }),
  /** Storage: scan a drive or folder for what takes room; a new scan stops the previous one. */
  scanSpace: (root: string, onEvent: (e: ScanEvent) => void) => {
    const channel = new Channel<ScanEvent>();
    channel.onmessage = onEvent;
    return invoke<void>("scan_space", { root, onEvent: channel });
  },
  cancelSpaceScan: () => invoke<void>("cancel_space_scan"),
  /** The last finished scan of `root` (kept while Splash runs), or null. */
  spaceInfo: (root: string) => invoke<ScanInfo | null>("space_info", { root }),
  /** A folder from the scan of `root`, with three levels of children. */
  spaceView: (root: string, path: string) =>
    invoke<{ info: ScanInfo; node: SpaceNode }>("space_view", { root, path }),
  spaceSuggestions: (root: string) => invoke<Suggestion[]>("space_suggestions", { root }),
  /** Measure `paths` again after they changed; resolves to the updated totals. */
  spaceRefresh: (root: string, paths: string[]) =>
    invoke<ScanInfo>("space_refresh", { root, paths }),
  /** Empty suggested folders (and remove suggested files) into the Recycle Bin; resolves to how many were in use. */
  cleanUp: (paths: string[]) => invoke<number>("clean_up", { paths, opId: op() }),
  recycleBinSize: () => invoke<number>("recycle_bin_size"),
  emptyRecycleBin: () => invoke<void>("empty_recycle_bin", { opId: op() }),
  /** Watch these folders; changes arrive as "dir-changed" events. */
  watchDirs: (dirs: string[]) => invoke<void>("watch_dirs", { dirs }),
};
