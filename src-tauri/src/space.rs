//! Storage: what's taking room on a drive or in a folder, and what can go.
//!
//! A scan walks the folder on all cores and keeps a tree of every folder with
//! its total size, plus files of 1 MB or more by name (smaller ones are only
//! counted). The tree stays in memory so drilling into folders is instant.
//! Once a scan finishes, cleanup suggestions are worked out from the tree:
//! "safe" ones are caches and build output that apps recreate on their own,
//! "review" ones are worth a look but might still be wanted.

use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed, Ordering::SeqCst};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;

/// Files at least this big are kept by name; smaller ones are only counted.
const BIG_FILE: u64 = 1 << 20;
const PROGRESS_EVERY: Duration = Duration::from_millis(150);
const DAY: u64 = 86_400;

/// Bumped by every new scan and by `cancel`; a scan stops when it changes.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Finished scans by root (lowercase, no trailing separator).
static SCANS: LazyLock<Mutex<HashMap<String, Arc<Mutex<Scan>>>>> = LazyLock::new(Mutex::default);

// ---- file categories (treemap colours; same order as CATEGORIES in the UI) ----

const MEDIA: u8 = 0;
const DOCUMENTS: u8 = 1;
const CODE: u8 = 2;
const APPS: u8 = 3;
const ARCHIVES: u8 = 4;
const MODELS: u8 = 5;
const OTHER: u8 = 6;
const CATS: usize = 7;

fn category(name: &str) -> u8 {
    let Some((_, ext)) = name.rsplit_once('.') else { return OTHER };
    match ext.to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "jfif" | "gif" | "webp" | "bmp" | "svg" | "ico" | "tif" | "tiff" | "heic"
        | "heif" | "avif" | "raw" | "cr2" | "nef" | "arw" | "dng" | "psd" | "mp4" | "mkv" | "mov" | "avi"
        | "webm" | "flv" | "wmv" | "m4v" | "mts" | "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "wma" => {
            MEDIA
        }
        "pdf" | "doc" | "docx" | "txt" | "md" | "rtf" | "odt" | "xls" | "xlsx" | "csv" | "ods" | "ppt"
        | "pptx" | "odp" | "epub" | "pages" | "key" | "numbers" => DOCUMENTS,
        "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" | "py" | "pyc" | "rs" | "go" | "java" | "class" | "jar"
        | "kt" | "c" | "cc" | "cpp" | "h" | "hpp" | "cs" | "rb" | "php" | "html" | "css" | "scss" | "json"
        | "xml" | "yml" | "yaml" | "toml" | "sh" | "sql" | "map" | "lock" | "o" | "obj" | "pdb" | "rlib"
        | "rmeta" | "lib" | "a" | "d" | "pack" | "idx" | "wasm" | "dex" | "aar" | "ipch" | "pch" => CODE,
        "exe" | "dll" | "msi" | "msix" | "appx" | "sys" | "pak" | "vpk" | "cab" | "node" | "ocx" | "mui"
        | "bundle" | "asar" => APPS,
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "zst" | "iso" | "img" | "vhd"
        | "vhdx" | "vmdk" | "wim" | "esd" | "dmg" => ARCHIVES,
        "gguf" | "ggml" | "safetensors" | "onnx" | "pt" | "pth" | "ckpt" | "tflite" => MODELS,
        _ => OTHER,
    }
}

// ---- the tree ----

// What a folder holds directly (for the cleanup rules).
const HAS_CARGO_TOML: u8 = 1;
const HAS_PACKAGE_JSON: u8 = 2;
const HAS_CACHEDIR_TAG: u8 = 4; // the standard "this folder is a cache" marker (Cargo's target, …)
const HAS_CHROMIUM_CACHE: u8 = 8; // "Code Cache"/"GPUCache" beside "Cache": a browser or Electron app

#[derive(Default)]
struct Dir {
    name: Box<str>,
    /// Bytes on disk in this folder and below.
    size: u64,
    /// Files in this folder and below.
    files: u64,
    by_cat: [u64; CATS],
    /// Latest modified time (epoch seconds) in this folder and below.
    newest: u64,
    /// Latest modified time of the files directly inside.
    own_newest: u64,
    dirs: Vec<Dir>,
    big: Vec<BigFile>,
    /// Count and bytes of the smaller files directly inside.
    small_count: u64,
    small_size: u64,
    marks: u8,
    /// Couldn't be read (access denied), so its size is unknown.
    denied: bool,
}

struct BigFile {
    name: Box<str>,
    size: u64,
    modified: u64,
    cat: u8,
}

fn epoch_secs(t: std::io::Result<SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_secs() -> u64 {
    epoch_secs(Ok(SystemTime::now()))
}

/// Bytes a file actually takes on this disk. Cloud-only files (OneDrive
/// "available online") report their full size but take none.
fn on_disk(meta: &fs::Metadata) -> u64 {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
        const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x40000;
        const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x400000;
        let cloud = FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
        if meta.file_attributes() & cloud != 0 {
            return 0;
        }
    }
    meta.len()
}

/// Shared by every thread of one scan.
struct Ctx {
    generation: u64,
    files: AtomicU64,
    bytes: AtomicU64,
    denied: AtomicU64,
    current: Mutex<String>,
}

impl Ctx {
    fn cancelled(&self) -> bool {
        GENERATION.load(Relaxed) != self.generation
    }
}

