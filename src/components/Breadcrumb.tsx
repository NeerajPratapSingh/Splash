import { useEffect, useRef } from "react";
import { breadcrumbs } from "../util";

interface Props {
  path: string;
  onNavigate: (path: string) => void;
}

export function Breadcrumb({ path, onNavigate }: Props) {
  const crumbs = breadcrumbs(path);
  const ref = useRef<HTMLDivElement>(null);

  // Keep the current folder (the end of the path) visible when it overflows,
  // including after a resize or when a hidden tab becomes visible.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const toEnd = () => (el.scrollLeft = el.scrollWidth);
    toEnd();
    const ro = new ResizeObserver(toEnd);
    ro.observe(el);
    return () => ro.disconnect();
  }, [path]);

  return (
    <div className="breadcrumb" ref={ref}>
      {crumbs.map((c, i) => (
        <span key={c.path} className="crumb-wrap">
          <button className="crumb" onClick={() => onNavigate(c.path)}>
            {c.label}
          </button>
          {i < crumbs.length - 1 && <span className="crumb-sep">›</span>}
        </span>
      ))}
    </div>
  );
}
