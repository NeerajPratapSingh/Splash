import type React from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { normPath, dirname, basename, folderLabel } from "./util";

/**
 * Native (OLE) drag and drop: one code path for moving files between panes,
 * tabs and the sidebar, and to/from Windows Explorer and the desktop.
 *
 * Drags start from a mousedown plus a small movement on an item. Drop targets
 * are elements with a `data-drop` attribute holding the destination folder;
 * the nearest valid one under the cursor wins.
 */

export type DropKind = "copy" | "move";
export type OnDrop = (paths: string[], kind: DropKind, dest: string) => void;

interface Modifiers {
  ctrl: boolean;
  shift: boolean;
}

const THRESHOLD = 6; // px of movement before a press becomes a drag
const TAB_SWITCH_MS = 600; // hovering a tab this long while dragging opens it

/** Call from an item's onMouseDown; starts a native drag once the mouse moves. */
export function beginDrag(e: React.MouseEvent, getPaths: () => string[]) {
  if (e.button !== 0) return;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const move = (m: MouseEvent) => {
    if (Math.abs(m.clientX - x0) + Math.abs(m.clientY - y0) < THRESHOLD) return;
    stop();
    const paths = getPaths();
    // Dragging out to Explorer always copies, so a drag can never lose files.
    // Drops inside the app decide copy/move themselves (see watchDrops).
    if (paths.length) startDrag({ item: paths, icon: dragIcon(paths), mode: "copy" }).catch(() => {});
  };
  const stop = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", stop);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", stop);
}

const drive = (p: string) => p.slice(0, 2).toLowerCase();

/**
 * What dropping `paths` onto `dest` would do, or null if it isn't allowed.
 * Like Explorer: move within a drive, copy across drives; Ctrl forces copy,
 * Shift forces move.
 */
export function dropKind(paths: string[], dest: string, mods: Modifiers): DropKind | null {
  if (!paths.length || !dest) return null;
  const d = normPath(dest);
  for (const p of paths) {
    const s = normPath(p);
    if (d === s || d.startsWith(s + "\\") || d.startsWith(s + "/")) return null; // into itself
  }
  if (mods.ctrl) return "copy";
  if (paths.every((p) => normPath(dirname(p)) === d)) return null; // already there
  if (mods.shift) return "move";
  return paths.every((p) => drive(p) === drive(dest)) ? "move" : "copy";
}

const readMods = () =>
  invoke<Modifiers>("key_modifiers").catch(() => ({ ctrl: false, shift: false }));

/**
 * Listen for native drags over the window (from this app or from Explorer),
 * highlight the target under the cursor, and call `onDrop` on release.
 * Returns an unsubscribe function.
 */
export function watchDrops(onDrop: OnDrop): () => void {
  let paths: string[] = [];
  let mods: Modifiers = { ctrl: false, shift: false };
  let target: HTMLElement | null = null;
  let since = 0;

  const hint = document.createElement("div");
  hint.className = "drag-hint";

  const resolve = (x: number, y: number) => {
    let el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]") ?? null;
    while (el) {
      const kind = dropKind(paths, el.dataset.drop!, mods);
      if (kind) return { el, kind, dest: el.dataset.drop! };
      el = el.parentElement?.closest<HTMLElement>("[data-drop]") ?? null;
    }
    return null;
  };

  const setTarget = (el: HTMLElement | null) => {
    if (target === el) return;
    target?.classList.remove("drop-target");
    target = el;
    el?.classList.add("drop-target");
    since = performance.now();
  };

  const clear = () => {
    setTarget(null);
    hint.remove();
    paths = [];
  };

  const unlisten = getCurrentWebview().onDragDropEvent(async ({ payload }) => {
    if (payload.type === "leave") return clear();
    if (payload.type === "enter") paths = payload.paths;

    const dpr = window.devicePixelRatio || 1;
    const x = payload.position.x / dpr;
    const y = payload.position.y / dpr;

    if (payload.type === "drop") {
      const dropped = payload.paths.length ? payload.paths : paths;
      mods = await readMods();
      paths = dropped;
      const hit = resolve(x, y);
      clear();
      if (hit) onDrop(dropped, hit.kind, hit.dest);
      return;
    }

    // Keep modifier state fresh without blocking the hover feedback.
    readMods().then((m) => (mods = m));
    const hit = resolve(x, y);
    setTarget(hit?.el ?? null);
    if (!hit) return void hint.remove();

    hint.textContent = `${hit.kind === "move" ? "Move" : "Copy"} to ${folderLabel(hit.dest)}`;
    hint.style.transform = `translate(${x + 16}px, ${y + 18}px)`;
    if (!hint.isConnected) document.body.appendChild(hint);

    // Hovering a background tab for a moment switches to it, like a browser.
    if (
      hit.el.classList.contains("tab") &&
      !hit.el.classList.contains("active") &&
      performance.now() - since > TAB_SWITCH_MS
    )
      hit.el.click();
  });

  return () => {
    unlisten.then((f) => f());
    clear();
  };
}

/** Small "name" / "N items" label shown under the cursor while dragging. */
function dragIcon(paths: string[]): string {
  const label = paths.length === 1 ? basename(paths[0]) : `${paths.length} items`;
  const dpr = window.devicePixelRatio || 1;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  const font = `600 ${13 * dpr}px "Segoe UI", sans-serif`;
  ctx.font = font;
  const text = label.length > 40 ? label.slice(0, 38) + "…" : label;
  c.width = Math.ceil(ctx.measureText(text).width + 24 * dpr);
  c.height = Math.ceil(28 * dpr);
  ctx.font = font;
  ctx.fillStyle = "rgba(47, 67, 116, 0.95)";
  ctx.beginPath();
  ctx.roundRect(0, 0, c.width, c.height, 7 * dpr);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 12 * dpr, c.height / 2);
  return c.toDataURL("image/png");
}
