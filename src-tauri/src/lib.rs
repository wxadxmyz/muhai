#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::Manager;

#[cfg(desktop)]
use tauri::tray::TrayIconBuilder;

// v2.3.0 统一 JS 沙箱引擎（幕海/律云共用）
mod js_engine;
// V3.6.0 drpy3 / drpy2 蜘蛛源引擎（影视仓生态的 JS 规则源）
mod drpy3;
// V3.6.8：本地流式媒体代理的运行时诊断（真机排障用，环形缓冲 + 累计计数）
mod probe;

// V3.3.1 #5：全局复用的 HTTP 客户端（连接池）。
// 旧实现里 fetchsource / fetchimage 每次调用都 Client::builder().build() 新建一个客户端，
// 客户端不复用 = 连接池不复用 = 每个请求都要重走 DNS + TCP + TLS 握手。首页二十多张封面
// 就是二十多次完整握手，点详情、解析播放地址又各来一轮，是"点什么都慢"的主因之一。
// 这里改成进程内单例：连接常驻复用，超时改为按请求单独设置（各自业务需要不同时长）。
use std::sync::OnceLock;

// V3.6.5：本地流式媒体代理所需依赖（根治播放卡顿/转圈，替代 fetchmedia 的 base64 全量过桥）
use std::convert::Infallible;
use std::net::TcpListener as StdTcpListener;
use bytes::Bytes;
use futures_util::StreamExt;
use http_body::Frame;
use http_body_util::{BodyExt, Empty, Full, StreamBody};
use http_body_util::combinators::BoxBody;
use hyper::service::service_fn;
use hyper::body::Incoming;
use hyper::{Method, Request, Response};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener as TokioTcpListener;

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // 空闲连接保留 90s，单 host 最多 8 条，够首页一屏封面并发复用
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .pool_max_idle_per_host(8)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

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
        .invoke_handler(tauri::generate_handler![
            fetchsource,
            fetchimage,
            fetchmedia,
            media_proxy_port,
            // V3.6.8：媒体代理运行时诊断（真机排障，设置 → 开发者调试）
            proxy_probe_snapshot,
            proxy_probe_clear,
            proxy_probe_set_recording,
            spiderrun,
            drpy3run,
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
    // V3.3.5 B1：QuickJS 执行是 CPU 密集的同步代码，直接在 async 上下文里跑会占死
    // tokio worker 线程——多源聚合搜索期间其它 invoke（fetchimage/fetchsource）全部排队卡顿。
    // 用 spawn_blocking 把 JS 执行挪到专用阻塞线程池，异步线程池保持畅通。
    let result = tokio::task::spawn_blocking(move || js_engine::spiderrun(payload))
        .await
        .map_err(|e| format!("spider 执行线程异常：{}", e))?;
    result
}

// V3.6.0 drpy3 引擎命令（前端 js.ts 对 drpy2/drpy3 规则源走这一路）。
// 与 spiderrun 同构：QuickJS 是同步 CPU 密集执行，必须挪到阻塞线程池，
// 否则多源聚合搜索期间会占死 tokio worker，其它 invoke 全部排队卡顿。
#[tauri::command]
async fn drpy3run(payload: drpy3::Drpy3Call) -> Result<String, String> {
    tokio::task::spawn_blocking(move || drpy3::drpy3run(payload))
        .await
        .map_err(|e| format!("drpy3 执行线程异常：{}", e))?
}

// 方案C：由 Rust 后端代前端抓取外网 URL（含明文 http / 跨域源），
// 彻底绕开 WebView 前端的 CORS 与 Android 明文 HTTP 限制。
// 仅取文本并返回，解析逻辑仍在前端 sourceFetch 完成。
// UA 固定 okhttp：TVBox 生态（订阅/蜘蛛/jiemi 解密）普遍只对 okhttp UA 返回
// 真实内容，浏览器型 UA 会被反爬返回 HTML 占位页。调用方（TVBox 源/解密）
// 一律需要 okhttp，故无需在命令参数上暴露可覆盖项（避免 serde 属性作用域问题）。
// V3.3.5 B3：把 reqwest 底层错误翻译成用户可读的中文分类文案（附一行可操作建议），
// 不再让英文技术串（"error sending request for url (...)"）直接露给用户。
fn friendly_net_err(e: reqwest::Error) -> String {
    let s = e.to_string();
    if e.is_timeout() {
        "连接超时：源服务器长时间没有响应，请检查网络后重试，或更换其它源".into()
    } else if e.is_connect() {
        if s.contains("dns") || s.contains("lookup") || s.contains("resolve") {
            "域名解析失败：源地址可能已失效，请检查源地址或在设置里更换源".into()
        } else {
            "无法连接到源服务器：请检查网络是否可用、源地址是否正确".into()
        }
    } else {
        format!("网络请求失败：{}", s)
    }
}

#[tauri::command]
async fn fetchsource(url: String) -> Result<String, String> {
    let ua = "okhttp/4.10.0";
    let resp = http_client()
        .get(&url)
        .timeout(std::time::Duration::from_secs(30))
        .header("User-Agent", ua)
        .header("Accept", "*/*")
        .send()
        .await
        .map_err(friendly_net_err)?;
    let status = resp.status();
    // V3.3.5 B3：读响应体失败也给人话（旧版直接透传 reqwest 英文串）
    let text = resp
        .text()
        .await
        .map_err(|_| "读取源响应失败：连接中途断开，请重试".to_string())?;
    if !status.is_success() {
        // V3.3.5 B3：HTTP 错误带分类提示（404=地址失效，5xx=源服务器故障）
        let hint = if status.as_u16() == 404 {
            "源地址不存在或已下线"
        } else if status.is_server_error() {
            "源服务器故障，稍后重试或换源"
        } else {
            "源拒绝了本次请求"
        };
        return Err(format!("源返回错误：HTTP {}（{}）", status, hint));
    }
    Ok(text)
}

// V3.4.9：直播拉流后端代理。HLS.js 自定义 Loader 调用本命令拉 m3u8 / ts 分片。
// 既能带上频道自定义头（如 CCTV 源要求的 User-Agent: AptvPlayer-UA），
// 又不受 WebView 的 CORS 限制（WebView 的 JS fetch 对无 CORS 头的服务器会被拦 → 黑屏）。
// 返回 JSON：{ "data": base64(二进制), "url": 最终跳转后的 URL }。
// —— 后者用于 HLS.js 以最终 URL 为 base 解析 master playlist 里的相对路径 variant
//    （如 CCTV1 的 live.php 302 到 migu 后，variant 是相对路径 `01.m3u8?...`）。
#[tauri::command]
async fn fetchmedia(url: String, headers: Option<std::collections::HashMap<String, String>>) -> Result<String, String> {
    use base64::Engine;
    let mut req = http_client()
        .get(&url)
        .timeout(std::time::Duration::from_secs(30));
    let mut has_ua = false;
    if let Some(hs) = &headers {
        for (k, v) in hs {
            if k.eq_ignore_ascii_case("user-agent") {
                has_ua = true;
            }
            req = req.header(k.as_str(), v.as_str());
        }
    }
    if !has_ua {
        // 默认兜底 UA（与 fetchsource 一致），避免部分源对空 UA 拒连
        req = req.header("User-Agent", "okhttp/4.10.0");
    }
    req = req.header("Accept", "*/*");
    let resp = req.send().await.map_err(friendly_net_err)?;
    let status = resp.status();
    if !status.is_success() {
        let hint = if status.as_u16() == 404 {
            "源地址不存在或已下线"
        } else if status.is_server_error() {
            "源服务器故障，稍后重试或换源"
        } else {
            "源拒绝了本次请求"
        };
        return Err(format!("源返回错误：HTTP {}（{}）", status, hint));
    }
    // reqwest 默认跟随重定向（最多 10 次），resp.url() 即最终 URL（master 相对 variant 靠它解析）
    let final_url = resp.url().to_string();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(serde_json::json!({ "data": b64, "url": final_url }).to_string())
}

// ─────────────────────────────────────────────────────────────
// V3.6.5：本地流式媒体代理（根治播放卡顿 / 转圈）
// ─────────────────────────────────────────────────────────────
// 旧 fetchmedia 把整段响应（m3u8 主/子清单、ts 分片、甚至 mp4 直链）完整读进内存、base64
// 编码、再整段 JSON 回传前端，前端再 atob 解码交给 hls.js。HLS 每播一个分片都走一遍这个完整
// 往返，hls.js 没法高效预取。表现：master playlist 到了但首片迟迟不回 → loadedmetadata 不触发 →
// 画面一直转圈；苹果源高码率分片（1~4MB）播完缓冲里那 2 秒、下一片还在过桥 → 「播 2 秒卡好久」。
//
// 新方案：在 127.0.0.1 临时端口起一个轻量 HTTP server，承接 WebView 的媒体请求，向真实源
// 「流式」拉取并直接 pipe 回 <video>/hls.js，支持 HTTP Range（mp4 拖动 / 分片续传）。
// 这样 hls.js 可边下边播、正常预取；mp4 支持 range seek；防盗链头照样能带。

static PROXY_PORT: OnceLock<u16> = OnceLock::new();

/// 返回本地流式代理监听端口（首次调用时启动 server）。前端拿到端口后把所有媒体 URL 改写为
/// `http://127.0.0.1:<port>/proxy?url=<真实地址>&referer=&ua=` 再交给 <video>/hls.js。
#[tauri::command]
fn media_proxy_port() -> u16 {
    *PROXY_PORT.get_or_init(|| {
        let listener = StdTcpListener::bind("127.0.0.1:0").expect("bind media proxy port");
        listener.set_nonblocking(true).ok();
        let port = listener.local_addr().unwrap().port();
        tauri::async_runtime::spawn(serve_proxy(listener));
        port
    })
}

async fn serve_proxy(std_listener: StdTcpListener) {
    let listener = match TokioTcpListener::from_std(std_listener) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("media proxy listener init failed: {e}");
            return;
        }
    };
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let io = TokioIo::new(stream);
                tokio::spawn(async move {
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, service_fn(proxy_handler))
                        .await;
                });
            }
            // V3.6.7 修复：原来这里是 break —— 单次 accept 错误（客户端刚连上就断开、
            // 连接数瞬时打满等）会让整个代理循环退出，而 PROXY_PORT 是 OnceLock 不会重置，
            // 前端继续拿这个死端口请求 → 表现为「一直转圈」且无法自愈。
            // 改为：短暂退避后继续循环。EMFILE（句柄耗尽）退避久一点，给系统回收时间。
            Err(e) => {
                let backoff = if e.raw_os_error() == Some(24) {
                    // EMFILE: Too many open files
                    std::time::Duration::from_millis(500)
                } else {
                    std::time::Duration::from_millis(50)
                };
                eprintln!("media proxy: accept 失败({e})，{backoff:?} 后继续");
                tokio::time::sleep(backoff).await;
            }
        }
    }
}

