//! Instant "Search this PC": a compact in-memory list of every file and folder
//! name on all drives, saved to disk between runs.
//!
//! Layout (≈ 34 MB for 1.2 M items): all names in one string, an offset per
//! item, and a parent link per item (folders are stored once and shared), so
//! paths are rebuilt only for matches. Size and dates aren't stored: results
//! are looked up fresh, which also drops anything deleted since the scan.
//!
//! Lifecycle: built on the first PC search (that search runs live meanwhile),
//! saved to disk, reloaded on demand, refreshed in the background after load
//! and when the drives have changed, and dropped from memory after a while
//! unused. A recursive watcher on every drive records new and renamed items
//! in between rebuilds.

use ignore::{WalkBuilder, WalkState};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering::SeqCst};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Parent value for items directly under root `k`: `ROOT | k`.
const ROOT: u32 = 0x8000_0000;
const MAGIC: &[u8; 4] = b"SPX1";
/// Drop the in-memory index after this long without a search.
const IDLE_DROP: Duration = Duration::from_secs(10 * 60);
/// Rebuild in the background when changed and the last build is older than this.
const REFRESH_AFTER: Duration = Duration::from_secs(15 * 60);
/// Items added since the last build, searched alongside the index; past this, rebuild.
const MAX_ADDED: usize = 50_000;

pub struct Index {
    roots: Vec<String>,
    names: String,
    offs: Vec<u32>,
    parent: Vec<u32>,
    dirs: Vec<u64>,
}

impl Index {
    fn len(&self) -> usize {
        self.parent.len()
    }
    /// Number of files and folders in the index.
    pub fn item_count(&self) -> usize {
        self.len()
    }
    fn name(&self, i: usize) -> &str {
        &self.names[self.offs[i] as usize..self.offs[i + 1] as usize]
    }
    pub fn path(&self, i: usize) -> PathBuf {
        let mut parts = vec![self.name(i)];
        let mut p = self.parent[i];
        while p & ROOT == 0 {
            parts.push(self.name(p as usize));
            p = self.parent[p as usize];
        }
        let mut path = PathBuf::from(&self.roots[(p & !ROOT) as usize]);
        for part in parts.iter().rev() {
            path.push(part);
        }
        path
    }

    /// Indexes of items whose name contains every word (case-insensitive), up to `limit`.
    pub fn find(&self, words: &[String], limit: usize) -> Vec<u32> {
        let n = self.len();
        let threads = std::thread::available_parallelism().map(|t| t.get()).unwrap_or(4).min(16);
        let chunk = n.div_ceil(threads).max(1);
        let mut hits: Vec<u32> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..n)
                .step_by(chunk)
                .map(|start| {
                    s.spawn(move || {
                        let mut out = Vec::new();
                        for i in start..(start + chunk).min(n) {
                            if matches(self.name(i), words) {
                                out.push(i as u32);
                                if out.len() >= limit {
                                    break;
                                }
                            }
                        }
                        out
                    })
                })
                .collect();
            handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });
        hits.truncate(limit);
        hits
    }

    // ---- disk format: magic, roots, names, offsets, parents, folder bits (little-endian) ----

    fn save(&self, file: &Path) -> std::io::Result<()> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = file.with_extension("tmp");
        {
            let mut w = BufWriter::new(fs::File::create(&tmp)?);
            w.write_all(MAGIC)?;
            w.write_all(&(self.roots.len() as u32).to_le_bytes())?;
            for r in &self.roots {
                w.write_all(&(r.len() as u32).to_le_bytes())?;
                w.write_all(r.as_bytes())?;
            }
            w.write_all(&(self.names.len() as u32).to_le_bytes())?;
            w.write_all(self.names.as_bytes())?;
            w.write_all(&(self.parent.len() as u32).to_le_bytes())?;
            for v in &self.offs {
                w.write_all(&v.to_le_bytes())?;
            }
            for v in &self.parent {
                w.write_all(&v.to_le_bytes())?;
            }
            for v in &self.dirs {
                w.write_all(&v.to_le_bytes())?;
            }
            w.flush()?;
        }
        fs::rename(tmp, file)
    }

    fn load(file: &Path) -> Option<Index> {
        let mut bytes = Vec::new();
        fs::File::open(file).ok()?.read_to_end(&mut bytes).ok()?;
        let b = bytes.as_slice();
        let mut at = 0usize;
        fn take<'a>(b: &'a [u8], at: &mut usize, len: usize) -> Option<&'a [u8]> {
            let s = b.get(*at..*at + len)?;
            *at += len;
            Some(s)
        }
        fn read_u32(b: &[u8], at: &mut usize) -> Option<u32> {
            Some(u32::from_le_bytes(take(b, at, 4)?.try_into().ok()?))
        }
        fn u32s(b: &[u8]) -> Vec<u32> {
            b.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect()
        }
        if take(b, &mut at, 4)? != MAGIC {
            return None;
        }
        let root_count = read_u32(b, &mut at)? as usize;
        let mut roots = Vec::with_capacity(root_count);
        for _ in 0..root_count {
            let len = read_u32(b, &mut at)? as usize;
            roots.push(String::from_utf8(take(b, &mut at, len)?.to_vec()).ok()?);
        }
        let names_len = read_u32(b, &mut at)? as usize;
        let names = String::from_utf8(take(b, &mut at, names_len)?.to_vec()).ok()?;
        let n = read_u32(b, &mut at)? as usize;
        let offs = u32s(take(b, &mut at, (n + 1) * 4)?);
        let parent = u32s(take(b, &mut at, n * 4)?);
        let dirs = take(b, &mut at, n.div_ceil(64) * 8)?
            .chunks_exact(8)
            .map(|c| u64::from_le_bytes(c.try_into().unwrap()))
            .collect();
        Some(Index { roots, names, offs, parent, dirs })
    }
}

