mod archive;
#[cfg(windows)]
mod default_app;
mod fs_ops;
mod index;
mod search;
#[cfg(windows)]
mod shell;
mod space;
mod thumbs;
mod watch;

use tauri::{Emitter, Manager};

use fs_ops::{DriveInfo, Entry, QuickLink};

/// Run blocking filesystem work off the main thread so the UI never stalls
/// (non-async Tauri commands run on the main thread).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

/// Run `f` with the window handle on the window's own thread (shell menus and
/// dialogs need it) and wait for its result without blocking that thread.
#[cfg(windows)]
async fn on_window_thread<T: Send + 'static>(
    window: &tauri::WebviewWindow,
    f: impl FnOnce(windows::Win32::Foundation::HWND) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(f(windows::Win32::Foundation::HWND(hwnd as _)));
        })
        .map_err(|e| e.to_string())?;
    blocking(move || rx.recv().map_err(|e| e.to_string())).await??
}

#[cfg(not(windows))]
async fn on_window_thread<T>(
    _window: &tauri::WebviewWindow,
    _f: impl FnOnce(()) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    Err("Only available on Windows".into())
}

/// Run a file operation at most once per `op_id`.
///
/// If a request fails inside the webview, Tauri's IPC re-sends it through its
/// fallback channel, possibly after the backend already did the work. Every
/// operation that changes files (or opens windows) carries a random id from
/// the UI; a repeat waits for the first run and returns its result instead of
/// copying, moving or zipping twice.
async fn once<T>(op_id: &str, f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String>
where
    T: serde::Serialize + serde::de::DeserializeOwned + Send + 'static,
{
    use std::collections::HashMap;
    use std::sync::{Arc, LazyLock, Mutex};
    use std::time::{Duration, Instant};
    type Outcome = Result<serde_json::Value, String>;
    static OPS: LazyLock<Mutex<HashMap<String, (Instant, Arc<tokio::sync::OnceCell<Outcome>>)>>> =
        LazyLock::new(Mutex::default);

    let cell = {
        let mut ops = OPS.lock().unwrap();
        ops.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(600));
        ops.entry(op_id.to_string())
            .or_insert_with(|| (Instant::now(), Arc::default()))
            .1
            .clone()
    };
    let outcome = cell
        .get_or_init(|| async move {
            blocking(f).await?.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        })
        .await
        .clone();
    outcome.and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}

#[tauri::command]
async fn compress(paths: Vec<String>, op_id: String) -> Result<String, String> {
    once(&op_id, move || archive::compress(paths)).await
}

#[tauri::command]
async fn extract(archive: String, into_folder: bool, op_id: String) -> Result<String, String> {
    once(&op_id, move || archive::extract(archive, into_folder)).await
}

/// The extra right-click entries other apps add ("Show more options").
/// Built on the shell thread so the window never stalls while extensions load.
#[tauri::command]
async fn shell_menu_items(window: tauri::WebviewWindow, paths: Vec<String>) -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        return blocking(move || {
            shell::on_shell_thread(move || {
                shell::native_menu_items(windows::Win32::Foundation::HWND(hwnd as _), &paths)
                    .and_then(|items| serde_json::to_value(items).map_err(|e| e.to_string()))
            })
        })
        .await?;
    }
    #[cfg(not(windows))]
    return on_window_thread(&window, move |_| Ok(serde_json::json!(paths.len()))).await;
}

#[tauri::command]
async fn shell_menu_invoke(window: tauri::WebviewWindow, id: u32, op_id: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = &window;
        return once(&op_id, move || shell::on_shell_thread(move || shell::invoke_native_item(id))).await;
    }
    #[cfg(not(windows))]
    return on_window_thread(&window, move |_| Ok(drop((id, op_id)))).await;
}

#[tauri::command]
async fn properties(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    #[cfg(windows)]
    return on_window_thread(&window, move |hwnd| shell::properties(hwnd, &path)).await;
    #[cfg(not(windows))]
    return on_window_thread(&window, move |_| Ok(drop(path))).await;
}

#[tauri::command]
async fn open_with(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    #[cfg(windows)]
    return on_window_thread(&window, move |hwnd| shell::open_with(hwnd, &path)).await;
    #[cfg(not(windows))]
    return on_window_thread(&window, move |_| Ok(drop(path))).await;
}

