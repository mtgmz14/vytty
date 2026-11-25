//! Windows-only pieces: the WebView2 check, a message box for fatal errors,
//! process liveness for the updater hand-over, and the paths of files dropped
//! on the page (WebView2 hands them over for File objects the page posts with
//! chrome.webview.postMessageWithAdditionalObjects).
use crate::App;
use std::sync::Arc;
use tauri::WebviewWindow;
use vytty_core::events::Event;
use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2File, ICoreWebView2Settings3, ICoreWebView2WebMessageReceivedEventArgs2};
use windows::core::{Interface, HSTRING, PWSTR};

pub fn check_webview2() -> Result<(), String> {
    match tauri::webview_version() {
        Ok(_) => Ok(()),
        Err(_) => Err("Vytty needs the Microsoft Edge WebView2 Runtime. It is part of Windows 10 and 11, but it is missing or blocked on this computer.\n\n\
Install the Evergreen Runtime from https://developer.microsoft.com/microsoft-edge/webview2/ or ask your IT department."
            .into()),
    }
}

pub fn message_box(title: &str, text: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    unsafe {
        MessageBoxW(None, &HSTRING::from(text), &HSTRING::from(title), MB_OK | MB_ICONERROR);
    }
}

pub fn process_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
    unsafe {
        match OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            Ok(h) => {
                let r = WaitForSingleObject(h, 0);
                let _ = CloseHandle(h);
                r == WAIT_TIMEOUT
            }
            Err(_) => false,
        }
    }
}

/// Answers "vytty-files:<req>" messages with the paths of the posted files,
/// and turns off what WebView2 adds as a browser: F5 / Ctrl+R (a reload would
/// drop every connection), Ctrl+P, its find bar and its context menu.
pub fn install_file_path_bridge(window: &WebviewWindow, st: Arc<App>) {
    let _ = window.with_webview(move |wv| unsafe {
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        if let Ok(settings) = core.Settings() {
            let _ = settings.SetAreDefaultContextMenusEnabled(false);
            if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
        let st = st.clone();
        let handler = webview2_com::WebMessageReceivedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut raw = PWSTR::null();
            if args.TryGetWebMessageAsString(&mut raw).is_err() {
                return Ok(());
            }
            let msg = webview2_com::take_pwstr(raw);
            let Some(req) = msg.strip_prefix("vytty-files:") else { return Ok(()) };
            let mut paths = vec![];
            if let Ok(args2) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>() {
                if let Ok(objects) = args2.AdditionalObjects() {
                    let mut count = 0u32;
                    let _ = objects.Count(&mut count);
                    for i in 0..count {
                        let Ok(obj) = objects.GetValueAtIndex(i) else { continue };
                        let Ok(file) = obj.cast::<ICoreWebView2File>() else { continue };
                        let mut p = PWSTR::null();
                        if file.Path(&mut p).is_ok() {
                            paths.push(webview2_com::take_pwstr(p));
                        }
                    }
                }
            }
            st.emit(Event::FilePaths { req: req.to_string(), paths });
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_WebMessageReceived(&handler, &mut token);
    });
}