// 代理统一响应体类型：流式 / 空 / 小文本都用 BoxBody 统一，便于函数返回单一类型
type ProxyBody = BoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;

fn empty_proxy_body() -> ProxyBody {
    Empty::<Bytes>::new()
        .map_err(|e: Infallible| -> Box<dyn std::error::Error + Send + Sync> { e.into() })
        .boxed()
}
fn text_proxy_body(s: String) -> ProxyBody {
    Full::new(Bytes::from(s))
        .map_err(|e: Infallible| -> Box<dyn std::error::Error + Send + Sync> { e.into() })
        .boxed()
}
fn full_proxy_body(b: Bytes) -> ProxyBody {
    Full::new(b)
        .map_err(|e: Infallible| -> Box<dyn std::error::Error + Send + Sync> { e.into() })
        .boxed()
}

/// V3.6.6 A2：把 m3u8 文本里的**相对路径**补全为上游绝对地址。
///
/// 需要处理两类：
///   1. 标签属性里的 URI —— `#EXT-X-KEY:...URI="enc.key"`、`#EXT-X-MAP:URI="init.mp4"`
///   2. 纯路径行 —— 分片地址（ts/m4s/aac 等），以及 master playlist 的变体地址
///
/// base 取「跟随重定向后的最终 URL」，保证 `new URL(rel, base)` 的目录语义正确
/// （如 base = `https://h/play/xxx/index.m3u8` → `enc.key` 解析为 `https://h/play/xxx/enc.key`）。
/// 已经是绝对地址（http/https）或 data:/blob: 的保持不变。
fn rewrite_m3u8_paths(text: &str, base: &str) -> String {
    // 手工按 base 的目录部分拼接，避免依赖额外 crate；query/锚点保留
    let base_dir = match base.rfind('/') {
        Some(i) => &base[..=i],
        None => base,
    };
    let absolutize = |rel: &str| -> String {
        let r = rel.trim();
        if r.is_empty()
            || r.starts_with("http://")
            || r.starts_with("https://")
            || r.starts_with("data:")
            || r.starts_with("blob:")
            || r.starts_with("//")
        {
            return rel.to_string(); // 绝对地址 / 协议相对 / 内联数据，原样返回
        }
        if let Some(stripped) = r.strip_prefix('/') {
            // 站点绝对路径：接在 scheme://host 之后
            if let Some(scheme_end) = base.find("://") {
                let host_end = base[scheme_end + 3..]
                    .find('/')
                    .map(|i| scheme_end + 3 + i)
                    .unwrap_or(base.len());
                return format!("{}/{}", &base[..host_end], stripped);
            }
        }
        format!("{}{}", base_dir, r)
    };

    let mut out = String::with_capacity(text.len() + 64);
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        let newline = &line[trimmed.len()..];
        let t = trimmed.trim_start();
        // 1) 标签里的 URI="..."
        if t.starts_with('#') {
            if let Some(pos) = t.find("URI=\"") {
                let head = &t[..pos + 5];
                let rest = &t[pos + 5..];
                if let Some(end) = rest.find('"') {
                    let rel = &rest[..end];
                    let abs = absolutize(rel);
                    out.push_str(head);
                    out.push_str(&abs);
                    out.push_str(&rest[end..]);
                    out.push_str(newline);
                    continue;
                }
            }
            // 其它注释行原样保留
            out.push_str(trimmed);
            out.push_str(newline);
            continue;
        }
        // 2) 纯路径行（跳过空行）
        if t.is_empty() {
            out.push_str(trimmed);
            out.push_str(newline);
            continue;
        }
        // 保留缩进，只替换路径本体
        let indent_len = trimmed.len() - t.len();
        out.push_str(&trimmed[..indent_len]);
        out.push_str(&absolutize(t));
        out.push_str(newline);
    }
    out
}