#[tauri::command]
async fn open_terminal(dir: String, op_id: String) -> Result<(), String> {
    #[cfg(windows)]
    return once(&op_id, move || shell::open_terminal(&dir)).await;
    #[cfg(not(windows))]
    return Err(format!("Only available on Windows ({dir}, {op_id})"));
}

#[tauri::command]
async fn list_dir(path: String) -> Result<Vec<Entry>, String> {
    blocking(move || fs_ops::list_dir(&path)).await?
}

#[tauri::command]
async fn list_drives() -> Result<Vec<DriveInfo>, String> {
    // Free-space queries can stall on disconnected network drives.
    blocking(fs_ops::list_drives).await
}

#[tauri::command]
fn quick_links() -> Vec<QuickLink> {
    fs_ops::quick_links()
}

#[tauri::command]
fn home_dir() -> String {
    fs_ops::home_dir()
}

#[tauri::command]
fn parent_dir(path: String) -> Option<String> {
    fs_ops::parent_dir(&path)
}

#[tauri::command]
async fn rename(path: String, new_name: String, op_id: String) -> Result<String, String> {
    once(&op_id, move || fs_ops::rename(&path, &new_name)).await
}

#[tauri::command]
async fn delete_to_trash(paths: Vec<String>, op_id: String) -> Result<(), String> {
    once(&op_id, move || fs_ops::delete_to_trash(paths)).await
}

#[tauri::command]
async fn create_folder(parent: String, name: String, op_id: String) -> Result<String, String> {
    once(&op_id, move || fs_ops::create_folder(&parent, &name)).await
}

#[tauri::command]
async fn create_file(parent: String, name: String, op_id: String) -> Result<String, String> {
    once(&op_id, move || fs_ops::create_file(&parent, &name)).await
}

#[tauri::command]
async fn copy_entries(paths: Vec<String>, dest_dir: String, op_id: String) -> Result<Vec<String>, String> {
    once(&op_id, move || fs_ops::copy_entries(paths, &dest_dir)).await
}

#[tauri::command]
async fn move_entries(paths: Vec<String>, dest_dir: String, op_id: String) -> Result<Vec<String>, String> {
    once(&op_id, move || fs_ops::move_entries(paths, &dest_dir)).await
}

#[tauri::command]
async fn restore(items: Vec<(String, String)>, op_id: String) -> Result<(), String> {
    once(&op_id, move || fs_ops::restore(items)).await
}

#[tauri::command]
async fn open_path(path: String, op_id: String) -> Result<(), String> {
    once(&op_id, move || fs_ops::open_path(&path)).await
}

#[tauri::command]
async fn reveal(path: String, op_id: String) -> Result<(), String> {
    once(&op_id, move || fs_ops::reveal(&path)).await
}

/// Search names under `scope` (a folder, or "pc" for every drive), streaming
/// matches to `on_event`. A new search cancels the previous one.
#[tauri::command]
async fn search_files(
    scope: String,
    query: String,
    on_event: tauri::ipc::Channel<search::SearchEvent>,
) -> Result<(), String> {
    blocking(move || search::search(scope, query, on_event)).await
}

#[tauri::command]
fn cancel_search() {
    search::cancel();
}

/// The "Instant search" setting: keep a name index of every drive (or not).
#[tauri::command]
fn set_search_index(enabled: bool) {
    index::set_enabled(enabled);
}

/// Storage: scan `root` (a drive or folder) for what takes room, streaming
/// progress to `on_event`. A new scan stops the previous one.
#[tauri::command]
async fn scan_space(root: String, on_event: tauri::ipc::Channel<space::ScanEvent>) -> Result<(), String> {
    blocking(move || space::scan(root, on_event)).await
}

#[tauri::command]
fn cancel_space_scan() {
    space::cancel();
}

/// The last finished scan of `root`, if any (kept until Splash closes).
#[tauri::command]
fn space_info(root: String) -> Option<space::ScanInfo> {
    space::info(&root)
}

/// A folder from the scan of `root`, with three levels of children for the treemap.
#[tauri::command]
async fn space_view(root: String, path: String) -> Result<space::View, String> {
    blocking(move || space::view(&root, &path)).await?
}

