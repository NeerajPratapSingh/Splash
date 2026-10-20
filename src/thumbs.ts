import { convertFileSrc } from "@tauri-apps/api/core";
import type { Entry } from "./types";

// Files the Windows shell can usually thumbnail. Anything it can't just keeps
// its regular icon (the backend answers 404).
const THUMB = new Set([
  "png", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "tif", "tiff", "ico", "heic", "heif", "avif",
  "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "raf",
  "mp4", "mkv", "mov", "avi", "wmv", "webm", "m4v", "flv",
]);

// Formats the webview can show full-size in the quick-look preview.
const VIEWABLE = new Set(["png", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "ico", "svg", "avif"]);

export const hasThumb = (e: Entry) => !e.is_dir && THUMB.has(e.extension);
export const canPreview = (e: Entry) => !e.is_dir && VIEWABLE.has(e.extension);

// The modified time is part of the URL, so an edited photo gets a fresh thumbnail.
export const thumbUrl = (e: Entry, px: number) =>
  `${convertFileSrc(e.path, "thumb")}?s=${px}&m=${e.modified}`;

export const fileUrl = (path: string) => convertFileSrc(path);

// One shared observer: thumbnails are only requested once they're near the
// screen, so big folders don't flood the thumbnail queue.
const pending = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | null = null;

export function whenVisible(el: Element, cb: () => void): () => void {
  observer ??= new IntersectionObserver(
    (items) => {
      for (const it of items) {
        if (!it.isIntersecting) continue;
        observer!.unobserve(it.target);
        pending.get(it.target)?.();
        pending.delete(it.target);
      }
    },
    { rootMargin: "300px" }
  );
  pending.set(el, cb);
  observer.observe(el);
  return () => {
    observer!.unobserve(el);
    pending.delete(el);
  };
}
