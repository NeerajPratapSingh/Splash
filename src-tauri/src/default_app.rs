//! "Make Splash the default": folders, drives and Win+E open in Splash
//! instead of Windows Explorer.
//!
//! Same approach as other Explorer replacements: per-user entries under
//! HKCU\Software\Classes (no admin), overriding the defaults Windows keeps in
//! HKLM. Turning it off deletes exactly what we wrote, which hands everything
//! back to Explorer. The uninstaller does the same (windows/hooks.nsh).

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::System::Registry::{
    RegDeleteKeyValueW, RegDeleteTreeW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
    RRF_RT_REG_SZ,
};
use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};

const VERB: &str = "Splash.Open";
/// Win+E and "This PC" shortcuts ("open new window" on the This PC object).
const WIN_E: &str = r"Software\Classes\CLSID\{52205fd8-5dfb-447d-801a-d0b52f2e83e1}";
const TARGETS: [&str; 2] = [r"Software\Classes\Directory\shell", r"Software\Classes\Drive\shell"];

fn set(key: &str, name: Option<&str>, value: &str) -> Result<(), String> {
    let data: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    let name = name.map(HSTRING::from);
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(key),
            name.as_ref().map(|n| PCWSTR(n.as_ptr())).unwrap_or(PCWSTR::null()),
            REG_SZ.0,
            Some(data.as_ptr() as *const _),
            (data.len() * 2) as u32,
        )
    }
    .ok()
    .map_err(|e| format!("Couldn't update Windows settings: {e}"))
}

fn get(key: &str, name: Option<&str>) -> Option<String> {
    let name = name.map(HSTRING::from);
    let name = name.as_ref().map(|n| PCWSTR(n.as_ptr())).unwrap_or(PCWSTR::null());
    let mut buf = [0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(key),
            name,
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        )
    }
    .ok()
    .ok()?;
    let len = buf.iter().position(|&c| c == 0).unwrap_or(0);
    Some(String::from_utf16_lossy(&buf[..len]))
}

fn exe() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// Splash is the default when the folder verb points at this copy of the app.
pub fn is_default() -> bool {
    let Ok(exe) = exe() else { return false };
    TARGETS.iter().all(|t| {
        get(t, None).as_deref() == Some(VERB)
            && get(&format!(r"{t}\{VERB}\command"), None).is_some_and(|c| c.contains(&exe))
    })
}

pub fn set_default(on: bool) -> Result<(), String> {
    if on {
        let exe = exe()?;
        let open_folder = format!("\"{exe}\" \"%1\"");
        for t in TARGETS {
            set(&format!(r"{t}\{VERB}"), None, "Open in Splash")?;
            set(&format!(r"{t}\{VERB}"), Some("Icon"), &exe)?;
            set(&format!(r"{t}\{VERB}\command"), None, &open_folder)?;
            set(t, None, VERB)?; // make it the default action
        }
        let cmd = format!(r"{WIN_E}\shell\opennewwindow\command");
        set(&cmd, None, &format!("\"{exe}\""))?;
        set(&cmd, Some("DelegateExecute"), "")?;
        set(WIN_E, Some("SplashOwner"), "1")?; // so the uninstaller knows this key is ours
    } else {
        unsafe {
            for t in TARGETS {
                if get(t, None).as_deref() == Some(VERB) {
                    let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(t), PCWSTR::null());
                }
                let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(format!(r"{t}\{VERB}")));
            }
            if get(WIN_E, Some("SplashOwner")).as_deref() == Some("1") {
                let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(WIN_E));
                let _ = windows::Win32::System::Registry::RegDeleteKeyW(HKEY_CURRENT_USER, &HSTRING::from(WIN_E));
            }
        }
    }
    // Tell Explorer the associations changed so it picks this up right away.
    unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
    Ok(())
}