/// V3.6.7：Range 请求归一化判定。
///
/// hls.js 在请求 HLS 分片前会发 `Range: bytes=0-0` 探测可寻址性，部分 CDN 会如实返回
/// 1 字节。该探测请求**不能**原样透传，否则 hls.js 拿到 1 字节 TS 直接解析失败。
///
/// 策略：
///   · `bytes=N-`（开放区间）          → 透传（mp4 拖动 / 断点续传）
///   · `bytes=N-M` 且 M-N+1 >= 1KB     → 透传（真实分片预取，hls.js 默认 64KB 起）
///   · 其余（bytes=0-0、bytes=100-200、多区间、非法格式）→ 丢弃，让上游回完整资源
fn should_forward_range(raw: &str) -> bool {
    /// 小于该字节数的窗口视为「探测请求」。真实分片预取远大于 1KB，不会误伤。
    const PREFETCH_MIN: u64 = 1024;

    let Some(spec) = raw.trim().strip_prefix("bytes=") else {
        return false;
    };
    // 多区间（bytes=0-1,5-6）一律不透传，规避上游 416 / 实现差异
    if spec.contains(',') {
        return false;
    }
    let Some((s, e)) = spec.split_once('-') else {
        return false;
    };
    let Ok(start) = s.trim().parse::<u64>() else {
        return false;
    };
    let end_str = e.trim();
    if end_str.is_empty() {
        return true; // bytes=N- 开放区间
    }
    let Ok(end) = end_str.parse::<u64>() else {
        return false;
    };
    end >= start && end - start + 1 >= PREFETCH_MIN
}