/// Case-insensitive "contains all words" (`words` already lowercase).
fn matches(name: &str, words: &[String]) -> bool {
    if name.is_ascii() && words.iter().all(|w| w.is_ascii()) {
        let hay = name.as_bytes();
        words.iter().all(|w| {
            let w = w.as_bytes();
            w.len() <= hay.len() && hay.windows(w.len()).any(|win| win.eq_ignore_ascii_case(w))
        })
    } else {
        let lower = name.to_lowercase();
        words.iter().all(|w| lower.contains(w.as_str()))
    }
}

/// Scan every drive in parallel into a fresh index.
fn build(roots: &[String]) -> Index {
    struct Rec {
        idx: u32,
        parent: u32,
        name: Box<str>,
        dir: bool,
    }
    const SHARDS: usize = 32;
    let next = AtomicU32::new(0);
    let folders: Vec<Mutex<HashMap<PathBuf, u32>>> = (0..SHARDS).map(|_| Mutex::default()).collect();
    let shard = |p: &Path| {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        p.hash(&mut h);
        h.finish() as usize % SHARDS
    };
    let collected: Mutex<Vec<Vec<Rec>>> = Mutex::default();

    for (k, root) in roots.iter().enumerate() {
        let root_path = PathBuf::from(root);
        folders[shard(&root_path)].lock().unwrap().insert(root_path.clone(), ROOT | k as u32);
        WalkBuilder::new(&root_path)
            .standard_filters(false)
            .follow_links(false)
            .filter_entry(|e| !crate::search::is_skipped(e.path()))
            .build_parallel()
            .run(|| {
                // Each thread collects locally and hands its records over when done.
                struct Local<'a> {
                    recs: Vec<Rec>,
                    out: &'a Mutex<Vec<Vec<Rec>>>,
                }
                impl Drop for Local<'_> {
                    fn drop(&mut self) {
                        self.out.lock().unwrap().push(std::mem::take(&mut self.recs));
                    }
                }
                let mut local = Local { recs: Vec::new(), out: &collected };
                let (next, folders, shard) = (&next, &folders, &shard);
                Box::new(move |res| {
                    let Ok(e) = res else { return WalkState::Continue };
                    if e.depth() == 0 {
                        return WalkState::Continue;
                    }
                    let path = e.path();
                    // A folder is always visited before anything inside it.
                    let Some(parent) = path
                        .parent()
                        .and_then(|p| folders[shard(p)].lock().unwrap().get(p).copied())
                    else {
                        return WalkState::Continue;
                    };
                    let dir = e.file_type().is_some_and(|t| t.is_dir());
                    let idx = next.fetch_add(1, SeqCst);
                    if dir {
                        folders[shard(path)].lock().unwrap().insert(path.to_path_buf(), idx);
                    }
                    local.recs.push(Rec {
                        idx,
                        parent,
                        name: e.file_name().to_string_lossy().into(),
                        dir,
                    });
                    WalkState::Continue
                })
            });
    }
    drop(folders);

    let mut recs: Vec<Rec> = collected.into_inner().unwrap().into_iter().flatten().collect();
    recs.sort_unstable_by_key(|r| r.idx);
    let n = recs.len();
    let mut names = String::with_capacity(recs.iter().map(|r| r.name.len()).sum());
    let mut offs = Vec::with_capacity(n + 1);
    let mut parent = Vec::with_capacity(n);
    let mut dirs = vec![0u64; n.div_ceil(64)];
    for (i, r) in recs.into_iter().enumerate() {
        offs.push(names.len() as u32);
        names.push_str(&r.name);
        parent.push(r.parent);
        if r.dir {
            dirs[i / 64] |= 1 << (i % 64);
        }
    }
    offs.push(names.len() as u32);
    Index { roots: roots.to_vec(), names, offs, parent, dirs }
}