fn scan_dir(path: &Path, name: Box<str>, ctx: &Ctx) -> Dir {
    let mut dir = Dir { name, ..Default::default() };
    if ctx.cancelled() {
        return dir;
    }
    let Ok(read) = fs::read_dir(path) else {
        dir.denied = true;
        ctx.denied.fetch_add(1, Relaxed);
        return dir;
    };
    if let Ok(mut current) = ctx.current.try_lock() {
        *current = path.to_string_lossy().into_owned();
    }

    let mut subdirs: Vec<(PathBuf, Box<str>)> = Vec::new();
    for entry in read.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        // Symlinks and junctions ("Application Data", …) point at folders
        // counted elsewhere, or loop.
        if kind.is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if kind.is_dir() {
            let lower = name.to_lowercase();
            // The Recycle Bin is reported on its own; System Volume Information is unreadable.
            if lower == "$recycle.bin" || lower == "system volume information" {
                continue;
            }
            if lower == "code cache" || lower == "gpucache" {
                dir.marks |= HAS_CHROMIUM_CACHE;
            }
            subdirs.push((entry.path(), name.into()));
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if name.eq_ignore_ascii_case("cargo.toml") {
            dir.marks |= HAS_CARGO_TOML;
        } else if name.eq_ignore_ascii_case("package.json") {
            dir.marks |= HAS_PACKAGE_JSON;
        } else if name.eq_ignore_ascii_case("cachedir.tag") {
            dir.marks |= HAS_CACHEDIR_TAG;
        }
        let size = on_disk(&meta);
        let modified = epoch_secs(meta.modified());
        let cat = category(&name);
        dir.own_newest = dir.own_newest.max(modified);
        dir.size += size;
        dir.files += 1;
        dir.by_cat[cat as usize] += size;
        if size >= BIG_FILE {
            dir.big.push(BigFile { name: name.into(), size, modified, cat });
        } else {
            dir.small_count += 1;
            dir.small_size += size;
        }
        ctx.files.fetch_add(1, Relaxed);
        ctx.bytes.fetch_add(size, Relaxed);
    }

    let mut children: Vec<Dir> = subdirs.into_par_iter().map(|(p, n)| scan_dir(&p, n, ctx)).collect();
    dir.newest = dir.own_newest;
    for c in &children {
        dir.size += c.size;
        dir.files += c.files;
        dir.newest = dir.newest.max(c.newest);
        for (total, part) in dir.by_cat.iter_mut().zip(c.by_cat) {
            *total += part;
        }
    }
    children.sort_unstable_by_key(|d| std::cmp::Reverse(d.size));
    dir.big.sort_unstable_by_key(|f| std::cmp::Reverse(f.size));
    dir.dirs = children;
    dir
}

// ---- cleanup suggestions ----

struct Rule {
    id: &'static str,
    label: &'static str,
    note: &'static str,
    safe: bool,
}

const TEMP: Rule = Rule {
    id: "temp",
    label: "Temporary files",
    note: "Files apps left behind in your Temp folder. Anything still in use is skipped.",
    safe: true,
};
const PACKAGE_CACHES: Rule = Rule {
    id: "packages",
    label: "Package manager caches",
    note: "Downloaded copies of npm, pip, Gradle, Cargo and NuGet packages. They download again when a project needs them.",
    safe: true,
};
const APP_CACHES: Rule = Rule {
    id: "app-caches",
    label: "Browser & app caches",
    note: "Cached web pages, images and shaders. Apps rebuild them as you use them; close the app first for the best result.",
    safe: true,
};
const BUILD_OUTPUT: Rule = Rule {
    id: "build",
    label: "Build output",
    note: "Compiled output (Rust target, Next.js, Turbo…) in projects you haven't touched for two weeks. It's rebuilt on the next build.",
    safe: true,
};
const NODE_MODULES: Rule = Rule {
    id: "node-modules",
    label: "node_modules in idle projects",
    note: "Installed packages in projects untouched for a month. Run npm install to get them back.",
    safe: false,
};
const AI_MODELS: Rule = Rule {
    id: "models",
    label: "AI models",
    note: "Downloaded models (Ollama, Hugging Face, LM Studio). You'd have to download them again to use them.",
    safe: false,
};
const ANDROID: Rule = Rule {
    id: "android",
    label: "Android SDK & emulators",
    note: "Android Studio's SDK and virtual devices. Only remove them if you no longer build Android apps.",
    safe: false,
};
const INSTALLERS: Rule = Rule {
    id: "installers",
    label: "Old installers in Downloads",
    note: "Setup files and disk images downloaded over a month ago. The apps they installed keep working.",
    safe: false,
};
const LARGE_OLD: Rule = Rule {
    id: "large-old",
    label: "Large files untouched for a year",
    note: "Files over 1 GB that haven't changed in over a year. Check before removing: some may be keepsakes.",
    safe: false,
};

/// Folders (by path ending) that are package caches.
const PACKAGE_CACHE_PATHS: &[&str] = &[
    r"\appdata\local\npm-cache",
    r"\appdata\roaming\npm-cache",
    r"\appdata\local\yarn\cache",
    r"\appdata\local\pnpm-cache",
    r"\appdata\local\pnpm\store",
    r"\appdata\local\pip\cache",
    r"\appdata\local\uv\cache",
    r"\appdata\local\nuget\v3-cache",
    r"\.gradle\caches",
    r"\.cargo\registry",
    r"\.nuget\packages",
];

/// Folders (by path ending) that are app caches.
const APP_CACHE_PATHS: &[&str] = &[
    r"\appdata\local\microsoft\windows\inetcache",
    r"\appdata\local\crashdumps",
    r"\appdata\local\d3dscache",
    r"\appdata\local\nvidia\dxcache",
    r"\appdata\local\nvidia\glcache",
    r"\appdata\local\amd\dxcache",
];

/// Folder names that are always caches inside a Chromium browser or Electron app.
const CHROMIUM_CACHE_NAMES: &[&str] = &[
    "code cache",
    "gpucache",
    "grshadercache",
    "shadercache",
    "dawncache",
    "dawngraphitecache",
    "dawnwebgpucache",
];