async fn proxy_handler(req: Request<Incoming>) -> Result<Response<ProxyBody>, Infallible> {
    // V3.6.8：诊断信息从请求头里先取出来（req 后续会被 builder.send() 消费掉）。
    // 注：hyper 1.x 的 service_fn 拿不到 TCP peer 地址（需要自定义 MakeService 注入），
    // 而「WebView 有没有连上代理」已由 probe 的累计计数 TOTAL 回答，故此处不再尝试取 client IP。
    let probe_method = req.method().to_string();

    // url 只来自 query（App 自己拼），避免外部注入任意目标
    let q = req.uri().query().unwrap_or("");
    let params: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(q.as_bytes()).into_owned().collect();
    let target = match params.get("url") {
        Some(u) if !u.is_empty() => u.clone(),
        _ => {
            probe::record(probe::ProxyEvent {
                seq: 0,
                ts: 0,
                url: String::new(),
                method: probe_method.clone(),
                client: String::new(),
                status: 400,
                range: String::new(),
                fwd_range: String::new(),
                body_len: 0,
                m3u8: false,
                note: "缺少 url 参数".into(),
            });
            return Ok(Response::builder().status(400).body(empty_proxy_body()).unwrap());
        }
    };
    if !(target.starts_with("http://") || target.starts_with("https://")) {
        probe::record(probe::ProxyEvent {
            seq: 0,
            ts: 0,
            url: probe::truncate_url(&target),
            method: probe_method.clone(),
            client: String::new(),
            status: 400,
            range: String::new(),
            fwd_range: String::new(),
            body_len: 0,
            m3u8: false,
            note: "目标非 http(s)".into(),
        });
        return Ok(Response::builder().status(400).body(empty_proxy_body()).unwrap());
    }

    // 预检：放开跨域（部分 WebView / Safari 会先发 OPTIONS）
    if req.method() == Method::OPTIONS {
        probe::record(probe::ProxyEvent {
            seq: 0,
            ts: 0,
            url: probe::truncate_url(&target),
            method: "OPTIONS".into(),
            client: String::new(),
            status: 204,
            range: String::new(),
            fwd_range: String::new(),
            body_len: 0,
            m3u8: false,
            note: "CORS 预检".into(),
        });
        return Ok(Response::builder()
            .status(204)
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            .header("Access-Control-Allow-Headers", "*")
            .body(empty_proxy_body())
            .unwrap());
    }

    // V3.6.5：透传 Range（hls.js 分片预取 / mp4 拖动），并带上防盗链头
    // V3.6.7 修复：Range 必须先归一化，否则 hls.js 的长度探测请求会把播放打死。
    //   hls.js 对每个 HLS 分片会先发 `Range: bytes=0-0` 探测可寻址性；原样透传后上游
    //   只回 1 字节，hls.js 拿这 1 字节去解 TS → fragParsingError → 反复重试 → 用户看到
    //   「一直转圈」。V3.6.4 走 invoke('fetchmedia') 不带 Range，所以没这个问题。
    //
    // V3.6.8 诊断：同时记录「原始 Range」与「实际转发 Range」。若真机上看到
    //   range=bytes=0-0 而 fwd_range 为空，说明归一化生效（这是预期）；若 range 为空
    //   而 body_len 仍为 1，那才是真的上游/端侧问题——两类症状必须能区分开。
    let mut builder = http_client().get(&target);
    let req_range = req
        .headers()
        .get(hyper::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let mut fwd_range = String::new();
    if let Some(rg) = req.headers().get(hyper::header::RANGE).cloned() {
        let rg_str = rg.to_str().unwrap_or("");
        if should_forward_range(rg_str) {
            fwd_range = rg_str.to_string();
            builder = builder.header(hyper::header::RANGE, rg);
        } else {
            probe::note_range_dropped();
            eprintln!("media proxy: 丢弃探测 Range {rg_str:?}，改取完整资源");
        }
    } else if let Some(rg) = params.get("range") {
        if !rg.is_empty() && should_forward_range(rg) {
            fwd_range = rg.clone();
            builder = builder.header(hyper::header::RANGE, rg.clone());
        } else if !rg.is_empty() {
            probe::note_range_dropped();
            eprintln!("media proxy: 丢弃探测 query range {rg}，改取完整资源");
        }
    }
    if let Some(r) = params.get("referer") {
        if !r.is_empty() {
            builder = builder.header("Referer", r.as_str());
        }
    }
    if let Some(ua) = params.get("ua") {
        if !ua.is_empty() {
            builder = builder.header("User-Agent", ua.as_str());
        }
    } else {
        builder = builder.header("User-Agent", "okhttp/4.10.0");
    }
    builder = builder.header("Accept", "*/*");

    // 诊断事件模板：上面已解析完所需字段，这里只等 status / body_len 补齐后落盘。
    let mk_event = |status: u16, body_len: i64, m3u8: bool, note: String| probe::ProxyEvent {
        seq: 0,
        ts: 0,
        url: probe::truncate_url(&target),
        method: probe_method.clone(),
        client: String::new(),
        status,
        range: req_range.clone(),
        fwd_range: fwd_range.clone(),
        body_len,
        m3u8,
        note,
    };

    let resp = match builder.timeout(std::time::Duration::from_secs(300)).send().await {
        Ok(r) => r,
        Err(e) => {
            probe::record(mk_event(502, 0, false, format!("上游请求失败：{e}")));
            return Ok(Response::builder()
                .status(502)
                .header("Access-Control-Allow-Origin", "*")
                .body(text_proxy_body(format!("代理上游请求失败：{}", e)))
                .unwrap());
        }
    };
    let status = resp.status();
    let upstream = resp.headers().clone();
    // bytes_stream 会 move 掉 resp，先把需要的最终 URL 取出来（跟随重定向后的真实地址）
    let final_url = resp.url().to_string();

    // ── V3.6.6 A2：m3u8 相对路径重写 ──────────────────────────────────────────
    // 根因：分享页源（豪华/红牛/光速…）的 m3u8 里密钥是相对路径 `URI="enc.key"`，
    // hls.js 会以「它拿到的 m3u8 URL」为基准解析。但该 URL 已被本代理改写成
    // `http://127.0.0.1:<port>/proxy?url=...`，于是相对路径被拼成不存在的本地地址
    // → 密钥 404 → AES 解密失败 → 画面永远不出。
    // 解决：代理是唯一同时知道「原始 URL」与「改写后 URL」的一方，在此把 m3u8 内
    // 相对路径统一补全为上游绝对地址，再回传（m3u8 仅 KB 级，不影响流式收益）。
    let ctype = upstream
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let looks_m3u8 = ctype.contains("mpegurl")
        || ctype.contains("x-mpegurl")
        || final_url.contains(".m3u8")
        || target.contains(".m3u8");

    if looks_m3u8 {
        // m3u8 体积小（几 KB ~ 几十 KB），整体读入做文本重写是可接受的
        match resp.text().await {
            Ok(text) => {
                let rewritten = rewrite_m3u8_paths(&text, &final_url);
                let body_bytes = Bytes::from(rewritten);
                // V3.6.8 诊断：记下重写后的清单大小。若清单是 0 字节或只有几十字节，
                // 说明上游返回了空/占位清单（防盗链/签名过期），而不是播放器的锅。
                probe::record(mk_event(
                    status.as_u16(),
                    body_bytes.len() as i64,
                    true,
                    format!("m3u8 重写 {}({} 字节)", final_url, body_bytes.len()),
                ));
                let mut rb = Response::builder().status(status);
                // 不沿用上游 content-length（文本长度已变，用错会截断/挂起）
                rb = rb
                    .header("Content-Type", "application/vnd.apple.mpegurl")
                    .header("Content-Length", body_bytes.len().to_string())
                    .header("Accept-Ranges", "bytes")
                    .header("X-Proxy-Final-Url", final_url)
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                    .header("Access-Control-Allow-Headers", "*");
                return Ok(rb.body(full_proxy_body(body_bytes)).unwrap());
            }
            Err(e) => {
                // 读取失败：无法回退到流式（resp 已被 text() 消费），如实返回 502 供前端提示
                eprintln!("m3u8 rewrite: read body failed: {e}");
                probe::record(mk_event(502, 0, true, format!("m3u8 读取失败：{e}")));
                return Ok(Response::builder()
                    .status(502)
                    .header("Access-Control-Allow-Origin", "*")
                    .body(text_proxy_body(format!("m3u8 读取失败：{}", e)))
                    .unwrap());
            }
        }
    }

    // 流式转发：不再把整段响应读进内存 + base64，直接把上游字节流逐帧 pipe 回 WebView
    let stream = resp.bytes_stream();
    let framed = stream.map(|res| {
        res
            .map(|b| Frame::<Bytes>::data(b))
            .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { e.to_string().into() })
    });
    let body: ProxyBody = BodyExt::boxed(StreamBody::new(framed));

    // V3.6.8 诊断：分片流式转发。content-length 是上游声明的完整大小（206 时为分片长度），
    // 记成负数表示「流式、长度以响应头为准」，与 m3u8 的正数长度区分开。
    let stream_len = upstream
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i64>().ok())
        .map(|n| -n)
        .unwrap_or(-1);
    probe::record(mk_event(
        status.as_u16(),
        stream_len,
        false,
        if stream_len < -1 {
            format!("分片流式转发（声明 {} 字节）", -stream_len)
        } else {
            "分片流式转发（无 content-length）".into()
        },
    ));

    let mut rb = Response::builder().status(status);
    // 透传关键响应头，保证 Range / 长度 / 类型正确（缺了 hls.js 会解析失败）
    for name in [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "cache-control",
        "etag",
        "last-modified",
    ] {
        if let Some(v) = upstream.get(name) {
            rb = rb.header(name, v);
        }
    }
    // 回传真实最终 URL（跟随重定向后的），供前端 hls.js 解析相对路径 variant
    rb = rb
        .header("X-Proxy-Final-Url", final_url)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Allow-Headers", "*");
    Ok(rb.body(body).unwrap())
}

