import { useEffect, useState } from "react";
import type { Entry } from "../types";
import { fileUrl } from "../thumbs";

interface Props {
  items: Entry[];
  index: number;
  onClose: () => void;
}

/** Full-size photo preview (Space). ←/→ step through the folder's images. */
export function QuickLook({ items, index, onClose }: Props) {
  const [i, setI] = useState(index);
  const entry = items[i];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Capture phase: keep explorer shortcuts from firing underneath.
      e.stopImmediatePropagation();
      if (e.key === "Escape" || e.key === " " || e.key === "Enter") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setI((x) => Math.min(items.length - 1, x + 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setI((x) => Math.max(0, x - 1));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [items.length, onClose]);

  if (!entry) return null;
  return (
    <div className="quicklook" onClick={onClose}>
      <img
        key={entry.path}
        src={fileUrl(entry.path)}
        alt={entry.name}
        decoding="async"
        onClick={(e) => e.stopPropagation()}
      />
      <div className="ql-caption">
        {entry.name}
        {items.length > 1 && (
          <span className="ql-count">
            {i + 1} / {items.length}
          </span>
        )}
      </div>
    </div>
  );
}
