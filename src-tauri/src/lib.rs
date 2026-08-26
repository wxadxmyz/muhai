#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::Manager;

#[cfg(desktop)]
use tauri::tray::TrayIconBuilder;

// v2.3.0 统一 JS 沙箱引擎（幕海/律云共用）
mod js_engine;

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

#[tauri::command]
async fn clear_webview_cache(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        // 清 WebView 全部浏览数据（HTTP 缓存 / 本地存储 / 应用缓存等），
        // 使下次加载强制重新拉取 APK 内打包的最新前端资源。
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            let _ = w.clear_all_browsing_data();
        }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            let _ = w.eval("try{localStorage.clear();sessionStorage.clear();}catch(e){}");
        }
    }
    Ok(())
}

    builder
        .invoke_handler(tauri::generate_handler![
            fetchsource,
            fetchimage,
            spiderrun,
            dlnascan,
            castvideo,
            clear_webview_cache
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ─────────────────────────────────────────────────────────────
// 投屏（DLNA / SSDP）
// 直播播放器调用 discover_dlna 扫描局域网 DLNA 设备，再用 cast_video
// 把当前播放 URL 推送到选中设备。电视/盒子需支持 DLNA 接收（如大多数
// 智能电视、小米盒子、当贝等）。发现失败则前端 fallback 到系统分享。
// ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
struct DlnaDevice {
    name: String,
    location: String,
    #[serde(rename = "controlUrl")]
    control_url: String,
}

const SSDP_ADDR: &str = "239.255.255.250:1900";
const SSDP_MSG: &str = "M-SEARCH * HTTP/1.1\r\n\
HOST: 239.255.255.250:1900\r\n\
MAN: \"ssdp:discover\"\r\n\
MX: 3\r\n\
ST: urn:schemas-upnp-org:service:AVTransport:1\r\n\r\n";

/// 扫描局域网 DLNA 设备（AVTransport 服务）。timeout_ms 默认 4000。
#[tauri::command]
async fn dlnascan(timeout_ms: Option<u64>) -> Result<Vec<DlnaDevice>, String> {
    use tokio::net::UdpSocket;
    use tokio::time::Duration;

    let to = Duration::from_millis(timeout_ms.unwrap_or(4000));
    let socket = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| e.to_string())?;
    socket
        .set_broadcast(true)
        .map_err(|e| e.to_string())?;
    socket
        .send_to(SSDP_MSG.as_bytes(), SSDP_ADDR)
        .await
        .map_err(|e| e.to_string())?;

    let mut buf = [0u8; 4096];
    let mut locations: Vec<String> = Vec::new();
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    loop {
        if start.elapsed() >= to {
            break;
        }
        match tokio::time::timeout(Duration::from_millis(500), socket.recv_from(&mut buf)).await {
            Ok(Ok((n, _))) => {
                let text = String::from_utf8_lossy(&buf[..n]);
                if let Some(loc) = text.lines().find_map(|l| {
                    let l = l.trim();
                    if l.to_lowercase().starts_with("location:") {
                        Some(l[8..].trim().to_string())
                    } else {
                        None
                    }
                }) {
                    if !locations.contains(&loc) {
                        locations.push(loc);
                    }
                }
            }
            _ => continue,
        }
    }

    // 取设备描述 XML，解析 friendlyName + AVTransport 控制 URL
    let mut devices: Vec<DlnaDevice> = Vec::new();
    for loc in locations {
        if let Ok(resp) = client.get(&loc).send().await {
            if let Ok(xml) = resp.text().await {
                if let Some((name, ctrl)) = parse_dlna(xml, &loc) {
                    devices.push(DlnaDevice {
                        name,
                        location: loc,
                        control_url: ctrl,
                    });
                }
            }
        }
    }
    Ok(devices)
}

/// 解析设备描述 XML，提取 friendlyName 与 AVTransport 服务的 controlURL（绝对化）。
fn parse_dlna(xml: String, location: &str) -> Option<(String, String)> {
    use quick_xml::events::Event;
    use quick_xml::reader::Reader;

    let mut reader = Reader::from_str(&xml);
    let mut buf = Vec::new();
    let mut friendly = String::new();
    let mut in_avt = false;
    let mut ctrl_rel = String::new();
    let mut name = String::new();
    let mut ctrl = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                if tag == "friendlyname" {
                    name = "friendlyname".into();
                } else if tag == "avtransport" {
                    in_avt = true;
                } else if tag == "servicetype" && in_avt {
                    name = "servicetype".into();
                } else if tag == "controlurl" {
                    name = "controlurl".into();
                }
            }
            Ok(Event::Text(t)) => {
                let v = t.unescape().unwrap_or_default().to_string();
                match name.as_str() {
                    "friendlyname" => friendly = v,
                    "servicetype" => {
                        if v.to_lowercase().contains("avtransport") {
                            in_avt = true;
                        }
                    }
                    "controlurl" => {
                        if in_avt {
                            ctrl_rel = v;
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_lowercase();
                // 一个 <service> 结束就重置 avtransport 上下文，避免误捕获后续 service
                if tag == "service" {
                    in_avt = false;
                }
                name.clear();
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    if ctrl_rel.is_empty() {
        return None;
    }
    // 把相对 controlURL 绝对化（用 location 的 origin 拼接）
    let ctrl = if url::Url::parse(&ctrl_rel).map(|u| u.has_host()).unwrap_or(false) {
        ctrl_rel.clone()
    } else if let Ok(base) = url::Url::parse(&location) {
        match base.join(&ctrl_rel) {
            Ok(joined) => joined.to_string(),
            Err(_) => ctrl_rel.clone(),
        }
    } else {
        ctrl_rel.clone()
    };
    Some((friendly, ctrl))
}

/// 把视频 URL 推送到指定 DLNA 设备的 AVTransport 服务（SOAP SetAVTransportURI）。
#[tauri::command]
async fn castvideo(location: String, video_url: String) -> Result<String, String> {
    use tokio::time::Duration;

    // 重新解析设备描述拿到 controlURL（location 为发现时返回的 XML 地址）
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let xml = client
        .get(&location)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let (_name, ctrl) = parse_dlna(xml, &location).ok_or("无法解析设备控制地址")?;

    let metadata = format!(
        r#"<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-upnp-org:rest:2006/05#" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="0" parentID="-1" restricted="0"><upnp:class>object.item.videoItem</upnp:class><res protocolInfo="http-get:*:video/mp4:*">{url}</res><dc:title>Live</dc:title></item></DIDL-Lite>"#,
        url = video_url
    );
    let body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
<InstanceID>0</InstanceID>
<CurrentURI>{uri}</CurrentURI>
<CurrentURIMetaData>{meta}</CurrentURIMetaData>
</u:SetAVTransportURI>
</s:Body>
</s:Envelope>"#,
        uri = video_url,
        meta = quick_xml::escape::escape(&metadata)
    );

    let resp = client
        .post(&ctrl)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header(
            "SOAPAction",
            "\"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI\"",
        )
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if status.is_success() {
        Ok("投屏已发送".into())
    } else {
        Err(format!("投屏失败：HTTP {}", status))
    }
}

// spider 引擎命令（顶层暴露，供前端 js.ts invoke('spiderrun') 调用）。
// 实际逻辑在 js_engine::spiderrun（QuickJS 沙箱执行），此处仅作顶层命令封装，
// 以满足 Tauri v2 ACL 对应用自定义命令的权限标识要求。
#[tauri::command]
async fn spiderrun(payload: js_engine::SpiderCall) -> Result<String, String> {
    js_engine::spiderrun(payload)
}

// 方案C：由 Rust 后端代前端抓取外网 URL（含明文 http / 跨域源），
// 彻底绕开 WebView 前端的 CORS 与 Android 明文 HTTP 限制。
// 仅取文本并返回，解析逻辑仍在前端 sourceFetch 完成。
// UA 固定 okhttp：TVBox 生态（订阅/蜘蛛/jiemi 解密）普遍只对 okhttp UA 返回
// 真实内容，浏览器型 UA 会被反爬返回 HTML 占位页。调用方（TVBox 源/解密）
// 一律需要 okhttp，故无需在命令参数上暴露可覆盖项（避免 serde 属性作用域问题）。
#[tauri::command]
async fn fetchsource(url: String) -> Result<String, String> {
    let ua = "okhttp/4.10.0";
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
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

// v2.7.0 图片代理：CMS 源（如量子）图床对 webview 的 Chrome UA 可能拒防盗链，
// 用 okhttp UA 拉图后返 base64 dataURL，前端 <img> 直接用 dataURL 显示，绕过
// webview CORS/防盗链/UA 检测。
#[tauri::command]
async fn fetchimage(url: String) -> Result<String, String> {
    use base64::Engine;
    let ua = "okhttp/4.10.0";
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("User-Agent", ua)
        .header("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
        .header("Referer", "https://cj.lziapi.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("图片请求失败：HTTP {}", status));
    }
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", ct, b64))
}

#[cfg(desktop)]
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏到托盘", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
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
