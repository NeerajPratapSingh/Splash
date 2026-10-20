import { useEffect, useState } from "react";
import { UIIcon } from "./Icon";

export interface ToastAction {
  label: string;
  run: () => Promise<void>;
}

export interface ToastData {
  id: number;
  kind: "info" | "error";
  text: string;
  actions?: ToastAction[];
}

interface Props {
  toast: ToastData;
  onClose: () => void;
}

/** Bottom notice after an operation. Stays open while hovered or while an action runs. */
export function Toast({ toast, onClose }: Props) {
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (hover || busy) return;
    const t = setTimeout(onClose, toast.actions?.length ? 7000 : 4000);
    return () => clearTimeout(t);
  }, [hover, busy, onClose, toast.actions]);

  return (
    <div
      className={`toast ${toast.kind}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className="toast-text">{toast.text}</span>
      {toast.actions?.map((a) => (
        <button
          key={a.label}
          className="toast-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await a.run();
            } finally {
              setBusy(false);
            }
          }}
        >
          {a.label}
        </button>
      ))}
      <button className="toast-close" title="Dismiss" onClick={onClose}>
        <UIIcon name="x" size={13} />
      </button>
    </div>
  );
}
