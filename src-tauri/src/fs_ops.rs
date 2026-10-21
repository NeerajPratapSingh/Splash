use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Clone)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Modified time in seconds since the UNIX epoch (0 if unknown).
    pub modified: u64,
    /// Creation time in seconds since the UNIX epoch (0 if unknown).
    pub created: u64,
    pub extension: String,
    /// Hidden or system item (hidden by default, like Explorer).
    pub hidden: bool,
}

fn epoch_secs(t: std::io::Result<std::time::SystemTime>) -> u64 {
    t.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(windows)]
fn is_hidden(meta: &fs::Metadata, _name: &str) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
    meta.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0
}

#[cfg(not(windows))]
fn is_hidden(_meta: &fs::Metadata, name: &str) -> bool {
    name.starts_with('.')
}

#[derive(Serialize, Clone)]
pub struct DriveInfo {
    pub name: String,
    pub path: String,
    /// Capacity and free space in bytes (0 if unknown, e.g. an empty card reader).
    pub total: u64,
    pub free: u64,
}

#[derive(Serialize, Clone)]
pub struct QuickLink {
    pub name: String,
    pub path: String,
    pub kind: String,
}

pub(crate) fn entry_from(path: &Path, meta: &fs::Metadata) -> Option<Entry> {
    let is_dir = meta.is_dir();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        // Drive roots like C:\ have no file_name — fall back to the path.
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    let extension = if is_dir {
        String::new()
    } else {
        path.extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    };
    Some(Entry {
        hidden: is_hidden(meta, &name),
        name,
        path: path.to_string_lossy().to_string(),
        is_dir,
        size: if is_dir { 0 } else { meta.len() },
        modified: epoch_secs(meta.modified()),
        created: epoch_secs(meta.created()),
        extension,
    })
}

pub fn list_dir(path: &str) -> Result<Vec<Entry>, String> {
    let rd = fs::read_dir(path).map_err(|e| format!("Can't open this folder: {}", friendly(&e)))?;
    let mut out = Vec::new();
    for item in rd {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue, // skip entries we can't read (permissions, etc.)
        };
        // On Windows the listing already carries each item's size, dates and
        // attributes, so this doesn't touch the file itself (much faster than
        // a metadata call per path, especially on big folders).
        if let Some(e) = item.metadata().ok().and_then(|m| entry_from(&item.path(), &m)) {
            out.push(e);
        }
    }
    Ok(out)
}

pub fn list_drives() -> Vec<DriveInfo> {
    let mut drives = Vec::new();
    #[cfg(windows)]
    {
        for c in b'A'..=b'Z' {
            let root = format!("{}:\\", c as char);
            if Path::new(&root).exists() {
                let (total, free) = disk_space(&root);
                drives.push(DriveInfo {
                    name: format!("{}:", c as char),
                    path: root,
                    total,
                    free,
                });
            }
        }
    }
    #[cfg(not(windows))]
    {
        // On non-Windows, expose the filesystem root so the UI still works.
        drives.push(DriveInfo {
            name: "/".to_string(),
            path: "/".to_string(),
            total: 0,
            free: 0,
        });
    }
    drives
}

/// (total, free) bytes for a drive root; free is what this user can use.
#[cfg(windows)]
fn disk_space(root: &str) -> (u64, u64) {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let (mut free, mut total) = (0u64, 0u64);
    let ok = unsafe {
        GetDiskFreeSpaceExW(&HSTRING::from(root), Some(&mut free), Some(&mut total), None)
    };
    if ok.is_ok() {
        (total, free)
    } else {
        (0, 0)
    }
}