const MODEL_PATHS: &[&str] = &[r"\.ollama\models", r"\.cache\huggingface", r"\.lmstudio\models", r"\.cache\lm-studio"];
const ANDROID_PATHS: &[&str] = &[r"\android\sdk", r"\.android\avd"];
const BUILD_DIR_NAMES: &[&str] = &[".next", ".turbo", ".parcel-cache", ".svelte-kit", ".angular", ".nuxt"];
const INSTALLER_EXTS: &[&str] = &["exe", "msi", "msix", "appx", "iso"];
/// Never suggested as "large old files": Windows and installed apps.
const SYSTEM_PATHS: &[&str] = &[r"\windows\", r"\program files", r"\programdata\", r"\appdata\local\packages\"];

enum Verdict {
    Suggest(&'static Rule),
    /// Not worth suggesting, and nothing inside is either.
    Skip,
    Descend,
}

fn is_system(lower: &str) -> bool {
    let lower = format!("{lower}\\");
    SYSTEM_PATHS.iter().any(|s| lower.contains(s))
}

/// Newest change in `parent` outside `except` (is the project still being worked on?).
fn newest_besides(parent: &Dir, except: &Dir) -> u64 {
    parent
        .dirs
        .iter()
        .filter(|d| !std::ptr::eq(*d, except))
        .map(|d| d.newest)
        .fold(parent.own_newest, u64::max)
}

fn judge_dir(dir: &Dir, lower: &str, parent: Option<&Dir>, now: u64) -> Verdict {
    let ends = |list: &[&str]| list.iter().any(|s| lower.ends_with(s));
    let name = lower.rsplit(['\\', '/']).next().unwrap_or(lower);
    let parent_marks = parent.map_or(0, |p| p.marks);
    let idle_for = |days: u64| parent.is_some_and(|p| newest_besides(p, dir) + days * DAY < now);

    if lower.ends_with(r"\appdata\local\temp") {
        return Verdict::Suggest(&TEMP);
    }
    if ends(PACKAGE_CACHE_PATHS) {
        return Verdict::Suggest(&PACKAGE_CACHES);
    }
    if ends(APP_CACHE_PATHS)
        || (lower.contains(r"\appdata\")
            && (CHROMIUM_CACHE_NAMES.contains(&name) || (name == "cache" && parent_marks & HAS_CHROMIUM_CACHE != 0)))
    {
        return Verdict::Suggest(&APP_CACHES);
    }
    if ends(MODEL_PATHS) {
        return Verdict::Suggest(&AI_MODELS);
    }
    if ends(ANDROID_PATHS) {
        return Verdict::Suggest(&ANDROID);
    }
    // Apps ship their own node_modules and builds; only your projects count.
    if lower.contains(r"\appdata\") || is_system(lower) {
        return Verdict::Descend;
    }
    // Packages inside packages (or a Node.js install) aren't projects of their own.
    if lower.contains(r"\node_modules\") {
        return Verdict::Skip;
    }
    let build = (name == "target" && parent_marks & HAS_CARGO_TOML != 0 && dir.marks & HAS_CACHEDIR_TAG != 0)
        || (BUILD_DIR_NAMES.contains(&name) && parent_marks & HAS_PACKAGE_JSON != 0);
    if build {
        return if idle_for(14) { Verdict::Suggest(&BUILD_OUTPUT) } else { Verdict::Skip };
    }
    if name == "node_modules" && parent_marks & HAS_PACKAGE_JSON != 0 {
        return if idle_for(30) { Verdict::Suggest(&NODE_MODULES) } else { Verdict::Skip };
    }
    Verdict::Descend
}

fn judge_file(file: &BigFile, dir_lower: &str, downloads: &str, now: u64) -> Option<&'static Rule> {
    let ext = file.name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    if !downloads.is_empty()
        && (dir_lower == downloads || dir_lower.starts_with(&format!("{downloads}\\")))
        && INSTALLER_EXTS.contains(&ext.as_str())
        && file.modified + 30 * DAY < now
    {
        return Some(&INSTALLERS);
    }
    if file.size >= 1 << 30 && file.modified > 0 && file.modified + 365 * DAY < now && !is_system(dir_lower) {
        return Some(&LARGE_OLD);
    }
    None
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    id: &'static str,
    label: &'static str,
    note: &'static str,
    safe: bool,
    size: u64,
    items: Vec<SuggestedItem>,
}

#[derive(Serialize, Clone)]
pub struct SuggestedItem {
    path: String,
    size: u64,
}

fn collect(
    dir: &Dir,
    path: &Path,
    parent: Option<&Dir>,
    downloads: &str,
    now: u64,
    out: &mut Vec<(&'static Rule, String, u64)>,
) {
    let lower = path.to_string_lossy().to_lowercase();
    let lower = lower.trim_end_matches(['\\', '/']);
    match judge_dir(dir, lower, parent, now) {
        Verdict::Suggest(rule) => {
            if dir.size >= BIG_FILE {
                out.push((rule, path.to_string_lossy().into_owned(), dir.size));
            }
            return;
        }
        Verdict::Skip => return,
        Verdict::Descend => {}
    }
    for f in &dir.big {
        if let Some(rule) = judge_file(f, lower, downloads, now) {
            out.push((rule, path.join(&*f.name).to_string_lossy().into_owned(), f.size));
        }
    }
    for d in &dir.dirs {
        collect(d, &path.join(&*d.name), Some(dir), downloads, now, out);
    }
}

/// Suggestions (safe ones first, biggest first) and the flag of each suggested path.
fn suggestions(scan_root: &Path, tree: &Dir) -> (Vec<Suggestion>, HashMap<String, bool>) {
    let downloads = dirs::download_dir()
        .map(|d| d.to_string_lossy().to_lowercase().trim_end_matches('\\').to_string())
        .unwrap_or_default();
    let mut found = Vec::new();
    collect(tree, scan_root, None, &downloads, now_secs(), &mut found);

    let mut flags = HashMap::new();
    let mut by_rule: Vec<Suggestion> = Vec::new();
    for (rule, path, size) in found {
        flags.insert(path.to_lowercase(), rule.safe);
        let item = SuggestedItem { path, size };
        match by_rule.iter_mut().find(|s| s.id == rule.id) {
            Some(s) => {
                s.size += size;
                s.items.push(item);
            }
            None => by_rule.push(Suggestion {
                id: rule.id,
                label: rule.label,
                note: rule.note,
                safe: rule.safe,
                size,
                items: vec![item],
            }),
        }
    }
    for s in &mut by_rule {
        s.items.sort_unstable_by_key(|i| std::cmp::Reverse(i.size));
    }
    by_rule.sort_by(|a, b| b.safe.cmp(&a.safe).then(b.size.cmp(&a.size)));
    (by_rule, flags)
}

// ---- scans ----

struct Scan {
    root: PathBuf,
    tree: Dir,
    info: ScanInfo,
    suggestions: Vec<Suggestion>,
    /// Lowercase path → safe (true) or review (false).
    flags: HashMap<String, bool>,
}

impl Scan {
    fn refresh_suggestions(&mut self) {
        (self.suggestions, self.flags) = suggestions(&self.root, &self.tree);
        self.info.size = self.tree.size;
        self.info.files = self.tree.files;
        self.info.safe = self.suggestions.iter().filter(|s| s.safe).map(|s| s.size).sum();
        self.info.review = self.suggestions.iter().filter(|s| !s.safe).map(|s| s.size).sum();
    }
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScanInfo {
    root: String,
    /// Bytes found under the root.
    size: u64,
    files: u64,
    /// Folders that couldn't be read.
    denied: u64,
    ms: u64,
    /// When the scan finished (epoch seconds).
    at: u64,
    /// Totals of the safe and review suggestions.
    safe: u64,
    review: u64,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ScanEvent {
    Progress { files: u64, bytes: u64, dir: String },
    Done { info: Option<ScanInfo>, cancelled: bool },
}

fn key(root: &str) -> String {
    let k = root.trim_end_matches(['\\', '/']).to_lowercase();
    if k.is_empty() { root.to_string() } else { k }
}

fn get(root: &str) -> Result<Arc<Mutex<Scan>>, String> {
    SCANS
        .lock()
        .unwrap()
        .get(&key(root))
        .cloned()
        .ok_or_else(|| "This location hasn't been scanned yet".to_string())
}

pub fn cancel() {
    GENERATION.fetch_add(1, SeqCst);
}

/// Scan `root`, streaming progress to `events`. A new scan stops the previous one.
pub fn scan(root: String, events: Channel<ScanEvent>) {
    let generation = GENERATION.fetch_add(1, SeqCst) + 1;
    let started = Instant::now();
    let ctx = Arc::new(Ctx {
        generation,
        files: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
        denied: AtomicU64::new(0),
        current: Mutex::new(root.clone()),
    });

    let finished = Arc::new(AtomicBool::new(false));
    let ticker = {
        let (ctx, finished, events) = (ctx.clone(), finished.clone(), events.clone());
        std::thread::spawn(move || {
            while !finished.load(SeqCst) {
                std::thread::sleep(PROGRESS_EVERY);
                let dir = ctx.current.lock().unwrap().clone();
                let _ = events.send(ScanEvent::Progress {
                    files: ctx.files.load(Relaxed),
                    bytes: ctx.bytes.load(Relaxed),
                    dir,
                });
            }
        })
    };

    let root_path = PathBuf::from(&root);
    let tree = scan_dir(&root_path, root.clone().into(), &ctx);
    finished.store(true, SeqCst);
    let _ = ticker.join();

    if ctx.cancelled() {
        let _ = events.send(ScanEvent::Done { info: None, cancelled: true });
        return;
    }
    let mut scan = Scan {
        root: root_path,
        tree,
        info: ScanInfo {
            root: root.clone(),
            denied: ctx.denied.load(Relaxed),
            ms: started.elapsed().as_millis() as u64,
            at: now_secs(),
            ..Default::default()
        },
        suggestions: Vec::new(),
        flags: HashMap::new(),
    };
    scan.refresh_suggestions();
    let info = scan.info.clone();
    SCANS.lock().unwrap().insert(key(&root), Arc::new(Mutex::new(scan)));
    let _ = events.send(ScanEvent::Done { info: Some(info), cancelled: false });
}

/// The last finished scan of `root`, if any.
pub fn info(root: &str) -> Option<ScanInfo> {
    let scan = get(root).ok()?;
    let info = scan.lock().unwrap().info.clone();
    Some(info)
}

pub fn suggestions_for(root: &str) -> Result<Vec<Suggestion>, String> {
    let scan = get(root)?;
    let list = scan.lock().unwrap().suggestions.clone();
    Ok(list)
}

// ---- views ----

/// One box in the treemap.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    name: String,
    /// Empty for groups ("12 small files", "30 more items").
    path: String,
    size: u64,
    files: u64,
    is_dir: bool,
    /// Category taking the most room.
    cat: u8,
    modified: u64,
    /// Suggested for cleanup: "safe" or "review".
    flag: Option<&'static str>,
    denied: bool,
    children: Vec<Node>,
}

#[derive(Serialize)]
pub struct View {
    info: ScanInfo,
    node: Node,
}

fn main_cat(by_cat: &[u64; CATS]) -> u8 {
    (0..CATS).max_by_key(|&i| by_cat[i]).filter(|&i| by_cat[i] > 0).unwrap_or(OTHER as usize) as u8
}

fn flag_of(flags: &HashMap<String, bool>, path: &str) -> Option<&'static str> {
    flags.get(&path.to_lowercase()).map(|&safe| if safe { "safe" } else { "review" })
}

fn group(name: String, size: u64, files: u64) -> Node {
    Node {
        name,
        path: String::new(),
        size,
        files,
        is_dir: false,
        cat: OTHER,
        modified: 0,
        flag: None,
        denied: false,
        children: Vec::new(),
    }
}

/// `dir` with `depth` levels of children, each level keeping the biggest `limits[level]`.
fn node(dir: &Dir, path: &Path, flags: &HashMap<String, bool>, limits: &[usize]) -> Node {
    let path_str = path.to_string_lossy().into_owned();
    let mut children = Vec::new();
    if let Some((&limit, rest)) = limits.split_first() {
        // The biggest folders and files (both lists are sorted biggest first);
        // only those get built, the rest are summed into one box.
        enum Item<'a> {
            Dir(&'a Dir),
            File(&'a BigFile),
        }
        let mut all: Vec<(u64, Item)> = dir
            .dirs
            .iter()
            .map(|d| (d.size, Item::Dir(d)))
            .chain(dir.big.iter().map(|f| (f.size, Item::File(f))))
            .filter(|(size, _)| *size > 0)
            .collect();
        all.sort_by_key(|(size, _)| std::cmp::Reverse(*size));
        let more = all.split_off(all.len().min(limit));

        let mut items: Vec<Node> = all
            .into_iter()
            .map(|(_, item)| match item {
                Item::Dir(d) => node(d, &path.join(&*d.name), flags, rest),
                Item::File(f) => {
                    let p = path.join(&*f.name).to_string_lossy().into_owned();
                    Node {
                        name: f.name.to_string(),
                        flag: flag_of(flags, &p),
                        path: p,
                        size: f.size,
                        files: 1,
                        is_dir: false,
                        cat: f.cat,
                        modified: f.modified,
                        denied: false,
                        children: Vec::new(),
                    }
                }
            })
            .collect();
        if !more.is_empty() {
            let size = more.iter().map(|(s, _)| s).sum();
            let files = more
                .iter()
                .map(|(_, item)| match item {
                    Item::Dir(d) => d.files,
                    Item::File(_) => 1,
                })
                .sum();
            items.push(group(format!("{} more items", more.len()), size, files));
        }
        if dir.small_size > 0 {
            let n = dir.small_count;
            items.push(group(
                format!("{n} small file{}", if n == 1 { "" } else { "s" }),
                dir.small_size,
                n,
            ));
            items.sort_by_key(|n| std::cmp::Reverse(n.size));
        }
        children = items;
    }
    Node {
        name: dir.name.to_string(),
        flag: flag_of(flags, &path_str),
        path: path_str,
        size: dir.size,
        files: dir.files,
        is_dir: true,
        cat: main_cat(&dir.by_cat),
        modified: dir.newest,
        denied: dir.denied,
        children,
    }
}

/// Folders from the scan root down to `path` (case-insensitive), or None if `path` isn't in the tree.
fn chain<'a>(tree: &'a Dir, root: &Path, path: &str) -> Option<Vec<&'a Dir>> {
    let rel = relative(root, path)?;
    let mut out = vec![tree];
    for part in rel {
        let next = out.last()?.dirs.iter().find(|d| d.name.eq_ignore_ascii_case(&part))?;
        out.push(next);
    }
    Some(out)
}

/// Components of `path` below `root`, or None if it isn't under it.
fn relative(root: &Path, path: &str) -> Option<Vec<String>> {
    let root_s = root.to_string_lossy().to_lowercase();
    let root_s = root_s.trim_end_matches(['\\', '/']);
    let lower = path.to_lowercase();
    let rest = lower.strip_prefix(root_s)?;
    if !rest.is_empty() && !rest.starts_with(['\\', '/']) {
        return None;
    }
    // Same length as the lowercase form, so slice the original to keep its case.
    let original = &path[path.len() - rest.len()..];
    Some(original.split(['\\', '/']).filter(|s| !s.is_empty()).map(String::from).collect())
}

/// `path` (inside the scan of `root`) with three levels of children for the treemap.
pub fn view(root: &str, path: &str) -> Result<View, String> {
    let scan = get(root)?;
    let scan = scan.lock().unwrap();
    let dirs = chain(&scan.tree, &scan.root, path).ok_or("That folder isn't in this scan any more")?;
    let dir = dirs.last().unwrap();
    let full = if dirs.len() == 1 { scan.root.clone() } else { PathBuf::from(path) };
    Ok(View { info: scan.info.clone(), node: node(dir, &full, &scan.flags, &[60, 24, 12]) })
}

/// Sizes held by an item, for keeping the folders above it right.
#[derive(Clone, Copy, Default)]
struct Totals {
    size: u64,
    files: u64,
    by_cat: [u64; CATS],
}

impl Dir {
    fn totals(&self) -> Totals {
        Totals { size: self.size, files: self.files, by_cat: self.by_cat }
    }

    fn apply(&mut self, minus: Totals, plus: Totals) {
        self.size = (self.size + plus.size).saturating_sub(minus.size);
        self.files = (self.files + plus.files).saturating_sub(minus.files);
        for i in 0..CATS {
            self.by_cat[i] = (self.by_cat[i] + plus.by_cat[i]).saturating_sub(minus.by_cat[i]);
        }
    }
}

fn file_totals(f: &BigFile) -> Totals {
    let mut by_cat = [0; CATS];
    by_cat[f.cat as usize] = f.size;
    Totals { size: f.size, files: 1, by_cat }
}

/// Measure `paths` again after they changed (cleaned up, deleted), so totals
/// and suggestions stay right without scanning everything again.
pub fn refresh(root: &str, paths: Vec<String>) -> Result<ScanInfo, String> {
    let scan = get(root)?;
    let mut scan = scan.lock().unwrap();
    let root_path = scan.root.clone();
    let ctx = Ctx {
        generation: GENERATION.load(SeqCst),
        files: AtomicU64::new(0),
        bytes: AtomicU64::new(0),
        denied: AtomicU64::new(0),
        current: Mutex::new(String::new()),
    };
    for path in paths {
        let Some(mut parts) = relative(&root_path, &path) else { continue };
        let Some(name) = parts.pop() else { continue };
        let fresh = Path::new(&path).is_dir().then(|| scan_dir(Path::new(&path), name.as_str().into(), &ctx));
        let Some(parent) = walk_mut(&mut scan.tree, &parts) else { continue };

        // Swap the old entry for what's there now.
        let mut old = Totals::default();
        if let Some(i) = parent.dirs.iter().position(|d| d.name.eq_ignore_ascii_case(&name)) {
            old = parent.dirs.remove(i).totals();
        } else if let Some(i) = parent.big.iter().position(|f| f.name.eq_ignore_ascii_case(&name)) {
            old = file_totals(&parent.big.remove(i));
        }
        let mut new = Totals::default();
        if let Some(dir) = fresh {
            new = dir.totals();
            let at = parent.dirs.partition_point(|d| d.size >= dir.size);
            parent.dirs.insert(at, dir);
        } else if let Ok(meta) = fs::symlink_metadata(&path) {
            let f = BigFile {
                name: name.as_str().into(),
                size: on_disk(&meta),
                modified: epoch_secs(meta.modified()),
                cat: category(&name),
            };
            new = file_totals(&f);
            let at = parent.big.partition_point(|b| b.size >= f.size);
            parent.big.insert(at, f);
        }

        // Every folder on the way down held it.
        let mut dir = &mut scan.tree;
        dir.apply(old, new);
        for part in &parts {
            let Some(next) = dir.dirs.iter_mut().find(|d| d.name.eq_ignore_ascii_case(part)) else { break };
            dir = next;
            dir.apply(old, new);
        }
    }
    scan.refresh_suggestions();
    Ok(scan.info.clone())
}

fn walk_mut<'a>(tree: &'a mut Dir, parts: &[String]) -> Option<&'a mut Dir> {
    let mut dir = tree;
    for part in parts {
        dir = dir.dirs.iter_mut().find(|d| d.name.eq_ignore_ascii_case(part))?;
    }
    Some(dir)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CleanProgress {
    /// Suggested items finished so far, out of `total`.
    done: usize,
    total: usize,
    /// The item being cleaned now.
    path: String,
}

/// How far into a folder that's partly in use to look for what can still go.
const CLEAN_DEPTH: u32 = 3;

/// Move `targets` to the Recycle Bin, as many as possible: all at once if
/// nothing is in use, otherwise in halves, then inside folders that are in
/// use (a running browser locks a few files in its cache, not all of them).
/// Returns how many items had to stay.
fn trash_all(targets: &[PathBuf], depth: u32) -> u64 {
    let targets: Vec<&PathBuf> = targets.iter().filter(|t| t.exists()).collect();
    if targets.is_empty() || trash::delete_all(&targets).is_ok() {
        return 0;
    }
    if targets.len() > 1 {
        let (a, b) = targets.split_at(targets.len() / 2);
        let owned = |s: &[&PathBuf]| s.iter().map(|p| p.to_path_buf()).collect::<Vec<_>>();
        return trash_all(&owned(a), depth) + trash_all(&owned(b), depth);
    }
    let t = targets[0];
    if t.is_dir() && depth > 0 {
        let inside: Vec<PathBuf> = fs::read_dir(t).map(|r| r.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        if !inside.is_empty() {
            return trash_all(&inside, depth - 1);
        }
    }
    u64::from(t.exists())
}

/// Delete a file for good; read-only ones (common in package caches) too.
/// Returns 1 if it had to stay (in use).
fn remove_file(p: &Path) -> u64 {
    if fs::remove_file(p).is_ok() {
        return 0;
    }
    if let Ok(meta) = fs::symlink_metadata(p) {
        let mut perms = meta.permissions();
        if perms.readonly() {
            #[allow(clippy::permissions_set_readonly_false)] // Windows: just clears the read-only flag
            perms.set_readonly(false);
            if fs::set_permissions(p, perms).is_ok() && fs::remove_file(p).is_ok() {
                return 0;
            }
        }
    }
    u64::from(fs::symlink_metadata(p).is_ok())
}

/// Delete everything inside `dir` for good, on all cores, keeping `dir`
/// itself. Files in use are skipped (so are the folders holding them).
/// Links are removed, never followed. Returns how many files had to stay.
fn delete_inside(dir: &Path) -> u64 {
    let Ok(read) = fs::read_dir(dir) else { return 0 };
    let entries: Vec<fs::DirEntry> = read.flatten().collect();
    entries
        .par_iter()
        .map(|e| {
            let p = e.path();
            match e.file_type() {
                // A junction or symlink: remove the link, not what it points to.
                Ok(t) if t.is_symlink() => {
                    if fs::remove_dir(&p).is_ok() {
                        0
                    } else {
                        remove_file(&p)
                    }
                }
                Ok(t) if t.is_dir() => {
                    let left = delete_inside(&p);
                    if left == 0 && fs::remove_dir(&p).is_err() {
                        // Read-only folder: clear the flag and retry.
                        let _ = fs::metadata(&p).map(|m| {
                            let mut perms = m.permissions();
                            #[allow(clippy::permissions_set_readonly_false)]
                            perms.set_readonly(false);
                            let _ = fs::set_permissions(&p, perms);
                        });
                        let _ = fs::remove_dir(&p);
                    }
                    left
                }
                _ => remove_file(&p),
            }
        })
        .sum()
}

/// Paths that are in a "safe to remove" suggestion of some scan. Only these
/// are ever deleted for good; anything else asked for goes to the Recycle Bin.
fn safe_paths() -> std::collections::HashSet<String> {
    SCANS
        .lock()
        .unwrap()
        .values()
        .flat_map(|scan| {
            let scan = scan.lock().unwrap();
            scan.suggestions
                .iter()
                .filter(|s| s.safe)
                .flat_map(|s| s.items.iter().map(|i| i.path.to_lowercase()))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Clean up suggested items, reporting progress to `events`.
///
/// `delete` items (caches and temp files that apps rebuild) are deleted for
/// good, the way Windows' Disk Cleanup does: that's quick and frees the space
/// right away. `trash` items go to the Recycle Bin, so they can be restored.
/// A folder is emptied rather than removed (apps expect their Temp and Cache
/// folders to exist), and whatever is in use is left behind. Returns how many
/// items had to stay.
pub fn clean(delete: Vec<String>, trash: Vec<String>, events: Channel<CleanProgress>) -> u64 {
    let allowed = safe_paths();
    let (delete, unsafe_delete): (Vec<String>, Vec<String>) =
        delete.into_iter().partition(|p| allowed.contains(&p.to_lowercase()));
    let jobs: Vec<(String, bool)> = delete
        .into_iter()
        .map(|p| (p, true))
        .chain(trash.into_iter().chain(unsafe_delete).map(|p| (p, false)))
        .collect();

    let total = jobs.len();
    let mut failed = 0;
    for (done, (path, for_good)) in jobs.into_iter().enumerate() {
        let _ = events.send(CleanProgress { done, total, path: path.clone() });
        let p = Path::new(&path);
        if for_good {
            failed += if p.is_dir() { delete_inside(p) } else { remove_file(p) };
            continue;
        }
        let targets: Vec<PathBuf> = if p.is_dir() {
            fs::read_dir(p).map(|r| r.flatten().map(|e| e.path()).collect()).unwrap_or_default()
        } else {
            vec![p.to_path_buf()]
        };
        failed += trash_all(&targets, CLEAN_DEPTH);
    }
    let _ = events.send(CleanProgress { done: total, total, path: String::new() });
    failed
}

// ---- Recycle Bin ----

/// Bytes in the Recycle Bin across every drive.
pub fn recycle_bin_size() -> u64 {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};
        let mut info = SHQUERYRBINFO { cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32, ..Default::default() };
        if SHQueryRecycleBinW(windows::core::PCWSTR::null(), &mut info).is_ok() {
            return info.i64Size.max(0) as u64;
        }
    }
    0
}

/// Permanently delete everything in the Recycle Bin (the UI asks first).
pub fn empty_recycle_bin() -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::UI::Shell::{SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOSOUND};
        // Fails harmlessly (E_UNEXPECTED) when it's already empty.
        if recycle_bin_size() == 0 {
            return Ok(());
        }
        SHEmptyRecycleBinW(None, windows::core::PCWSTR::null(), SHERB_NOCONFIRMATION | SHERB_NOSOUND)
            .map_err(|e| format!("Couldn't empty the Recycle Bin: {}", e.message()))
    }
    #[cfg(not(windows))]
    Err("Only available on Windows".into())
}


#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system temp dir, removed when dropped.
    struct TempTree(PathBuf);
    impl TempTree {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("splash-space-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            TempTree(dir)
        }
        fn file(&self, rel: &str, bytes: usize) {
            let p = self.0.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, vec![0u8; bytes]).unwrap();
        }
        fn root(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }
    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Scan `root` and keep it, like `scan` does (without the progress channel).
    fn scan_now(root: &str) -> ScanInfo {
        let ctx = Ctx {
            generation: GENERATION.load(SeqCst),
            files: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            denied: AtomicU64::new(0),
            current: Mutex::new(String::new()),
        };
        let tree = scan_dir(Path::new(root), root.into(), &ctx);
        let mut scan = Scan {
            root: PathBuf::from(root),
            tree,
            info: ScanInfo { root: root.into(), ..Default::default() },
            suggestions: Vec::new(),
            flags: HashMap::new(),
        };
        scan.refresh_suggestions();
        let info = scan.info.clone();
        SCANS.lock().unwrap().insert(key(root), Arc::new(Mutex::new(scan)));
        info
    }

    #[test]
    fn sizes_and_refresh() {
        let t = TempTree::new("refresh");
        t.file(r"a\big.bin", 3 << 20);
        t.file(r"a\b\small.txt", 1000);
        t.file("top.txt", 500);
        let root = t.root();

        let info = scan_now(&root);
        assert_eq!(info.size, (3 << 20) + 1500);
        assert_eq!(info.files, 3);

        // The view lists the folder and the small file group, biggest first.
        let v = view(&root, &root).unwrap();
        assert_eq!(v.node.children[0].name, "a");
        assert_eq!(v.node.children[0].children[0].name, "big.bin");

        // Delete a folder, then a big file: totals follow without a rescan.
        fs::remove_dir_all(t.0.join(r"a\b")).unwrap();
        let info = refresh(&root, vec![t.0.join(r"a\b").to_string_lossy().into()]).unwrap();
        assert_eq!(info.size, (3 << 20) + 500);
        fs::remove_file(t.0.join(r"a\big.bin")).unwrap();
        let info = refresh(&root, vec![t.0.join(r"a\big.bin").to_string_lossy().into()]).unwrap();
        assert_eq!(info.size, 500);
        assert_eq!(info.files, 1);

        // A folder that grew is measured again.
        t.file(r"a\new.bin", 2 << 20);
        let info = refresh(&root, vec![t.0.join("a").to_string_lossy().into()]).unwrap();
        assert_eq!(info.size, (2 << 20) + 500);
    }

    #[test]
    fn suggestions_follow_the_rules() {
        let t = TempTree::new("rules");
        t.file(r"AppData\Local\Temp\leftover.tmp", 2 << 20);
        t.file(r"AppData\Roaming\SomeApp\Cache\data_1", 2 << 20);
        t.file(r"AppData\Roaming\SomeApp\GPUCache\data_0", 2 << 20);
        t.file(r"AppData\Local\npm-cache\_cacache\blob", 2 << 20);
        // An app's bundled packages aren't a project of yours.
        t.file(r"AppData\Local\Chat\app\package.json", 10);
        t.file(r"AppData\Local\Chat\app\node_modules\x\index.js", 2 << 20);
        // Nor is a Cache folder outside a browser or Electron app.
        t.file(r"Documents\Cache\notes.bin", 2 << 20);
        let root = t.root();
        scan_now(&root);

        let found = suggestions_for(&root).unwrap();
        let ids: Vec<&str> = found.iter().map(|s| s.id).collect();
        let paths: Vec<String> = found.iter().flat_map(|s| s.items.iter().map(|i| i.path.clone())).collect();
        assert!(ids.contains(&"temp"), "{ids:?}");
        assert!(ids.contains(&"packages"), "{ids:?}");
        assert!(ids.contains(&"app-caches"), "{ids:?}");
        assert!(!ids.contains(&"node-modules"), "{ids:?}");
        assert!(paths.iter().any(|p| p.ends_with(r"SomeApp\Cache")), "{paths:?}");
        assert!(paths.iter().any(|p| p.ends_with(r"SomeApp\GPUCache")), "{paths:?}");
        assert!(!paths.iter().any(|p| p.contains("Documents")), "{paths:?}");
        assert!(found.iter().all(|s| s.safe));
    }

    /// Uses the real Recycle Bin, so it only runs when asked: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn clean_empties_folders_but_keeps_them() {
        let t = TempTree::new("clean");
        t.file(r"cache\one.bin", 2 << 20);
        t.file(r"cache\deep\two.bin", 1 << 20);
        t.file("installer.exe", 1000);
        let events = Channel::new(|_| Ok(()));
        let failed = clean(
            Vec::new(),
            vec![t.0.join("cache").to_string_lossy().into(), t.0.join("installer.exe").to_string_lossy().into()],
            events,
        );
        assert_eq!(failed, 0);
        assert!(t.0.join("cache").is_dir(), "the folder itself stays");
        assert_eq!(fs::read_dir(t.0.join("cache")).unwrap().count(), 0, "but it's empty");
        assert!(!t.0.join("installer.exe").exists());
    }

    /// Uses the real Recycle Bin, so it only runs when asked: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn clean_skips_only_what_is_in_use() {
        use std::os::windows::fs::OpenOptionsExt;
        let t = TempTree::new("in-use");
        for i in 0..20 {
            t.file(&format!(r"cache\entry{i}.bin"), 1000);
        }
        t.file(r"cache\Cache_Data\locked.bin", 1000);
        t.file(r"cache\Cache_Data\free.bin", 1000);
        // Like a running browser: one file open with no sharing.
        let lock = fs::OpenOptions::new().read(true).share_mode(0).open(t.0.join(r"cache\Cache_Data\locked.bin")).unwrap();
        let failed = clean(Vec::new(), vec![t.0.join("cache").to_string_lossy().into()], Channel::new(|_| Ok(())));
        drop(lock);
        assert_eq!(failed, 1, "only the locked file stays");
        assert!(t.0.join(r"cache\Cache_Data\locked.bin").exists());
        assert!(!t.0.join(r"cache\Cache_Data\free.bin").exists(), "its neighbour still goes");
        assert!(!t.0.join(r"cache\entry0.bin").exists() && !t.0.join(r"cache\entry19.bin").exists());
    }

    #[test]
    #[cfg(windows)]
    fn delete_for_good_only_what_a_scan_called_safe() {
        use std::os::windows::fs::OpenOptionsExt;
        let t = TempTree::new("delete");
        let cache = t.0.join(r"AppData\Roaming\App\Code Cache");
        for i in 0..50 {
            t.file(&format!(r"AppData\Roaming\App\Code Cache\js\entry{i}"), 1000);
        }
        t.file(r"AppData\Roaming\App\Code Cache\wasm\locked", 2 << 20);
        t.file(r"AppData\Roaming\App\Code Cache\readonly", 1000);
        let ro = cache.join("readonly");
        let mut perms = fs::metadata(&ro).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&ro, perms).unwrap();
        // Not suggested by any scan: must not be deleted for good.
        t.file(r"Documents\keep.txt", 1000);
        scan_now(&t.root());

        let lock = fs::OpenOptions::new().read(true).share_mode(0).open(cache.join(r"wasm\locked")).unwrap();
        let failed = clean(
            vec![cache.to_string_lossy().into()],
            Vec::new(),
            Channel::new(|_| Ok(())),
        );
        drop(lock);

        assert!(cache.is_dir(), "the cache folder itself stays");
        assert!(cache.join(r"wasm\locked").exists(), "files in use stay");
        assert!(!cache.join("js").exists() && !ro.exists(), "everything else goes, read-only too");
        assert_eq!(failed, 1);
        // Anything a scan didn't call safe is never deleted for good: clean()
        // sends it to the Recycle Bin instead.
        assert!(safe_paths().contains(&cache.to_string_lossy().to_lowercase()));
        assert!(!safe_paths().contains(&t.0.join("Documents").to_string_lossy().to_lowercase()));
    }
}