// ---- shared state ----

struct State {
    enabled: AtomicBool,
    building: AtomicBool,
    dirty: AtomicBool,
    file: Mutex<Option<PathBuf>>,
    index: Mutex<Option<Arc<Index>>>,
    built_at: Mutex<Option<Instant>>,
    last_used: Mutex<Instant>,
    /// New/renamed items seen by the watcher since the last build.
    added: Mutex<HashSet<PathBuf>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

static STATE: LazyLock<State> = LazyLock::new(|| State {
    enabled: AtomicBool::new(true),
    building: AtomicBool::new(false),
    dirty: AtomicBool::new(false),
    file: Mutex::default(),
    index: Mutex::default(),
    built_at: Mutex::default(),
    last_used: Mutex::new(Instant::now()),
    added: Mutex::default(),
    watcher: Mutex::default(),
});

fn drive_roots() -> Vec<String> {
    crate::fs_ops::list_drives().into_iter().filter(|d| d.total > 0).map(|d| d.path).collect()
}

/// Called once at startup: where to keep the index, plus the idle timer.
pub fn init(file: PathBuf) {
    *STATE.file.lock().unwrap() = Some(file);
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(60));
        let idle = STATE.last_used.lock().unwrap().elapsed() > IDLE_DROP;
        if idle && !STATE.building.load(SeqCst) {
            STATE.index.lock().unwrap().take(); // reloads from disk on the next search
        }
    });
}

/// Turn the index on/off (the Settings switch). Off also deletes the saved copy.
pub fn set_enabled(on: bool) {
    STATE.enabled.store(on, SeqCst);
    if !on {
        STATE.index.lock().unwrap().take();
        STATE.watcher.lock().unwrap().take();
        STATE.added.lock().unwrap().clear();
        if let Some(f) = STATE.file.lock().unwrap().clone() {
            let _ = fs::remove_file(f);
        }
    }
}

/// The index if it's ready (loading it from disk if needed). Starts a build or a
/// background refresh when appropriate; returns None while there's no index yet.
pub fn ready() -> Option<Arc<Index>> {
    if !STATE.enabled.load(SeqCst) {
        return None;
    }
    *STATE.last_used.lock().unwrap() = Instant::now();
    let mut slot = STATE.index.lock().unwrap();
    if slot.is_none() {
        let file = STATE.file.lock().unwrap().clone();
        if let Some(loaded) = file.as_deref().and_then(Index::load) {
            *slot = Some(Arc::new(loaded));
            // Things may have changed while Splash was closed: refresh quietly.
            if STATE.built_at.lock().unwrap().is_none() {
                STATE.dirty.store(true, SeqCst);
            }
        }
    }
    let current = slot.clone();
    drop(slot);
    start_watching();
    let stale = STATE.dirty.load(SeqCst)
        && STATE.built_at.lock().unwrap().is_none_or(|t| t.elapsed() > REFRESH_AFTER);
    if current.is_none() || stale || STATE.added.lock().unwrap().len() > MAX_ADDED {
        rebuild_in_background();
    }
    current
}

fn rebuild_in_background() {
    if STATE.building.swap(true, SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        let index = build(&drive_roots());
        if let Some(f) = STATE.file.lock().unwrap().clone() {
            let _ = index.save(&f);
        }
        if STATE.enabled.load(SeqCst) {
            *STATE.index.lock().unwrap() = Some(Arc::new(index));
            STATE.added.lock().unwrap().clear();
            STATE.dirty.store(false, SeqCst);
            *STATE.built_at.lock().unwrap() = Some(Instant::now());
        }
        STATE.building.store(false, SeqCst);
    });
}

/// Watch every drive for new and renamed items between rebuilds.
fn start_watching() {
    let mut slot = STATE.watcher.lock().unwrap();
    if slot.is_some() {
        return;
    }
    let index_file = STATE.file.lock().unwrap().clone();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        STATE.dirty.store(true, SeqCst);
        use notify::EventKind::{Create, Modify};
        use notify::event::ModifyKind::Name;
        if matches!(event.kind, Create(_) | Modify(Name(_))) {
            let mut added = STATE.added.lock().unwrap();
            for p in event.paths {
                if Some(&p) != index_file.as_ref() && added.len() <= MAX_ADDED {
                    added.insert(p);
                }
            }
        }
    });
    if let Ok(mut w) = watcher {
        for root in drive_roots() {
            let _ = w.watch(Path::new(&root), RecursiveMode::Recursive);
        }
        *slot = Some(w);
    }
}

/// Recently added items (not yet in the index) whose names match.
pub fn find_added(words: &[String]) -> Vec<PathBuf> {
    STATE
        .added
        .lock()
        .unwrap()
        .iter()
        .filter(|p| p.file_name().is_some_and(|n| matches(&n.to_string_lossy(), words)))
        .cloned()
        .collect()
}
