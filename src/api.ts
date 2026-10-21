import { Channel, invoke } from "@tauri-apps/api/core";
import type { Entry, DriveInfo, QuickLink, NativeItem, SearchEvent } from "./types";

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
  /** Watch these folders; changes arrive as "dir-changed" events. */
  watchDirs: (dirs: string[]) => invoke<void>("watch_dirs", { dirs }),
};
