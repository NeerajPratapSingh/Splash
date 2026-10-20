//! Watches the folders open in tabs and tells the UI when their contents
//! change outside the app (a download finishing, another program saving…).
//!
//! Changes are collected and sent at most every DEBOUNCE, as one
//! `dir-changed` event listing the affected folders, so a large download that
//! touches its file constantly doesn't cause a reload per write.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(500);

pub struct FolderWatcher {
    watcher: Mutex<RecommendedWatcher>,
    watched: Mutex<HashSet<PathBuf>>,
}

impl FolderWatcher {
    pub fn new(app: AppHandle) -> notify::Result<Self> {
        let pending: Arc<Mutex<HashSet<PathBuf>>> = Arc::default();

        let sink = pending.clone();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                let mut dirs = sink.lock().unwrap();
                for path in event.paths {
                    // A changed item lives in the watched folder; the folder
                    // itself appears when it is renamed or deleted.
                    if let Some(parent) = path.parent() {
                        dirs.insert(parent.to_path_buf());
                    }
                    dirs.insert(path);
                }
            }
        })?;

        std::thread::spawn(move || loop {
            std::thread::sleep(DEBOUNCE);
            let dirs: Vec<String> = pending
                .lock()
                .unwrap()
                .drain()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            if !dirs.is_empty() {
                let _ = app.emit("dir-changed", dirs);
            }
        });

        Ok(Self {
            watcher: Mutex::new(watcher),
            watched: Mutex::default(),
        })
    }

    /// Watch exactly `dirs` (the folders currently open in tabs).
    pub fn set(&self, dirs: Vec<String>) {
        let wanted: HashSet<PathBuf> = dirs.into_iter().map(PathBuf::from).collect();
        let mut watched = self.watched.lock().unwrap();
        let mut watcher = self.watcher.lock().unwrap();
        for gone in watched.difference(&wanted) {
            let _ = watcher.unwatch(gone);
        }
        for new in wanted.difference(&watched) {
            // Folders we can't watch (removed drive, no permission) just won't auto-refresh.
            let _ = watcher.watch(new, RecursiveMode::NonRecursive);
        }
        *watched = wanted;
    }
}
