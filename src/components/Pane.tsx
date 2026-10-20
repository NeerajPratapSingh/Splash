import type { Clipboard, Entry, PaneState } from "../types";
import { TabBar } from "./TabBar";
import { Explorer, type ExplorerHandle } from "./Explorer";

interface Props {
  pane: PaneState;
  focused: boolean;
  split: boolean;
  clipboard: Clipboard | null;
  setClipboard: (c: Clipboard | null) => void;
  showHidden: boolean;
  onShowHidden: (on: boolean) => void;
  isPinned: (path: string) => boolean;
  onTogglePin: (path: string) => void;
  explorerRef: (tabId: number, handle: ExplorerHandle | null) => void;
  onFocus: () => void;
  onSelectTab: (id: number) => void;
  onCloseTab: (id: number) => void;
  onSplitTab: (id: number) => void;
  onNewTab: (path?: string, background?: boolean) => void;
  onOpenInOtherPane: (path: string) => void;
  onPathChange: (tabId: number, path: string) => void;
  onFsChanged: (tabId: number, dirs: string[]) => void;
  onError: (message: string) => void;
  onNotify: (message: string) => void;
  onPreview: (items: Entry[], index: number) => void;
}

/**
 * One side of the window: a tab strip plus every tab's explorer. Inactive tabs
 * stay mounted (just hidden), so switching tabs is instant and keeps their
 * history, selection and scroll position.
 */
export function Pane(p: Props) {
  return (
    <section className={`pane ${p.focused ? "focused" : ""}`} onMouseDownCapture={p.onFocus}>
      <TabBar
        tabs={p.pane.tabs}
        active={p.pane.active}
        split={p.split}
        onSelect={p.onSelectTab}
        onClose={p.onCloseTab}
        onSplit={p.onSplitTab}
        onNew={() => p.onNewTab()}
      />
      {p.pane.tabs.map((t) => (
        <div key={t.id} className={`tab-body ${t.id === p.pane.active ? "" : "inactive"}`}>
          <Explorer
            ref={(h) => p.explorerRef(t.id, h)}
            tabId={t.id}
            initialPath={t.path}
            focused={p.focused && t.id === p.pane.active}
            clipboard={p.clipboard}
            setClipboard={p.setClipboard}
            showHidden={p.showHidden}
            onShowHidden={p.onShowHidden}
            isPinned={p.isPinned}
            onTogglePin={p.onTogglePin}
            onPathChange={p.onPathChange}
            onFsChanged={p.onFsChanged}
            onError={p.onError}
            onNotify={p.onNotify}
            onOpenInNewTab={(path) => p.onNewTab(path, true)}
            onOpenInOtherPane={p.onOpenInOtherPane}
            onPreview={p.onPreview}
          />
        </div>
      ))}
    </section>
  );
}
