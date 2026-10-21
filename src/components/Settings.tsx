import { useEffect, useState } from "react";
import { api } from "../api";
import { APP_VERSION, REPO_URL, SUPPORT_URL } from "../config";
import { UIIcon } from "./Icon";

interface Props {
  showHidden: boolean;
  onShowHidden: (on: boolean) => void;
  searchIndex: boolean;
  onSearchIndex: (on: boolean) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

function Switch({ on, onChange, busy }: { on: boolean; onChange: (on: boolean) => void; busy?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      className={`switch ${on ? "on" : ""}`}
      disabled={busy}
      onClick={() => onChange(!on)}
    >
      <span />
    </button>
  );
}

export function Settings({ showHidden, onShowHidden, searchIndex, onSearchIndex, onError, onClose }: Props) {
  const [isDefault, setIsDefault] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.isDefaultApp().then(setIsDefault, () => setIsDefault(false));
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onClose]);

  const toggleDefault = async (on: boolean) => {
    setBusy(true);
    try {
      await api.setDefaultApp(on);
      setIsDefault(await api.isDefaultApp());
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <UIIcon name="x" size={16} />
          </button>
        </div>

        <div className="setting">
          <div>
            <div className="setting-title">Open folders with Splash (make default)</div>
            <div className="setting-note">
              Folders, drives and <kbd>Win</kbd>+<kbd>E</kbd> open in Splash instead of File Explorer. Turn it off any
              time to switch back; uninstalling Splash switches back too.
            </div>
          </div>
          <Switch on={!!isDefault} busy={busy || isDefault === null} onChange={toggleDefault} />
        </div>

        <div className="setting">
          <div>
            <div className="setting-title">Instant search</div>
            <div className="setting-note">
              Remembers every file name on your drives so Search this PC answers instantly. Uses about 35 MB of
              memory while you search (freed after 10 minutes unused) and a similar amount of disk.
            </div>
          </div>
          <Switch on={searchIndex} onChange={onSearchIndex} />
        </div>

        <div className="setting">
          <div>
            <div className="setting-title">Show hidden items</div>
            <div className="setting-note">Hidden and system files, like AppData and $RECYCLE.BIN.</div>
          </div>
          <Switch on={showHidden} onChange={onShowHidden} />
        </div>

        <div className="modal-foot">
          <span>Splash {APP_VERSION} · free and open source (MIT)</span>
          <span className="modal-links">
            {REPO_URL && <button onClick={() => void api.openPath(REPO_URL)}>Source code</button>}
            {SUPPORT_URL && <button onClick={() => void api.openPath(SUPPORT_URL)}>☕ Support Splash</button>}
          </span>
        </div>
      </div>
    </div>
  );
}
