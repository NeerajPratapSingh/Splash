# WinFiles

**A fast, lightweight file explorer for Windows.** Tabs, split view, drag and
drop, photo previews and archives, in a 1.4 MB installer that opens a
25,000-item folder in under a second.

Free and open source (MIT). Built with [Tauri 2](https://tauri.app) (Rust) and React.

<!-- TODO: add a screenshot: docs/screenshot.png -->

## Features

- **Tabs and split view.** Open folders in tabs (`Ctrl+T`); hover a tab to put it side by side with another (`F3`).
- **Drag and drop** between panes, tabs, the sidebar, and to or from Windows Explorer and the desktop. Moves within a drive, copies across drives (`Ctrl` = copy, `Shift` = move), with **Undo** and **Move instead** right after.
- **Photo and video thumbnails** from Windows' own thumbnail cache, plus a full-size preview on `Space`.
- **Archives.** Compress to ZIP; extract ZIP, 7z, RAR and TAR/GZ. Never overwrites existing files.
- **The full right-click menu.** Open with, Properties, Open in Terminal, Copy as path, and everything other apps add (WinRAR, OneDrive, PowerRename, Send to…), in submenus that open on hover.
- **Sorting and filtering.** Sort by name (natural `1, 2, 10` order), date, size or type; group by date or type; filter by kind. Remembered per folder, and Downloads shows the newest first, like Explorer.
- **Sidebar.** Quick access, OneDrive, your pinned folders (right-click a folder → *Pin to sidebar*) and drives with free-space bars.
- **Keyboard first.** Arrows, type-to-jump, `Ctrl+L` to type a path, and the shortcuts below.
- **Auto-refresh.** Changes from other programs (a finished download, a saved file) show up on their own.
- **Fast with huge folders.** Only the rows on screen are drawn.
- Deleting always goes to the **Recycle Bin**.

## Install

Download `WinFiles_x.y.z_x64-setup.exe` from the [Releases](../../releases)
page and run it. Requires Windows 10 or 11 (64-bit).

> The installer isn't code-signed yet, so Windows SmartScreen may show
> "Windows protected your PC". Click **More info → Run anyway**.

## Keyboard shortcuts

| Action | Keys |
|---|---|
| New tab / close tab / next tab | `Ctrl+T` / `Ctrl+W` / `Ctrl+Tab` |
| Split view on/off | `F3` |
| Type a path | `Ctrl+L` (or click the address bar) |
| Back / Forward / Up | `Alt+←` / `Alt+→` / `Alt+↑`, `Backspace` = back |
| Move selection / extend | `↑ ↓ ← →` / `Shift+arrows`, `Home`, `End` |
| Jump to a name | just start typing |
| Preview photo | `Space` (`←` `→` to browse) |
| Open | `Enter` / double-click |
| Rename | `F2` |
| Delete (to Recycle Bin) | `Del` |
| Copy / Cut / Paste | `Ctrl+C` / `Ctrl+X` / `Ctrl+V` |
| Copy as path | `Ctrl+Shift+C` |
| Properties | `Alt+Enter` |
| New folder | `Ctrl+Shift+N` |
| Select all / clear selection | `Ctrl+A` / `Esc` |
| Grid / list view | `Ctrl+Shift+V` |
| Search this folder | `Ctrl+F` (`Enter` searches subfolders) |
| Refresh | `F5` |

## Build from source

You need:

1. [Node.js](https://nodejs.org) LTS
2. [Rust](https://rustup.rs) (default `x86_64-pc-windows-msvc` toolchain)
3. [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with **Desktop development with C++**
4. WebView2. It ships with Windows 10/11; otherwise get the [Evergreen runtime](https://developer.microsoft.com/microsoft-edge/webview2/).

```powershell
npm install
npm run tauri dev     # run with hot reload (first build takes a few minutes)
npm run tauri build   # installer -> src-tauri/target/release/bundle/nsis/
```

## Project layout

```
src/                     React + TypeScript UI
  App.tsx                tabs, panes, clipboard, drops, notices, shortcuts
  components/
    Explorer.tsx         one tab: history, listing, selection, menus, keys
    FileView.tsx         virtualized list/grid, thumbnails, rename
    Pane.tsx, TabBar.tsx, Sidebar.tsx, Toolbar.tsx, ContextMenu.tsx …
  api.ts                 typed calls into the Rust backend
  dnd.ts                 native drag and drop
  thumbs.ts, viewPrefs.ts, util.ts
src-tauri/src/           Rust backend
  lib.rs                 Tauri commands
  fs_ops.rs              file operations (list, copy, move, rename, trash…)
  archive.rs             ZIP create/extract; 7z/RAR/TAR via Windows' tar
  shell.rs               Windows shell: right-click entries, Properties, Open with
  thumbs.rs              thumbnails from the Windows thumbnail cache
  watch.rs               auto-refresh when folders change
```

## Contributing

Bug reports and pull requests are welcome. Please open an
[issue](../../issues) first for bigger changes, so we can agree on the approach.

## Support

WinFiles is free and always will be. If it saves you time and you'd like to
say thanks, you can buy me a coffee. It's completely optional, and it helps
me keep working on it. <!-- TODO: Buy Me a Coffee link -->

## License

[MIT](LICENSE) © 2026 Neeraj Pratap Singh