pub fn quick_links() -> Vec<QuickLink> {
    let mut links = Vec::new();
    let mut push = |name: &str, p: Option<PathBuf>, kind: &str| {
        if let Some(p) = p {
            let path = p.to_string_lossy().to_string();
            if p.exists() && !links.iter().any(|l: &QuickLink| l.path == path) {
                links.push(QuickLink {
                    name: name.to_string(),
                    path,
                    kind: kind.to_string(),
                });
            }
        }
    };
    push("Home", dirs::home_dir(), "home");
    // OneDrive folders (personal and work/school), named like Explorer does:
    // "OneDrive" / "OneDrive - Contoso".
    for var in ["OneDriveConsumer", "OneDriveCommercial", "OneDrive"] {
        if let Some(p) = std::env::var_os(var).map(PathBuf::from) {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "OneDrive".into());
            push(&name, Some(p), "cloud");
        }
    }
    push("Desktop", dirs::desktop_dir(), "desktop");
    push("Documents", dirs::document_dir(), "documents");
    push("Downloads", dirs::download_dir(), "downloads");
    push("Pictures", dirs::picture_dir(), "pictures");
    push("Music", dirs::audio_dir(), "music");
    push("Videos", dirs::video_dir(), "videos");
    links
}

pub fn home_dir() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string())
}

pub fn parent_dir(path: &str) -> Option<String> {
    Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .filter(|p| !p.is_empty())
}

/// A plain-language reason for a filesystem error (no "(os error 5)").
pub(crate) fn friendly(e: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    match e.kind() {
        PermissionDenied => "Access denied — Windows doesn't allow this here".into(),
        NotFound => "It doesn't exist (it may have been moved or deleted)".into(),
        AlreadyExists => "Something with that name already exists".into(),
        _ => match e.raw_os_error() {
            Some(32) => "It's open in another program".into(),
            Some(123) => "That name isn't allowed".into(),
            Some(206) => "The name or path is too long".into(),
            _ => e.to_string().split(" (os error").next().unwrap_or_default().to_string(),
        },
    }
}

/// Explorer's own rule for file and folder names.
fn check_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("Enter a name".into());
    }
    if name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        return Err(r#"A name can't contain any of these characters: \ / : * ? " < > |"#.into());
    }
    if name.ends_with('.') {
        return Err("A name can't end with a dot".into());
    }
    Ok(())
}

pub fn rename(path: &str, new_name: &str) -> Result<String, String> {
    check_name(new_name)?;
    let src = Path::new(path);
    let parent = src.parent().ok_or("No parent folder")?;
    let dest = parent.join(new_name.trim());
    // Windows names are case-insensitive: "a.txt" -> "A.txt" is the same item, allowed.
    let same_item = src
        .file_name()
        .is_some_and(|n| n.to_string_lossy().to_lowercase() == new_name.trim().to_lowercase());
    if dest.exists() && !same_item {
        return Err("Something with that name already exists".into());
    }
    fs::rename(src, &dest).map_err(|e| format!("Couldn't rename: {}", friendly(&e)))?;
    Ok(dest.to_string_lossy().to_string())
}

pub fn delete_to_trash(paths: Vec<String>) -> Result<(), String> {
    for p in paths {
        trash::delete(&p).map_err(|e| format!("Couldn't move to Recycle Bin: {e}"))?;
    }
    Ok(())
}

pub fn create_folder(parent: &str, name: &str) -> Result<String, String> {
    check_name(name)?;
    let dest = Path::new(parent).join(name);
    if dest.exists() {
        return Err("A folder with that name already exists".into());
    }
    fs::create_dir(&dest).map_err(|e| format!("Couldn't create folder: {}", friendly(&e)))?;
    Ok(dest.to_string_lossy().to_string())
}

pub fn create_file(parent: &str, name: &str) -> Result<String, String> {
    check_name(name)?;
    let dest = Path::new(parent).join(name);
    if dest.exists() {
        return Err("A file with that name already exists".into());
    }
    fs::File::create(&dest).map_err(|e| format!("Couldn't create file: {}", friendly(&e)))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Pick a non-clashing destination path inside `dest_dir` for `src`'s file name.
pub(crate) fn unique_dest(dest_dir: &Path, src: &Path) -> PathBuf {
    let file_name = src.file_name().unwrap_or_default();
    let mut candidate = dest_dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = src.extension().map(|e| e.to_string_lossy().to_string());
    let mut n = 1;
    loop {
        let name = match &ext {
            Some(e) => format!("{stem} (copy {n}).{e}"),
            None => format!("{stem} (copy {n})"),
        };
        candidate = dest_dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
        n += 1;
    }
}

fn copy_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dest)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let child_dest = dest.join(entry.file_name());
            copy_recursive(&entry.path(), &child_dest)?;
        }
        Ok(())
    } else {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dest)?;
        Ok(())
    }
}

