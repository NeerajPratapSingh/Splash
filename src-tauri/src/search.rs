//! Search by name across a folder or the whole PC, streaming results live.
//!
//! Folders are walked in parallel on all cores (the `ignore` crate's walker,
//! with every ignore-file rule turned off). For "Search this PC" the user's
//! own folders go first, so likely matches appear within a moment, then
//! every drive. Starting a new search (or `cancel`) stops the previous one.

use ignore::{WalkBuilder, WalkState};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

use crate::fs_ops::{entry_from, Entry};

/// Scope value meaning "every drive, user folders first".
pub const WHOLE_PC: &str = "pc";
const MAX_RESULTS: usize = 5000;
const FLUSH_EVERY: Duration = Duration::from_millis(120);

/// Bumped by every new search and by `cancel`; a walk stops when it changes.
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SearchEvent {
    /// New matches since the last batch.
    Batch { entries: Vec<Entry>, scanned: usize },
    /// The search finished (or was cancelled / hit the result limit).
    #[serde(rename_all = "camelCase")]
    Done { scanned: usize, found: usize, ms: u64, truncated: bool, cancelled: bool },
}

pub fn cancel() {
    GENERATION.fetch_add(1, SeqCst);
}

/// Folders that are never worth searching (system bookkeeping, component store).
pub(crate) fn is_skipped(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name == "$recycle.bin" || name == "system volume information" {
        return true;
    }
    let lower = path.to_string_lossy().to_lowercase();
    lower.ends_with(r"\windows\winsxs") || lower.ends_with(r"\windows\installer")
}

/// Matches from the in-memory index (plus items added since it was built).
/// Each match is looked up fresh, so sizes and dates are current and deleted
/// items drop out.
fn search_index(
    index: &crate::index::Index,
    words: &[String],
    generation: u64,
    started: Instant,
    events: &Channel<SearchEvent>,
) {
    let mut paths: Vec<PathBuf> = crate::index::find_added(words);
    let known: std::collections::HashSet<PathBuf> = paths.iter().cloned().collect();
    paths.extend(
        index
            .find(words, MAX_RESULTS)
            .into_iter()
            .map(|i| index.path(i as usize))
            .filter(|p| !known.contains(p)),
    );
    let truncated = paths.len() >= MAX_RESULTS;
    paths.truncate(MAX_RESULTS);

    let mut found = 0;
    let mut batch = Vec::new();
    for (n, p) in paths.iter().enumerate() {
        if GENERATION.load(SeqCst) != generation {
            break;
        }
        if let Some(e) = fs::symlink_metadata(p).ok().and_then(|m| entry_from(p, &m)) {
            batch.push(e);
            found += 1;
        }
        // Send the first results right away, then in chunks.
        if batch.len() >= 200 || (n == 40 && !batch.is_empty()) {
            let _ = events.send(SearchEvent::Batch { entries: std::mem::take(&mut batch), scanned: index_len(index) });
        }
    }
    if !batch.is_empty() {
        let _ = events.send(SearchEvent::Batch { entries: batch, scanned: index_len(index) });
    }
    let _ = events.send(SearchEvent::Done {
        scanned: index_len(index),
        found,
        ms: started.elapsed().as_millis() as u64,
        truncated,
        cancelled: GENERATION.load(SeqCst) != generation,
    });
}

fn index_len(index: &crate::index::Index) -> usize {
    index.item_count()
}

pub fn search(scope: String, query: String, events: Channel<SearchEvent>) {
    let generation = GENERATION.fetch_add(1, SeqCst) + 1;
    let started = Instant::now();
    let words: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();

    // Search this PC with the index ready: answer from memory.
    if scope == WHOLE_PC && !words.is_empty() {
        if let Some(index) = crate::index::ready() {
            return search_index(&index, &words, generation, started, &events);
        }
    }

    let found: Arc<Mutex<Vec<Entry>>> = Arc::default();
    let found_count = Arc::new(AtomicUsize::new(0));
    let scanned = Arc::new(AtomicUsize::new(0));
    let truncated = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));

    // Sends whatever was found since the last tick.
    let flusher = {
        let (found, scanned, finished, events) = (found.clone(), scanned.clone(), finished.clone(), events.clone());
        std::thread::spawn(move || loop {
            std::thread::sleep(FLUSH_EVERY);
            let done = finished.load(SeqCst);
            let batch = std::mem::take(&mut *found.lock().unwrap());
            if !batch.is_empty() {
                let _ = events.send(SearchEvent::Batch { entries: batch, scanned: scanned.load(SeqCst) });
            }
            if done {
                break;
            }
        })
    };

    if !words.is_empty() {
        // (root, folders to leave out of this pass)
        let mut passes: Vec<(PathBuf, Vec<PathBuf>)> = Vec::new();
        if scope == WHOLE_PC {
            // 1. Your own folders (Desktop, Documents, Downloads, OneDrive…), where
            //    saved files almost always are. 2. Every drive. 3. AppData last:
            //    it's huge (app caches) and rarely where people save things.
            let home = dirs::home_dir();
            let app_data = home.as_ref().map(|h| h.join("AppData"));
            if let (Some(h), Some(a)) = (&home, &app_data) {
                passes.push((h.clone(), vec![a.clone()]));
            }
            for d in crate::fs_ops::list_drives() {
                passes.push((PathBuf::from(d.path), home.iter().cloned().collect()));
            }
            if let Some(a) = app_data {
                passes.push((a, Vec::new()));
            }
        } else {
            passes.push((PathBuf::from(&scope), Vec::new()));
        }

        for (root, exclude) in passes {
            if GENERATION.load(SeqCst) != generation || truncated.load(SeqCst) {
                break;
            }
            let exclude = Arc::new(exclude);
            let walker = WalkBuilder::new(&root)
                .standard_filters(false) // no .gitignore/hidden rules: this is a file manager
                .follow_links(false) // junctions like "Application Data" would loop
                .filter_entry({
                    let exclude = exclude.clone();
                    move |e| !is_skipped(e.path()) && !exclude.iter().any(|x| x == e.path())
                })
                .build_parallel();
            walker.run(|| {
                let (words, found, found_count, scanned, truncated) =
                    (&words, found.clone(), found_count.clone(), scanned.clone(), truncated.clone());
                Box::new(move |result| {
                    if GENERATION.load(SeqCst) != generation {
                        return WalkState::Quit;
                    }
                    let Ok(entry) = result else { return WalkState::Continue };
                    scanned.fetch_add(1, SeqCst);
                    if entry.depth() == 0 {
                        return WalkState::Continue;
                    }
                    let name = entry.file_name().to_string_lossy().to_lowercase();
                    if words.iter().all(|w| name.contains(w.as_str())) {
                        if let Some(e) = entry.metadata().ok().and_then(|m| entry_from(entry.path(), &m)) {
                            found.lock().unwrap().push(e);
                            if found_count.fetch_add(1, SeqCst) + 1 >= MAX_RESULTS {
                                truncated.store(true, SeqCst);
                                return WalkState::Quit;
                            }
                        }
                    }
                    WalkState::Continue
                })
            });
        }
    }

    finished.store(true, SeqCst);
    let _ = flusher.join();
    let _ = events.send(SearchEvent::Done {
        scanned: scanned.load(SeqCst),
        found: found_count.load(SeqCst),
        ms: started.elapsed().as_millis() as u64,
        truncated: truncated.load(SeqCst),
        cancelled: GENERATION.load(SeqCst) != generation,
    });
}