// ─────────────────────────────────────────────────────────────
// V3.6.8：媒体代理运行时诊断命令
// ─────────────────────────────────────────────────────────────
// 真机排障用。三个命令都极轻量：snapshot 只拷最近 N 条 + 读几个原子计数，
// clear / set_recording 是 O(1)。前端「设置 → 开发者调试」调用它们，
// 把结果拼成可复制的文本报告，用户截图或粘贴给开发者即可定位播放链路断点。

/// 取最近 `limit` 条媒体代理事件（时间正序）+ 累计计数。
/// 返回 JSON 字符串，字段见 [`probe::ProxyEvent`] / [`probe::Counters`]。
#[tauri::command]
fn proxy_probe_snapshot(limit: Option<usize>) -> String {
    let n = limit.unwrap_or(200).min(probe::MAX_EVENTS);
    let (events, counters) = probe::snapshot(n);
    serde_json::json!({ "events": events, "counters": counters }).to_string()
}

/// 清空事件与计数器，便于「复现一次 → 抓一次」的干净对照。
#[tauri::command]
fn proxy_probe_clear() {
    probe::clear();
}

/// 开关事件记录（计数器始终保留）。
#[tauri::command]
fn proxy_probe_set_recording(on: bool) {
    probe::set_recording(on);
}