#[tauri::command]
async fn space_suggestions(root: String) -> Result<Vec<space::Suggestion>, String> {
    blocking(move || space::suggestions_for(&root)).await?
}

/// Measure `paths` again after they changed, updating the scan's totals and suggestions.
#[tauri::command]
async fn space_refresh(root: String, paths: Vec<String>) -> Result<space::ScanInfo, String> {
    blocking(move || space::refresh(&root, paths)).await?
}

/// Cleanup: empty suggested folders (and remove suggested files) into the
/// Recycle Bin. Resolves to how many items were in use and left behind.
#[tauri::command]
async fn clean_up(paths: Vec<String>, op_id: String) -> Result<u64, String> {
    once(&op_id, move || Ok(space::clean(paths))).await
}

#[tauri::command]
async fn recycle_bin_size() -> Result<u64, String> {
    blocking(space::recycle_bin_size).await
}

#[tauri::command]
async fn empty_recycle_bin(op_id: String) -> Result<(), String> {
    once(&op_id, space::empty_recycle_bin).await
}

#[derive(serde::Serialize)]
struct Modifiers {
    ctrl: bool,
    shift: bool,
}

/// Ctrl/Shift state during a native drag (the webview gets no key events
/// while Windows runs the drag loop). Async so it never waits on the main thread.
#[tauri::command]
async fn key_modifiers() -> Modifiers {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL, VK_SHIFT};
        Modifiers {
            ctrl: GetAsyncKeyState(VK_CONTROL.0 as i32) < 0,
            shift: GetAsyncKeyState(VK_SHIFT.0 as i32) < 0,
        }
    }
    #[cfg(not(windows))]
    Modifiers {
        ctrl: false,
        shift: false,
    }
}

/// Folder Splash was started with (e.g. by Windows when it's the default), once.
struct LaunchPath(std::sync::Mutex<Option<String>>);

/// The first command-line argument that looks like a path (not a flag).
fn path_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .map(|a| a.trim_matches('"').to_string())
}

#[tauri::command]
fn launch_path(state: tauri::State<'_, LaunchPath>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[tauri::command]
fn is_default_app() -> bool {
    #[cfg(windows)]
    return default_app::is_default();
    #[cfg(not(windows))]
    return false;
}

#[tauri::command]
fn set_default_app(on: bool) -> Result<(), String> {
    #[cfg(windows)]
    return default_app::set_default(on);
    #[cfg(not(windows))]
    return Err(format!("Only available on Windows ({on})"));
}

/// Auto-refresh: watch exactly these folders (the ones open in tabs).
#[tauri::command]
fn watch_dirs(app: tauri::AppHandle, dirs: Vec<String>) {
    if let Some(watcher) = app.try_state::<watch::FolderWatcher>() {
        watcher.set(dirs);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let thumbs = thumbs::Pool::new();
    let args: Vec<String> = std::env::args().collect();
    tauri::Builder::default()
        // Must be first: a second launch (e.g. double-clicking a folder while
        // Splash is the default) hands its folder to the running window instead.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let _ = app.emit("open-path", path_arg(&argv));
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(LaunchPath(std::sync::Mutex::new(path_arg(&args))))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .setup(|app| {
            if let Ok(dir) = app.path().app_local_data_dir() {
                index::init(dir.join("search-index.bin"));
            }
            // Without a watcher the app still works; folders just don't auto-refresh.
            if let Ok(watcher) = watch::FolderWatcher::new(app.handle().clone()) {
                app.manage(watcher);
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("thumb", move |_ctx, req, responder| {
            thumbs.submit(req, responder)
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            list_drives,
            quick_links,
            home_dir,
            parent_dir,
            rename,
            delete_to_trash,
            create_folder,
            create_file,
            copy_entries,
            move_entries,
            restore,
            open_path,
            reveal,
            search_files,
            cancel_search,
            set_search_index,
            scan_space,
            cancel_space_scan,
            space_info,
            space_view,
            space_suggestions,
            space_refresh,
            clean_up,
            recycle_bin_size,
            empty_recycle_bin,
            key_modifiers,
            compress,
            extract,
            shell_menu_items,
            shell_menu_invoke,
            properties,
            open_with,
            open_terminal,
            watch_dirs,
            launch_path,
            is_default_app,
            set_default_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running Splash");
}
