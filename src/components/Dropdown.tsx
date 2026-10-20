import { useEffect, useRef, useState } from "react";

interface Props {
  label: React.ReactNode;
  title?: string;
  /** Highlight the button (e.g. a filter is active). */
  active?: boolean;
  children: (close: () => void) => React.ReactNode;
}

/** Toolbar button with a popover menu. Closes on outside click or Escape. */
export function Dropdown({ label, title, active, children }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation(); // don't also clear the selection
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={ref}>
      <button
        className={`dd-btn ${active ? "on" : ""} ${open ? "open" : ""}`}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <svg className="dd-chevron" width="10" height="10" viewBox="0 0 10 10">
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && <div className="dd-menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function DDItem({
  checked,
  onClick,
  children,
}: {
  checked?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className={`dd-item ${checked ? "checked" : ""}`} onClick={onClick}>
      <span className="dd-check">{checked ? "✓" : ""}</span>
      {children}
    </button>
  );
}

export const DDLabel = ({ children }: { children: React.ReactNode }) => (
  <div className="dd-label">{children}</div>
);

export const DDDivider = () => <div className="dd-divider" />;