// 清除 WebView 全部浏览数据（HTTP 缓存 / 本地存储 / 应用缓存等）。
// 供前端"清除缓存 / 重置 APP"调用，使下次加载强制重新拉取 APK 内打包的最新前端资源，
// 根治"APK 升了但前端还是旧壳"的问题。
#[tauri::command]
async fn clear_webview_cache(_app: tauri::AppHandle) -> Result<(), String> {
    // v3.2.0 ⑪：改为 no-op。原先调 clear_all_browsing_data() 会清掉 WebView 全部数据，
    // 在部分 ROM 上导致 App 被系统回收（表现为"清完回到桌面"）。
    // 缓存清理改由前端负责（清 localStorage/sessionStorage/ProxiedImg 缓存），见 SettingsPage.clearCache。
    Ok(())
}

/// V3.3.7 七：由图片 URL 推出同域 Referer（scheme://host/）。
/// 多数图床的防盗链只校验 Referer 是否同域，用图片自己站点的根域最通用。
/// 解析失败时退回旧的固定值，保证行为不劣化。
fn image_referer(url: &str) -> String {
    let mut parts = url.splitn(2, "://");
    let scheme = parts.next().unwrap_or("https");
    if let Some(rest) = parts.next() {
        let host = rest.split('/').next().unwrap_or("").split('?').next().unwrap_or("");
        if !host.is_empty() {
            return format!("{}://{}/", scheme, host);
        }
    }
    "https://cj.lziapi.com/".to_string()
}

