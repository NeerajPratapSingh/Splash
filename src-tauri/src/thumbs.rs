//! Thumbnails served over a custom `thumb:` URI scheme, backed by the Windows
//! shell thumbnail cache (the same cache Explorer uses), so the UI never has to
//! decode full-size photos.
//!
//! Requests are handled by a small worker pool. The queue is LIFO: when you
//! scroll or change folders, the newest (visible) requests are served first.

use std::sync::{Arc, Condvar, Mutex};
use tauri::http::{Request, Response};
use tauri::UriSchemeResponder;

const WORKERS: usize = 4;

type Job = (String, i32, UriSchemeResponder);

#[derive(Clone)]
pub struct Pool {
    inner: Arc<(Mutex<Vec<Job>>, Condvar)>,
}

impl Pool {
    pub fn new() -> Self {
        let inner = Arc::new((Mutex::new(Vec::<Job>::new()), Condvar::new()));
        for _ in 0..WORKERS {
            let inner = inner.clone();
            std::thread::spawn(move || {
                #[cfg(windows)]
                unsafe {
                    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
                    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                }
                let (lock, cvar) = &*inner;
                loop {
                    let (path, size, responder) = {
                        let mut q = lock.lock().unwrap();
                        while q.is_empty() {
                            q = cvar.wait(q).unwrap();
                        }
                        q.pop().unwrap()
                    };
                    responder.respond(render(&path, size));
                }
            });
        }
        Pool { inner }
    }

    /// Handle `thumb://localhost/<percent-encoded path>?s=<px>`.
    pub fn submit(&self, req: Request<Vec<u8>>, responder: UriSchemeResponder) {
        let uri = req.uri();
        let path = percent_encoding::percent_decode_str(uri.path().trim_start_matches('/'))
            .decode_utf8_lossy()
            .to_string();
        let size = uri
            .query()
            .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("s=")))
            .and_then(|s| s.parse::<i32>().ok())
            .unwrap_or(256)
            .clamp(16, 1024);
        let (lock, cvar) = &*self.inner;
        lock.lock().unwrap().push((path, size, responder));
        cvar.notify_one();
    }
}

fn render(path: &str, size: i32) -> Response<Vec<u8>> {
    match thumbnail_png(path, size) {
        Some(png) => Response::builder()
            .header("Content-Type", "image/png")
            // URLs carry the file's modified time, so they're safe to cache forever.
            .header("Cache-Control", "max-age=31536000, immutable")
            .body(png)
            .unwrap(),
        None => Response::builder().status(404).body(Vec::new()).unwrap(),
    }
}

fn thumbnail_png(path: &str, size: i32) -> Option<Vec<u8>> {
    let (w, h, rgba) = shell_thumbnail(path, size)?;
    encode_png(w, h, &rgba)
}

/// PNG-encode straight RGBA pixels.
pub(crate) fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
    }
    Some(out)
}

#[cfg(windows)]
fn shell_thumbnail(path: &str, size: i32) -> Option<(u32, u32, Vec<u8>)> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_RESIZETOFIT,
        SIIGBF_THUMBNAILONLY,
    };

    unsafe {
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(path), None).ok()?;
        // THUMBNAILONLY: fail instead of returning a generic icon, so the UI
        // keeps its own icon for files without a real thumbnail.
        let hbmp = factory
            .GetImage(
                SIZE { cx: size, cy: size },
                SIIGBF_RESIZETOFIT | SIIGBF_THUMBNAILONLY,
            )
            .ok()?;
        let pixels = bitmap_rgba(hbmp);
        let _ = DeleteObject(HGDIOBJ(hbmp.0));
        pixels
    }
}

#[cfg(windows)]
pub(crate) unsafe fn bitmap_rgba(
    hbmp: windows::Win32::Graphics::Gdi::HBITMAP,
) -> Option<(u32, u32, Vec<u8>)> {
    use std::ffi::c_void;
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HGDIOBJ,
    };

    let mut bm = BITMAP::default();
    let got = GetObjectW(
        HGDIOBJ(hbmp.0),
        std::mem::size_of::<BITMAP>() as i32,
        Some(&mut bm as *mut _ as *mut c_void),
    );
    if got == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
        return None;
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight);

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // negative = top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let hdc = GetDC(None);
    let lines = GetDIBits(
        hdc,
        hbmp,
        0,
        h as u32,
        Some(buf.as_mut_ptr() as *mut c_void),
        &mut info,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, hdc);
    if lines == 0 {
        return None;
    }

    // BGRA (premultiplied) -> straight RGBA. Plain photos come back with an
    // all-zero alpha channel, which means "opaque".
    let has_alpha = buf.chunks_exact(4).any(|px| px[3] != 0);
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2);
        if !has_alpha {
            px[3] = 255;
        } else if px[3] != 0 && px[3] != 255 {
            let a = px[3] as u32;
            for c in &mut px[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    Some((w as u32, h as u32, buf))
}

#[cfg(not(windows))]
fn shell_thumbnail(_path: &str, _size: i32) -> Option<(u32, u32, Vec<u8>)> {
    None
}
