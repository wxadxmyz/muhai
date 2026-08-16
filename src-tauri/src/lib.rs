#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::Manager;

#[cfg(desktop)]
use tauri::tray::TrayIconBuilder;

// v2.3.0 统一 JS 沙箱引擎（影流/音流共用）
mod js_engine;

// 让 fetchsource 等命令参数上的 #[serde(default)] 可被编译器解析
use serde::Deserialize;

// P2 原生能力层：注册系统插件（对话框/文件系统/通知/自启/全局快捷键/更新），
// 并建立系统托盘。全局快捷键与更新检查由前端通过 @tauri-apps JS 插件调用，
// 此处只负责初始化插件与托盘菜单。
// 注意：托盘、全局快捷键、自启、菜单均为桌面端专属能力，安卓/iOS 下用
// cfg(desktop) 隔离，避免移动端 target 缺少对应 API 导致编译失败。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .setup(|app| {
                build_tray(app)?;
                Ok(())
            });
    }

    builder
        .invoke_handler(tauri::generate_handler![fetchsource, js_engine::run_spider])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// 方案C：由 Rust 后端代前端抓取外网 URL（含明文 http / 跨域源），
// 彻底绕开 WebView 前端的 CORS 与 Android 明文 HTTP 限制。
// 仅取文本并返回，解析逻辑仍在前端 sourceFetch 完成。
#[tauri::command]
async fn fetchsource(url: String, #[serde(default)] user_agent: Option<String>) -> Result<String, String> {
    // TVBox 生态（订阅/蜘蛛/jiemi 解密）普遍只对 okhttp UA 返回正常内容，
    // 浏览器型 UA 常被反爬返回 HTML 占位页。故默认 okhttp，调用方可覆盖。
    let ua = user_agent.unwrap_or_else(|| "okhttp/4.10.0".to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("User-Agent", ua)
        .header("Accept", "*/*")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("请求失败：HTTP {}", status));
    }
    Ok(text)
}

#[cfg(desktop)]
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &PredefinedMenuItem::separator(app)?, &quit])?;
    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "hide" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
