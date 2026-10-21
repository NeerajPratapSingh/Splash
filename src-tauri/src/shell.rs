//! Windows shell integration: the extra entries other apps add to the right-
//! click menu (WinRAR, OneDrive, PowerRename, Send to…) shown inside Splash'
//! own menu, plus Properties, Open with, and Open in Terminal.
//!
//! Functions taking an HWND must run on the window's (main) thread.

use base64::Engine;
use serde::Serialize;
use std::cell::RefCell;
use windows::core::{Interface, HSTRING, PCSTR, PCWSTR, PSTR, PWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::HBITMAP;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    ILFindLastID, IContextMenu, IContextMenu2, IShellFolder, SHBindToParent, SHObjectProperties,
    SHOpenWithDialog, SHParseDisplayName, CMF_NORMAL, CMIC_MASK_PTINVOKE, CMINVOKECOMMANDINFO,
    CMINVOKECOMMANDINFOEX, GCS_VERBW, OAIF_ALLOW_REGISTRATION, OAIF_EXEC, OAIF_REGISTER_EXT,
    OPENASINFO, SEE_MASK_UNICODE, // = CMIC_MASK_UNICODE
    SHOP_FILEPATH,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreatePopupMenu, DestroyMenu, GetCursorPos, GetMenuItemCount, GetMenuItemInfoW, HMENU,
    MENUITEMINFOW, MFS_DISABLED, MFT_SEPARATOR, MIIM_BITMAP, MIIM_FTYPE, MIIM_ID, MIIM_STATE,
    MIIM_STRING, MIIM_SUBMENU, SW_SHOWNORMAL, WM_INITMENUPOPUP,
};

/// One entry of the native menu, as sent to the UI.
#[derive(Serialize)]
pub struct NativeItem {
    id: u32,
    label: String,
    /// Language-independent action name ("openas", "print"…), when it has one.
    verb: Option<String>,
    /// PNG data URL of the entry's icon, if it has one.
    icon: Option<String>,
    disabled: bool,
    separator: bool,
    children: Vec<NativeItem>,
}

/// The menu whose entries were last sent to the UI, kept alive until one is
/// picked (or the next menu replaces it).
struct NativeMenu {
    menu_obj: IContextMenu,
    menu: HMENU,
    hwnd: HWND,
}

impl Drop for NativeMenu {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyMenu(self.menu);
        }
    }
}

thread_local! {
    static NATIVE: RefCell<Option<NativeMenu>> = const { RefCell::new(None) };
}

type Job = Box<dyn FnOnce() + Send>;