// v2.7.0 图片代理：CMS 源（如量子）图床对 webview 的 Chrome UA 可能拒防盗链，
// 用 okhttp UA 拉图后返 base64 dataURL，前端 <img> 直接用 dataURL 显示，绕过
// webview CORS/防盗链/UA 检测。
#[tauri::command]
async fn fetchimage(url: String) -> Result<String, String> {
    use base64::Engine;
    // V3.2.5 #4：豆瓣图床（*.doubanio.com）防盗链严格（Referer/UA 校验），
    // 用浏览器 UA + 豆瓣 Referer 才能取到图；其余源沿用 okhttp UA + lziapi Referer。
    let is_douban = url.contains("doubanio.com");
    // V3.3.1 Q2：超时 20s → 8s；V3.3.4：8s → 5s（实测正常封面 1-2s 内返回，
    // 5s 仍无响应的链路大概率已阻断，更早失败让位给 webview 原生加载与文字兜底）；
    // #5：客户端改用全局单例复用连接，超时按请求单独设置。
    let mut req = http_client().get(&url).timeout(std::time::Duration::from_secs(5));
    if is_douban {
        req = req
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            .header("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
            .header("Referer", "https://movie.douban.com/");
    } else {
        req = req
            .header("User-Agent", "okhttp/4.10.0")
            .header("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
            // V3.3.7 七：Referer 由「固定写死 cj.lziapi.com」改为「跟随图片自身域名」。
            // 根因：多数图床只校验 Referer 是否同域，跨域 Referer 一律 403 ——
            // 这正是 LZ 系等第三方图床「代理 + webview 原生两级加载都失败、只剩空白卡」的原因。
            .header("Referer", image_referer(&url));
    }
    let resp = req
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