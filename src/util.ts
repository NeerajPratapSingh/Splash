import type { Entry, Kind, SortKey, SortDir } from "./types";

export function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export function formatDate(secs: number): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Natural order like Explorer: "photo-2" before "photo-10". One shared collator
// is much faster than calling localeCompare per comparison.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const compareNames = (a: string, b: string) => collator.compare(a, b);

export function sortEntries(
  entries: Entry[],
  key: SortKey,
  dir: SortDir,
  foldersFirst = true
): Entry[] {
  const mult = dir === "asc" ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (foldersFirst && a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    let cmp = 0;
    switch (key) {
      case "name":
        cmp = collator.compare(a.name, b.name);
        break;
      case "size":
        cmp = a.size - b.size;
        break;
      case "modified":
        cmp = a.modified - b.modified;
        break;
      case "created":
        cmp = a.created - b.created;
        break;
      case "type":
        cmp = collator.compare(a.extension, b.extension);
        break;
    }
    // Ties always fall back to name order.
    return cmp * mult || collator.compare(a.name, b.name);
  });
}

/** Kinds in the order their groups appear. */
export const KINDS: { kind: Kind; label: string }[] = [
  { kind: "folder", label: "Folders" },
  { kind: "image", label: "Images" },
  { kind: "video", label: "Videos" },
  { kind: "audio", label: "Audio" },
  { kind: "document", label: "Documents" },
  { kind: "archive", label: "Archives" },
  { kind: "code", label: "Code" },
  { kind: "app", label: "Apps" },
  { kind: "other", label: "Other" },
];

export function kindOf(entry: Entry): Kind {
  if (entry.is_dir) return "folder";
  const e = entry.extension;
  if (IMAGE.has(e)) return "image";
  if (VIDEO.has(e)) return "video";
  if (AUDIO.has(e)) return "audio";
  if (e === "pdf" || DOC.has(e) || SHEET.has(e) || SLIDE.has(e)) return "document";
  if (ARCHIVE.has(e)) return "archive";
  if (CODE.has(e)) return "code";
  if (EXE.has(e)) return "app";
  return "other";
}

const DAY = 86_400_000;

/**
 * Explorer-style relative date group. `rank` orders groups newest first.
 */
export function dateGroup(secs: number, now = new Date()): { rank: number; label: string } {
  if (!secs) return { rank: 8, label: "Unknown date" };
  const t = secs * 1000;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = today - ((now.getDay() + 6) % 7) * DAY; // Monday
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
  if (t >= today) return { rank: 0, label: "Today" };
  if (t >= today - DAY) return { rank: 1, label: "Yesterday" };
  if (t >= weekStart) return { rank: 2, label: "Earlier this week" };
  if (t >= weekStart - 7 * DAY) return { rank: 3, label: "Last week" };
  if (t >= monthStart) return { rank: 4, label: "Earlier this month" };
  if (t >= lastMonthStart) return { rank: 5, label: "Last month" };
  if (t >= yearStart) return { rank: 6, label: "Earlier this year" };
  return { rank: 7, label: "A long time ago" };
}

const IMAGE = new Set([
  "png", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "heic", "heif", "avif",
]);
const VIDEO = new Set(["mp4", "mkv", "mov", "avi", "webm", "flv", "wmv"]);
const AUDIO = new Set(["mp3", "wav", "flac", "ogg", "m4a", "aac"]);
const ARCHIVE = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "zst"]);

/** Archives the app can extract (ZIP in-process, the rest via Windows' tar). */
export const isArchive = (entry: Entry) => !entry.is_dir && ARCHIVE.has(entry.extension);
const CODE = new Set([
  "js", "ts", "tsx", "jsx", "py", "rs", "go", "java", "c", "cpp", "h",
  "cs", "rb", "php", "html", "css", "json", "xml", "yml", "yaml", "sh", "sql",
]);
const DOC = new Set(["doc", "docx", "txt", "md", "rtf", "odt"]);
const SHEET = new Set(["xls", "xlsx", "csv", "ods"]);
const SLIDE = new Set(["ppt", "pptx", "odp"]);
const EXE = new Set(["exe", "msi", "bat", "cmd", "app"]);

export interface IconSpec {
  glyph: string;
  color: string;
}

export function iconFor(entry: Entry): IconSpec {
  if (entry.is_dir) return { glyph: "folder", color: "#f0b429" };
  const e = entry.extension;
  if (e === "pdf") return { glyph: "file", color: "#e5484d" };
  if (IMAGE.has(e)) return { glyph: "image", color: "#30a46c" };
  if (VIDEO.has(e)) return { glyph: "video", color: "#8e4ec6" };
  if (AUDIO.has(e)) return { glyph: "audio", color: "#e93d82" };
  if (ARCHIVE.has(e)) return { glyph: "archive", color: "#d9730d" };
  if (CODE.has(e)) return { glyph: "code", color: "#4593ff" };
  if (DOC.has(e)) return { glyph: "file", color: "#2b6cb0" };
  if (SHEET.has(e)) return { glyph: "file", color: "#1a7f52" };
  if (SLIDE.has(e)) return { glyph: "file", color: "#c4531d" };
  if (EXE.has(e)) return { glyph: "exe", color: "#9ca3af" };
  return { glyph: "file", color: "#94a3b8" };
}

/** Basename of a Windows or POSIX path. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** Path without trailing separators, lowercased, for comparisons. */
export function normPath(path: string): string {
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

/** Containing folder of a path ("C:\foo" -> "C:\"). */
export function dirname(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (i < 0) return trimmed;
  const dir = trimmed.slice(0, i);
  return /^[a-zA-Z]:$/.test(dir) ? dir + "\\" : dir || "/";
}

export const isDriveRoot = (path: string) => /^[a-zA-Z]:[\\/]?$/.test(path);

/** Short display name for a folder: "Downloads", or "W:" for a drive root. */
export const folderLabel = (path: string) =>
  isDriveRoot(path) ? path.slice(0, 2) : basename(path);

/** Split a path into { name, crumbs:[{label, path}] } for breadcrumbs. */
export function breadcrumbs(path: string): { label: string; path: string }[] {
  const isWin = /^[a-zA-Z]:[\\/]/.test(path) || path.includes("\\");
  const sep = isWin ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter(Boolean);
  const crumbs: { label: string; path: string }[] = [];
  let acc = "";
  parts.forEach((part, idx) => {
    if (isWin && idx === 0) {
      // Drive letter: "C:" -> path "C:\"
      acc = part + sep;
      crumbs.push({ label: part, path: acc });
    } else {
      acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
      crumbs.push({ label: part, path: acc });
    }
  });
  return crumbs;
}