/// Run `f` on a dedicated COM (STA) thread that keeps pumping window messages.
///
/// Building Windows' menu loads every app's shell extension and can take a
/// second the first time; doing that on the main thread would stall the
/// window and its IPC. The menu objects then live on this thread, so picking
/// an entry runs here too (and any UI an extension shows gets its messages).
pub fn on_shell_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
    use std::sync::OnceLock;
    static JOBS: OnceLock<std::sync::Mutex<Sender<Job>>> = OnceLock::new();
    let jobs = JOBS.get_or_init(|| {
        let (tx, rx) = channel::<Job>();
        std::thread::spawn(move || unsafe {
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
            use windows::Win32::UI::WindowsAndMessaging::{
                DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
            };
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            loop {
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
                match rx.recv_timeout(std::time::Duration::from_millis(15)) {
                    Ok(job) => job(),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        });
        std::sync::Mutex::new(tx)
    });
    let (done_tx, done_rx) = channel();
    let job: Job = Box::new(move || {
        let _ = done_tx.send(f());
    });
    jobs.lock().unwrap().send(job).expect("shell thread stopped");
    done_rx.recv().expect("shell thread stopped")
}

// Verbs Splash' own menu already offers, so they aren't listed twice.
const OWN_VERBS: &[&str] = &[
    "open", "cut", "copy", "paste", "delete", "rename", "properties", "copyaspath", "explore",
];

/// Entries Windows (and installed apps) would show for `paths`, minus ones
/// Splash already has. Pick one with `invoke_native_item`.
pub fn native_menu_items(hwnd: HWND, paths: &[String]) -> Result<Vec<NativeItem>, String> {
    NATIVE.with(|n| *n.borrow_mut() = None);
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    unsafe {
        let mut pidls: Vec<*mut ITEMIDLIST> = Vec::new();
        for p in paths {
            let mut pidl = std::ptr::null_mut();
            if let Err(e) = SHParseDisplayName(&HSTRING::from(p.as_str()), None, &mut pidl, 0, None) {
                pidls.iter().for_each(|p| CoTaskMemFree(Some(*p as _)));
                return Err(e.to_string());
            }
            pidls.push(pidl);
        }

        let result = (|| -> windows::core::Result<Vec<NativeItem>> {
            let folder: IShellFolder = SHBindToParent(pidls[0], None)?;
            let children: Vec<*const ITEMIDLIST> =
                pidls.iter().map(|p| ILFindLastID(*p) as *const ITEMIDLIST).collect();
            let menu_obj: IContextMenu = folder.GetUIObjectOf(hwnd, &children, None)?;
            let menu = CreatePopupMenu()?;
            menu_obj.QueryContextMenu(menu, 0, 1, 0x7FFF, CMF_NORMAL).ok()?;
            let menu2: Option<IContextMenu2> = menu_obj.cast().ok();
            let items = read_menu(&menu_obj, menu2.as_ref(), menu, 0);
            NATIVE.with(|n| *n.borrow_mut() = Some(NativeMenu { menu_obj, menu, hwnd }));
            Ok(items)
        })();

        pidls.iter().for_each(|p| CoTaskMemFree(Some(*p as _)));
        result.map_err(|e| e.to_string())
    }
}

/// Run the native entry `id` from the last `native_menu_items` call.
pub fn invoke_native_item(id: u32) -> Result<(), String> {
    let native = NATIVE
        .with(|n| n.borrow_mut().take())
        .ok_or("That menu has expired; right-click again")?;
    unsafe {
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        let verb = (id - 1) as usize; // command offset as a fake pointer, per the API
        let info = CMINVOKECOMMANDINFOEX {
            cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
            fMask: SEE_MASK_UNICODE | CMIC_MASK_PTINVOKE,
            hwnd: native.hwnd,
            lpVerb: PCSTR(verb as *const u8),
            lpVerbW: PCWSTR(verb as *const u16),
            nShow: SW_SHOWNORMAL.0,
            ptInvoke: pt,
            ..Default::default()
        };
        native
            .menu_obj
            .InvokeCommand(&info as *const _ as *const CMINVOKECOMMANDINFO)
            .map_err(|e| e.to_string())
    }
}

unsafe fn read_menu(
    menu_obj: &IContextMenu,
    menu2: Option<&IContextMenu2>,
    menu: HMENU,
    depth: u32,
) -> Vec<NativeItem> {
    let mut out: Vec<NativeItem> = Vec::new();
    for i in 0..GetMenuItemCount(Some(menu)).max(0) as u32 {
        let mut text = [0u16; 512];
        let mut info = MENUITEMINFOW {
            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_FTYPE | MIIM_ID | MIIM_STATE | MIIM_SUBMENU | MIIM_STRING | MIIM_BITMAP,
            dwTypeData: PWSTR(text.as_mut_ptr()),
            cch: text.len() as u32,
            ..Default::default()
        };
        if GetMenuItemInfoW(menu, i, true, &mut info).is_err() {
            continue;
        }
        if (info.fType & MFT_SEPARATOR).0 != 0 {
            out.push(NativeItem {
                id: 0,
                label: String::new(),
                verb: None,
                icon: None,
                disabled: false,
                separator: true,
                children: Vec::new(),
            });
            continue;
        }
        let label = clean_label(&String::from_utf16_lossy(&text[..info.cch as usize]));
        if label.is_empty() {
            continue; // owner-drawn entries with no text can't be shown
        }

        let mut children = Vec::new();
        let mut verb = None;
        if !info.hSubMenu.is_invalid() {
            // Some submenus ("Send to", "Open with") fill in only when opened.
            if let Some(m2) = menu2 {
                let _ = m2.HandleMenuMsg(WM_INITMENUPOPUP, WPARAM(info.hSubMenu.0 as usize), LPARAM(i as isize));
            }
            if depth < 3 {
                children = read_menu(menu_obj, menu2, info.hSubMenu, depth + 1);
            }
            if !children.iter().any(|c| !c.separator) {
                continue;
            }
        } else {
            verb = verb_of(menu_obj, info.wID).map(|v| v.to_ascii_lowercase());
            if depth == 0 && verb.as_deref().is_some_and(|v| OWN_VERBS.contains(&v)) {
                continue;
            }
        }

        out.push(NativeItem {
            id: info.wID,
            label,
            verb,
            icon: icon_data_url(info.hbmpItem),
            disabled: (info.fState & MFS_DISABLED).0 != 0,
            separator: false,
            children,
        });
    }
    tidy_separators(out)
}

/// The language-independent verb ("open", "delete"…) for a menu command.
unsafe fn verb_of(menu_obj: &IContextMenu, id: u32) -> Option<String> {
    if id == 0 {
        return None;
    }
    let mut buf = [0u16; 128];
    menu_obj
        .GetCommandString((id - 1) as usize, GCS_VERBW, None, PSTR(buf.as_mut_ptr() as *mut u8), buf.len() as u32)
        .ok()?;
    let len = buf.iter().position(|&c| c == 0).unwrap_or(0);
    (len > 0).then(|| String::from_utf16_lossy(&buf[..len]))
}

/// "&Open in new\tCtrl+O" -> "Open in new"
fn clean_label(raw: &str) -> String {
    let text = raw.split('\t').next().unwrap_or("");
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '&' {
            if chars.peek() == Some(&'&') {
                out.push('&');
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

fn icon_data_url(hbmp: HBITMAP) -> Option<String> {
    // Small values are special markers (HBMMENU_CALLBACK etc.), not bitmaps.
    if (hbmp.0 as isize) <= 12 {
        return None;
    }
    let (w, h, rgba) = unsafe { crate::thumbs::bitmap_rgba(hbmp)? };
    let png = crate::thumbs::encode_png(w, h, &rgba)?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

/// No leading, trailing or doubled separators.
fn tidy_separators(items: Vec<NativeItem>) -> Vec<NativeItem> {
    let mut out: Vec<NativeItem> = Vec::new();
    for item in items {
        if item.separator && out.last().map_or(true, |l| l.separator) {
            continue;
        }
        out.push(item);
    }
    while out.last().is_some_and(|l| l.separator) {
        out.pop();
    }
    out
}

/// The standard Windows Properties dialog.
pub fn properties(hwnd: HWND, path: &str) -> Result<(), String> {
    let ok = unsafe { SHObjectProperties(Some(hwnd), SHOP_FILEPATH, &HSTRING::from(path), PCWSTR::null()) };
    if ok.as_bool() {
        Ok(())
    } else {
        Err("Couldn't open Properties".into())
    }
}

/// The standard "How do you want to open this file?" picker; opens the file
/// with whatever is chosen.
pub fn open_with(hwnd: HWND, path: &str) -> Result<(), String> {
    let file = HSTRING::from(path);
    let info = OPENASINFO {
        pcszFile: PCWSTR(file.as_ptr()),
        pcszClass: PCWSTR::null(),
        oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_REGISTER_EXT | OAIF_EXEC,
    };
    // Cancelling also returns an error; that's not worth reporting.
    let _ = unsafe { SHOpenWithDialog(Some(hwnd), &info) };
    Ok(())
}

/// Windows Terminal in `dir`, falling back to PowerShell.
pub fn open_terminal(dir: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    if Command::new("wt.exe").arg("-d").arg(dir).spawn().is_ok() {
        return Ok(());
    }
    const CREATE_NEW_CONSOLE: u32 = 0x10;
    Command::new("powershell.exe")
        .arg("-NoExit")
        .current_dir(dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Couldn't open a terminal: {e}"))
}
