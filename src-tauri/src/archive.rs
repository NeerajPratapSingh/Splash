//! Compress to ZIP and extract archives.
//!
//! ZIP is handled in-process; 7z, RAR and TAR/GZ go through Windows' built-in
//! `tar.exe` (libarchive). Extraction always unpacks into a scratch folder
//! first, so a failure leaves nothing half-extracted and nothing existing is
//! ever overwritten.

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::fs_ops::unique_dest;

/// First free "name.ext", "name (2).ext", … in `dir`.
fn free_name(dir: &Path, stem: &str, ext: Option<&str>) -> PathBuf {
    let file = |n: Option<u32>| {
        let base = match n {
            Some(n) => format!("{stem} ({n})"),
            None => stem.to_string(),
        };
        match ext {
            Some(e) => dir.join(format!("{base}.{e}")),
            None => dir.join(base),
        }
    };
    let mut candidate = file(None);
    let mut n = 2;
    while candidate.exists() {
        candidate = file(Some(n));
        n += 1;
    }
    candidate
}

/// Zip `paths` (all from one folder) into "<first item>.zip" beside them.
/// Returns the new zip's path.
pub fn compress(paths: Vec<String>) -> Result<String, String> {
    let first = PathBuf::from(paths.first().ok_or("Nothing to compress")?);
    let base = first.parent().ok_or("No parent folder")?.to_path_buf();
    let stem = if first.is_dir() { first.file_name() } else { first.file_stem() }
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let dest = free_name(&base, &stem, Some("zip"));
    if let Err(e) = write_zip(&paths, &base, &dest) {
        let _ = fs::remove_file(&dest);
        return Err(format!("Couldn't compress: {e}"));
    }
    Ok(dest.to_string_lossy().to_string())
}

fn write_zip(paths: &[String], base: &Path, dest: &Path) -> io::Result<()> {
    let mut zip = ZipWriter::new(File::create(dest)?);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for p in paths {
        for entry in WalkDir::new(p) {
            let entry = entry.map_err(io::Error::other)?;
            let rel = entry.path().strip_prefix(base).map_err(io::Error::other)?;
            // ZIP paths always use forward slashes.
            let name = rel.to_string_lossy().replace('\\', "/");
            if entry.file_type().is_dir() {
                zip.add_directory(name, opts).map_err(io::Error::other)?;
            } else {
                let big = entry.metadata().map(|m| m.len() >= 0xFFFF_FFFF).unwrap_or(false);
                zip.start_file(name, opts.large_file(big)).map_err(io::Error::other)?;
                io::copy(&mut File::open(entry.path())?, &mut zip)?;
            }
        }
    }
    zip.finish().map_err(io::Error::other)?;
    Ok(())
}

/// Extract `archive` next to itself: into a new "<name>" folder, or (when
/// `into_folder` is false) straight into the same folder. Returns the new
/// folder, or the containing folder for "extract here".
pub fn extract(archive: String, into_folder: bool) -> Result<String, String> {
    let src = PathBuf::from(&archive);
    let dir = src.parent().ok_or("No parent folder")?.to_path_buf();
    let scratch = free_name(&dir, ".splash-extract", None);
    fs::create_dir(&scratch).map_err(|e| format!("Couldn't extract: {e}"))?;

    if let Err(e) = unpack(&src, &scratch) {
        let _ = fs::remove_dir_all(&scratch);
        return Err(format!("Couldn't extract: {e}"));
    }

    let result = if into_folder {
        // "photos.tar.gz" -> "photos"
        let mut stem = src.file_stem().unwrap_or_default().to_string_lossy().to_string();
        if stem.to_lowercase().ends_with(".tar") {
            stem.truncate(stem.len() - 4);
        }
        let target = free_name(&dir, &stem, None);
        fs::rename(&scratch, &target).map_err(|e| e.to_string())?;
        target
    } else {
        for item in fs::read_dir(&scratch).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?.path();
            fs::rename(&item, unique_dest(&dir, &item)).map_err(|e| e.to_string())?;
        }
        let _ = fs::remove_dir(&scratch);
        dir
    };
    Ok(result.to_string_lossy().to_string())
}

fn unpack(src: &Path, out: &Path) -> Result<(), String> {
    let is_zip = src
        .extension()
        .map(|e| e.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);
    if is_zip {
        let file = File::open(src).map_err(|e| e.to_string())?;
        let mut zip = ZipArchive::new(file).map_err(|e| e.to_string())?;
        // Rejects entries that would land outside `out` ("zip slip").
        return zip.extract(out).map_err(|e| e.to_string());
    }
    let mut cmd = std::process::Command::new("tar");
    cmd.arg("-xf").arg(src).arg("-C").arg(out);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|e| format!("tar not available: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}