/// Refuse to copy/move a folder into itself (would recurse forever).
fn check_not_inside(src: &Path, dest_dir: &Path) -> Result<(), String> {
    if src.is_dir() && dest_dir.starts_with(src) {
        return Err(format!(
            "Can't put \"{}\" inside itself",
            src.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    Ok(())
}

/// Copies each path into `dest_dir`; returns the new paths, in order.
pub fn copy_entries(paths: Vec<String>, dest_dir: &str) -> Result<Vec<String>, String> {
    let dest_dir = Path::new(dest_dir);
    let mut created = Vec::new();
    for p in paths {
        let src = PathBuf::from(&p);
        check_not_inside(&src, dest_dir)?;
        let dest = unique_dest(dest_dir, &src);
        copy_clean(&src, &dest).map_err(|e| format!("Couldn't copy {}: {}", name_of(&src), friendly(&e)))?;
        created.push(dest.to_string_lossy().to_string());
    }
    Ok(created)
}

/// Moves each path into `dest_dir`; returns the new paths, in order.
pub fn move_entries(paths: Vec<String>, dest_dir: &str) -> Result<Vec<String>, String> {
    let dest_dir = Path::new(dest_dir);
    let mut moved = Vec::new();
    for p in paths {
        let src = PathBuf::from(&p);
        check_not_inside(&src, dest_dir)?;
        if src.parent() == Some(dest_dir) {
            moved.push(p); // already there
            continue;
        }
        // Never overwrite: on Windows fs::rename silently replaces existing files.
        let dest = unique_dest(dest_dir, &src);
        move_one(&src, &dest)?;
        moved.push(dest.to_string_lossy().to_string());
    }
    Ok(moved)
}

/// Move `src` to exactly `dest`.
fn move_one(src: &Path, dest: &Path) -> Result<(), String> {
    // Try a fast rename first; fall back to copy+delete across volumes.
    if fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    copy_clean(src, dest).map_err(|e| format!("Couldn't move {}: {}", name_of(src), friendly(&e)))?;
    let removed = if src.is_dir() { fs::remove_dir_all(src) } else { fs::remove_file(src) };
    removed.map_err(|e| {
        format!("Copied {}, but couldn't remove the original: {}", name_of(src), friendly(&e))
    })
}

fn name_of(p: &Path) -> String {
    p.file_name().unwrap_or(p.as_os_str()).to_string_lossy().to_string()
}

/// Copy, removing any partial result if it fails part-way (full disk, file in use…).
fn copy_clean(src: &Path, dest: &Path) -> std::io::Result<()> {
    let result = copy_recursive(src, dest);
    if result.is_err() {
        let _ = if dest.is_dir() { fs::remove_dir_all(dest) } else { fs::remove_file(dest) };
    }
    result
}

/// Undo a move: put each `(current, original)` back at its original path.
/// If something new now occupies the original path, the item gets a
/// "(copy n)" name next to it rather than overwriting it.
pub fn restore(items: Vec<(String, String)>) -> Result<(), String> {
    for (current, original) in items {
        let src = PathBuf::from(&current);
        let mut dest = PathBuf::from(&original);
        if dest.exists() {
            let dir = dest.parent().ok_or("No parent folder")?.to_path_buf();
            dest = unique_dest(&dir, &dest);
        }
        move_one(&src, &dest)?;
    }
    Ok(())
}

pub fn open_path(path: &str) -> Result<(), String> {
    opener::open(path).map_err(|e| format!("Couldn't open: {e}"))
}

/// Open the containing folder in Windows Explorer with the item selected.
pub fn reveal(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // explorer.exe needs the exact `/select,"path"` form, so pass it unescaped.
        std::process::Command::new("explorer.exe")
            .raw_arg(format!("/select,\"{path}\""))
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Couldn't open Explorer: {e}"))
    }
    #[cfg(not(windows))]
    {
        let parent = Path::new(path).parent().ok_or("No containing folder")?;
        opener::open(parent).map_err(|e| format!("Couldn't open folder: {e}"))
    }
}
