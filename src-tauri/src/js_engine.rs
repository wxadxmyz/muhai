// v2.3.0 统一 JS 沙箱引擎（幕海/律云共用）
//
// 在 Rust 侧嵌入 QuickJS（rquickjs），执行用户源提供的 spider 脚本，
// 让 App 像影视仓/洛雪那样靠"脚本"驱动任意源（蜘蛛源/加密源/网上各种源）。
//
// 关键约束：脚本内的网络请求一律通过 `fetch` 桥接回 Rust 代理
// （reqwest::blocking），彻底绕开 WebView 的 CORS 与 Android 明文 HTTP 限制。
// 解密原语 base64/md5 由 Rust 注入；AES/RC4 等由加载器在脚本前拼接纯 JS 实现（见 E5）。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use md5::{Digest, Md5};
use rquickjs::{Context, Function, Object, Runtime};
use serde::Deserialize;
use std::time::Duration;

#[derive(Deserialize)]
pub struct SpiderCall {
    /// spider 脚本全文（定义 home/search/detail/play 等函数，或定义 `spider` 类）
    pub code: String,
    /// 要调用的函数名，如 "search" / "home" / "detail" / "play"
    pub func: String,
    /// 函数参数（JSON 值数组，引擎内 `const __args = [...]` 原样展开传入）。
    /// V3.8.0 由 Vec<String> 升级为 Vec<serde_json::Value>，以支持 catvod csp
    /// 方法需要的非字符串参数（如 searchContent(key, false) 的布尔、playerContent 的数组）。
    #[serde(default)]
    pub args: Vec<serde_json::Value>,
    /// TVBox csp 模型：站点代号（如 "csp_DoubanGuard"），传给 spider 构造器选路
    #[serde(default)]
    pub api: Option<String>,
    /// TVBox csp 模型：站点 ext 配置（字符串或对象皆可），传给 spider 构造器。
    /// 改为 serde_json::Value 以兼容对象型 ext（如 {"class":"电影"}），
    /// 否则 ext 为对象时 Option<String> 反序列化失败、整个 run_spider 抛错，
    /// 导致依赖 ext 的 drpy2/csp 站点（问题 #1/#2）全部返回空。
    #[serde(default)]
    pub ext: Option<serde_json::Value>,
    /// V3.8.0：csp 管理器远程地址（已去 `;md5;` 伪装段）。code 为空且本字段存在时，
    /// 由本端下载管理器（JS 或原生 DEX）+ md5 校验后再执行。
    #[serde(default)]
    pub spider_url: Option<String>,
    /// V3.8.0：csp 管理器 md5 校验值；非空时下载后严格校验完整性。
    #[serde(default)]
    pub spider_md5: Option<String>,
    /// V3.8.0：网盘 token（{ali,quark,uc}），注入引擎全局 `__netdiskTokens`，
    /// 供 csp 子蜘蛛取 4K 直链。引擎与 WebView 上下文隔离，必须显式传入。
    #[serde(default)]
    pub netdisk_tokens: Option<serde_json::Value>,
}

// ── V3.8.0：同步 HTTP 辅助（供 fetch 桥与 catvod `java` 宿主对象复用） ──
// 统一走 okhttp UA（TVBox/catvod 生态普遍只对 okhttp UA 返回真实内容），
// 超时 20s，headers 为可选 JSON 字符串（catvod 约定）。
fn http_get_text(url: &str, headers: Option<&str>) -> Result<String, rquickjs::Error> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| rquickjs::Error::new_into_js_message("http", "client", e.to_string()))?;
    let mut ua = "okhttp/4.10.0".to_string();
    let mut req = client.get(url);
    if let Some(h) = headers {
        if let Ok(map) = serde_json::from_str::<serde_json::Value>(h) {
            if let Some(obj) = map.as_object() {
                for (k, v) in obj {
                    if let Some(s) = v.as_str() {
                        if k.eq_ignore_ascii_case("user-agent") {
                            ua = s.to_string();
                        } else {
                            req = req.header(k, s);
                        }
                    }
                }
            }
        }
    }
    req = req.header("User-Agent", ua);
    let resp = req
        .send()
        .map_err(|e| rquickjs::Error::new_into_js_message("http", "response", e.to_string()))?;
    resp.text()
        .map_err(|e| rquickjs::Error::new_into_js_message("http", "body", e.to_string()))
}

fn http_post_text(url: &str, data: &str, headers: Option<&str>) -> Result<String, rquickjs::Error> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| rquickjs::Error::new_into_js_message("http", "client", e.to_string()))?;
    let mut ua = "okhttp/4.10.0".to_string();
    let mut req = client.post(url).body(data.to_string());
    if let Some(h) = headers {
        if let Ok(map) = serde_json::from_str::<serde_json::Value>(h) {
            if let Some(obj) = map.as_object() {
                for (k, v) in obj {
                    if let Some(s) = v.as_str() {
                        if k.eq_ignore_ascii_case("user-agent") {
                            ua = s.to_string();
                        } else {
                            req = req.header(k, s);
                        }
                    }
                }
            }
        }
    }
    req = req.header("User-Agent", ua);
    let resp = req
        .send()
        .map_err(|e| rquickjs::Error::new_into_js_message("http", "response", e.to_string()))?;
    resp.text()
        .map_err(|e| rquickjs::Error::new_into_js_message("http", "body", e.to_string()))
}

// 下载二进制（csp 管理器可能是 JS 文本或原生 DEX/APK），超时 30s。
fn http_get_bytes(url: &str) -> Result<Vec<u8>, rquickjs::Error> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| rquickjs::Error::new_into_js_message("http", "client", e.to_string()))?;
    let resp = client
        .get(url)
        .header("User-Agent", "okhttp/4.10.0")
        .send()
        .map_err(|e| rquickjs::Error::new_into_js_message("http", "response", e.to_string()))?;
    let bytes = resp
        .bytes()
        .map_err(|e| rquickjs::Error::new_into_js_message("http", "body", e.to_string()))?;
    Ok(bytes.to_vec())
}

fn md5_hex(bytes: &[u8]) -> String {
    let digest = Md5::digest(bytes);
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 执行一段 spider 脚本并调用指定函数，,返回 JSON 字符串。
/// 注意：本函数不再是 Tauri 命令，由 lib.rs 顶层 spiderrun 命令委托调用，
/// 以避免子模块命令在 Tauri v2 ACL 权限标识生成上的限制。
pub fn spiderrun(payload: SpiderCall) -> Result<String, String> {
    // [DEBUG-搜空] 记录收到的调用类型与各字段，定位"搜索/主页全 0"根因
    println!(
        "[spider-debug] func={} api={:?} ext_type={} code_len={} spider_url={:?}",
        payload.func,
        payload.api,
        match &payload.ext {
            Some(v) => if v.is_object() { "object" } else { "string/other" },
            None => "none",
        },
        payload.code.len(),
        payload.spider_url,
    );
    // V3.8.0：csp 管理器下载 + md5 校验。当 code 为空且 spider_url 存在时，
    // 说明是 csp 源——由本端下载顶层管理器（JS 或原生 DEX/APK），校验 md5 后再执行。
    let mut code = payload.code.clone();
    if code.trim().is_empty() {
        if let Some(url) = &payload.spider_url {
            let bytes = http_get_bytes(url)
                .map_err(|e| format!("csp 管理器下载失败（{url}）：{e}"))?;
            if let Some(expected) = &payload.spider_md5 {
                let actual = md5_hex(&bytes);
                if &actual != expected {
                    return Err(format!(
                        "csp 管理器 md5 校验失败：期望 {expected}，实际 {actual}（源站脚本可能已被篡改或下载不完整）"
                    ));
                }
            }
            // 原生 DEX/APK（zip 头 PK）：纯 QuickJS 无法执行，按平台分派。
            // V3.8.1 Phase 2：Android 端交由 Kotlin DexClassLoader 桥（window.MuHaiCsp）执行，
            // 这里只下发结构化描述符，由前端 createCspSource 路由到 MuHaiCsp.require()。
            if bytes.starts_with(b"PK") {
                #[cfg(target_os = "android")]
                {
                    let desc = serde_json::json!({
                        "__native_csp": true,
                        "spider_url": payload.spider_url,
                        "spider_md5": payload.spider_md5,
                        "api": payload.api,
                        "ext": payload.ext,
                    });
                    return Ok(desc.to_string());
                }
                #[cfg(not(target_os = "android"))]
                {
                    return Err("原生蜘蛛源（DEX/APK）仅 Android 支持，桌面端无法运行".into());
                }
            }
            code = String::from_utf8_lossy(&bytes).to_string();
        }
    }
    let rt = Runtime::new().map_err(|e| format!("引擎初始化失败: {e}"))?;
    let ctx = Context::full(&rt).map_err(|e| format!("上下文创建失败: {e}"))?;

    ctx.with(|ctx| -> Result<String, String> {
        let globals = ctx.globals();

            // fetch 桥接：同步 HTTP，返回响应体字符串。
        // 兼容 TVBox spider 习惯：fetch(url, headers_json?, data?)
        let fetch_fn = Function::new(ctx.clone(), |url: String, hd: Option<String>, data: Option<String>| -> Result<String, rquickjs::Error> {
            match data {
                Some(d) => http_post_text(&url, &d, hd.as_deref()),
                None => http_get_text(&url, hd.as_deref()),
            }
        })
        .map_err(|e| e.to_string())?;
        globals.set("fetch", fetch_fn).map_err(|e| e.to_string())?;

        // v3.2.4 修复：rquickjs 0.6 在部分目标（尤其 Android）上默认未把全局对象暴露为
        // `globalThis`，而包装代码依赖它调用全局函数型蜘蛛。显式注入 globalThis 避免
        // "ReferenceError: globalThis is not defined" → QuickJS Exception。
        globals
            .set("globalThis", globals.clone())
            .map_err(|e| e.to_string())?;

        // base64 编码
        let b64enc = Function::new(ctx.clone(), |s: String| -> String { B64.encode(s.as_bytes()) })
            .map_err(|e| e.to_string())?;
        globals.set("base64Encode", b64enc).map_err(|e| e.to_string())?;

        // base64 解码
        let b64dec =
            Function::new(ctx.clone(), |s: String| -> Result<String, rquickjs::Error> {
                let bytes = B64.decode(s.trim()).map_err(|e| rquickjs::Error::new_into_js_message("base64Decode", "string", e.to_string()))?;
                String::from_utf8(bytes).map_err(|e| rquickjs::Error::new_into_js_message("base64Decode", "string", e.to_string()))
            })
            .map_err(|e| e.to_string())?;
        globals.set("base64Decode", b64dec).map_err(|e| e.to_string())?;

        // md5
        let md5_fn = Function::new(ctx.clone(), |s: String| -> String {
            let digest = Md5::digest(s.as_bytes());
            digest.iter().map(|b| format!("{:02x}", b)).collect()
        })
        .map_err(|e| e.to_string())?;
        globals.set("md5", md5_fn).map_err(|e| e.to_string())?;

        // 调试输出
        let print_fn = Function::new(ctx.clone(), |s: String| {
            println!("[spider] {s}");
        })
        .map_err(|e| e.to_string())?;
        globals.set("print", print_fn).map_err(|e| e.to_string())?;

        // v2.5.1 修复：注入 console 对象（log/info/warn/error）。
        // 大量 drpy/CatVod 脚本（如 drpy2.min.js）使用 console.log 调试，
        // 此前未注入导致 ReferenceError: console is not defined → QuickJS 抛 "Exception generated by QuickJS"。
        let mk_log = |tag: &'static str| {
            Function::new(ctx.clone(), move |s: String| {
                println!("[spider][{}] {}", tag, s);
            })
        };
        let console_obj = rquickjs::Object::new(ctx.clone()).map_err(|e| e.to_string())?;
        console_obj
            .set("log", mk_log("log").map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        console_obj
            .set("info", mk_log("info").map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        console_obj
            .set("warn", mk_log("warn").map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        console_obj
            .set("error", mk_log("error").map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        console_obj
            .set("debug", mk_log("debug").map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        globals.set("console", console_obj).map_err(|e| e.to_string())?;

        // v2.5.2 防御性注入：drpy/CatVod 脚本常引用的其它全局 API（缺失会 ReferenceError）。
        let timeout_fn = Function::new(ctx.clone(), |_cb: rquickjs::Function, _ms: i32| -> i32 { 0 })
            .map_err(|e| e.to_string())?;
        globals.set("setTimeout", timeout_fn).map_err(|e| e.to_string())?;
        let clear_fn = Function::new(ctx.clone(), |_id: i32| {}).map_err(|e| e.to_string())?;
        globals.set("clearTimeout", clear_fn).map_err(|e| e.to_string())?;
        // atob/btoa（base64 字符串互转，部分 drpy 用作别名）
        let atob_fn = Function::new(ctx.clone(), |s: String| -> String { B64.encode(s.as_bytes()) })
            .map_err(|e| e.to_string())?;
        globals.set("atob", atob_fn).map_err(|e| e.to_string())?;
        let btoa_fn =
            Function::new(ctx.clone(), |s: String| -> Result<String, rquickjs::Error> {
                let bytes = B64.decode(s.trim()).map_err(|e| rquickjs::Error::new_into_js_message("btoa", "string", e.to_string()))?;
                String::from_utf8(bytes).map_err(|e| rquickjs::Error::new_into_js_message("btoa", "string", e.to_string()))
            })
            .map_err(|e| e.to_string())?;
        globals.set("btoa", btoa_fn).map_err(|e| e.to_string())?;

        // V3.8.0：网盘 token 注入。引擎与 WebView 上下文隔离，window.__netdiskTokens
        // 不会自动可见，必须显式注入全局，供 csp 子蜘蛛取 4K 直链。
        let tokens_lit = payload
            .netdisk_tokens
            .as_ref()
            .map(|v| serde_json::to_string(v).unwrap_or_else(|_| "null".to_string()))
            .unwrap_or_else(|| "null".to_string());
        let inject_tokens = format!("globalThis.__netdiskTokens = {tokens_lit};");
        ctx.eval::<(), _>(inject_tokens.as_str())
            .map_err(|e| format!("注入 __netdiskTokens 失败: {e}"))?;

        // V3.8.0：catvod 宿主 `java` 对象兼容层。catvod csp 蜘蛛（App 类）依赖
        // `java.get/post/md5/base64Encode/base64Decode/stringToMap/getLocation` 等
        // 全局 API。HTTP 类全部复用上面的同步 HTTP 辅助（与 fetch 同通道），
        // 保证 CORS/明文 HTTP 一致；md5/base64 复用既有实现。
        let java_obj = Object::new(ctx.clone()).map_err(|e| e.to_string())?;

        // java.get(url, headers_json?) -> 响应文本
        let java_get = Function::new(ctx.clone(), |url: String, hd: Option<String>| -> Result<String, rquickjs::Error> {
            http_get_text(&url, hd.as_deref())
        })
        .map_err(|e| e.to_string())?;
        java_obj.set("get", java_get).map_err(|e| e.to_string())?;

        // java.post(url, data, headers_json?) -> 响应文本
        let java_post = Function::new(ctx.clone(), |url: String, data: String, hd: Option<String>| -> Result<String, rquickjs::Error> {
            http_post_text(&url, &data, hd.as_deref())
        })
        .map_err(|e| e.to_string())?;
        java_obj.set("post", java_post).map_err(|e| e.to_string())?;

        // java.md5(str) -> 十六进制串
        let java_md5 = Function::new(ctx.clone(), |s: String| -> String {
            let digest = Md5::digest(s.as_bytes());
            digest.iter().map(|b| format!("{:02x}", b)).collect()
        })
        .map_err(|e| e.to_string())?;
        java_obj.set("md5", java_md5).map_err(|e| e.to_string())?;

        // java.base64Encode(str) -> base64
        let java_b64enc = Function::new(ctx.clone(), |s: String| -> String { B64.encode(s.as_bytes()) })
            .map_err(|e| e.to_string())?;
        java_obj.set("base64Encode", java_b64enc).map_err(|e| e.to_string())?;

        // java.base64Decode(b64) -> 文本
        let java_b64dec = Function::new(ctx.clone(), |s: String| -> Result<String, rquickjs::Error> {
            let bytes = B64
                .decode(s.trim())
                .map_err(|e| rquickjs::Error::new_into_js_message("java.base64Decode", "string", e.to_string()))?;
            String::from_utf8(bytes)
                .map_err(|e| rquickjs::Error::new_into_js_message("java.base64Decode", "string", e.to_string()))
        })
        .map_err(|e| e.to_string())?;
        java_obj.set("base64Decode", java_b64dec).map_err(|e| e.to_string())?;

        // java.stringToMap(str) -> 对象。catvod 用 "k:v#k2:v2" 形式传参。
        let java_stm = {
            let c = ctx.clone();
            Function::new(ctx.clone(), move |s: String| -> Result<Object, rquickjs::Error> {
                let obj = Object::new(c.clone())?;
                for seg in s.split('#') {
                    if let Some((k, v)) = seg.split_once(':') {
                        obj.set(k.trim(), v.trim())?;
                    }
                }
                Ok(obj)
            })
            .map_err(|e| e.to_string())?
        };
        java_obj.set("stringToMap", java_stm).map_err(|e| e.to_string())?;

        // java.getLocation(url) -> 跟随重定向后的最终 URL
        let java_loc = Function::new(ctx.clone(), |url: String| -> Result<String, rquickjs::Error> {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|e| rquickjs::Error::new_into_js_message("java", "client", e.to_string()))?;
            let resp = client
                .get(&url)
                .header("User-Agent", "okhttp/4.10.0")
                .send()
                .map_err(|e| rquickjs::Error::new_into_js_message("java.getLocation", "response", e.to_string()))?;
            Ok(resp.url().to_string())
        })
        .map_err(|e| e.to_string())?;
        java_obj.set("getLocation", java_loc).map_err(|e| e.to_string())?;

        // java.getWebWaiter() -> 浏览器自动化桥（catvod 部分蜘蛛依赖）；
        // 本端为无头 QuickJS，不实现，明确报错便于定位（而非静默失败）。
        let java_waiter = Function::new(ctx.clone(), || -> Result<(), rquickjs::Error> {
            Err(rquickjs::Error::new_into_js_message(
                "java.getWebWaiter",
                "unsupported",
                "本端未实现 WebView 自动化（getWebWaiter），依赖它的蜘蛛功能不可用",
            ))
        })
        .map_err(|e| e.to_string())?;
        java_obj.set("getWebWaiter", java_waiter).map_err(|e| e.to_string())?;

        globals.set("java", java_obj).map_err(|e| e.to_string())?;

        // 执行 spider 代码（定义各函数，或定义 `spider` 类/对象）
        ctx.eval::<(), _>(code.as_str()).map_err(|e| {
            // v2.5.1：eval 失败时 dump 脚本前 12 行到 stderr，便于在 CI/日志里定位报错行
            eprintln!("[spider-eval-fail] func={} 错误={}", payload.func, e);
            for (i, line) in code.lines().take(12).enumerate() {
                eprintln!("[spider-eval-fail] L{}: {}", i + 1, line);
            }
            format!("脚本执行失败: {e}")
        })?;
        println!("[spider-debug] 代码 eval 成功，准备调用 {}", payload.func);

        // 调用目标函数并 JSON 序列化结果。
        // 兼容两种 spider 形态：
        //  1) 全局函数 home/search/detail/play（drpy 风格单文件脚本）
        //  2) `spider` 类/对象（TVBox csp 模型）：new spider(api, ext) 后用实例方法选路
        let func_lit = serde_json::to_string(&payload.func).unwrap_or_else(|_| "\"\"".to_string());
        let args_lit = serde_json::to_string(&payload.args).unwrap_or_else(|_| "[]".to_string());
        let api_lit = payload
            .api
            .as_ref()
            .map(|s| serde_json::to_string(s).unwrap())
            .unwrap_or_else(|| "null".to_string());
        let ext_lit = payload
            .ext
            .as_ref()
            .map(|s| serde_json::to_string(s).unwrap())
            .unwrap_or_else(|| "null".to_string());

        let expr = format!(
            r#"
const __api = {api};
// ext 已是经 serde_json 序列化的合法 JSON 字面量（字符串或对象），无需再 JSON.parse。
// 此前前端 JSON.stringify 一次、Rust 端 serde_json::to_string 又一次，导致注入的是
// 双重转义字符串字面量，JSON.parse 抛错使依赖 ext 的 drpy2/csp 站点初始化失败。
const __ext = {ext};
const __global = (typeof globalThis !== 'undefined' && globalThis !== null) ? globalThis : this;

// A3：drpy2 标准源适配 —— 社区 drpy2 规则以 `var rule = {{...}}` 形态提供，其
//   home/search/detail/play 与我们的 spider 接口同名，但返回 AppleCMS 风格 Vod。
//   这里统一包装为 spider 形态（search/detail 返回 list、play 返回 url/{{url,header}}），
//   其余取源/去重/解析选集逻辑完全复用现有适配器。home 无 item 时返回 []（首页回退源站聚合）。
function __drpyWrap(rule, api, ext) {{
  // 合并 rule.headers 到全局 fetch（drpy2 常用 headers 携带 UA/Referer/签名）
  try {{
    if (rule && rule.headers) {{
      var __rh = (typeof rule.headers === 'function') ? rule.headers() : rule.headers;
      if (__rh && typeof __rh === 'object') {{
        var __of = (typeof fetch === 'function') ? fetch : null;
        if (__of) {{
          globalThis.fetch = function(u, hd, data) {{
            var m = {{}};
            for (var k in __rh) m[k] = __rh[k];
            if (hd) {{ try {{ var j = JSON.parse(hd); if (j && typeof j === 'object') {{ for (var k2 in j) m[k2] = j[k2]; }} }} catch(e) {{}} }}
            return __of(u, JSON.stringify(m), data);
          }};
        }}
      }}
    }}
  }} catch(e) {{}}
  function __normVods(r) {{
    if (!r) return [];
    if (Array.isArray(r)) return r;
    if (Array.isArray(r.list)) return r.list;
    if (Array.isArray(r.data)) return r.data;
    return [];
  }}
  return {{
    home: function() {{ var h = (typeof rule.home === 'function') ? rule.home() : null; return __normVods(h); }},
    search: function(key) {{ var s = (typeof rule.search === 'function') ? rule.search(key) : []; return __normVods(s); }},
    detail: function(id) {{ var d = (typeof rule.detail === 'function') ? rule.detail(id) : {{list:[]}}; return {{ list: __normVods(d) }}; }},
    play: function(input) {{ var p = (typeof rule.play === 'function') ? rule.play(input, '', '') : ''; return p; }},
    lives: function() {{ return (typeof rule.lives === 'function') ? rule.lives() : []; }},
  }};
}}

let __t;
if (typeof spider !== 'undefined' && spider !== null) {{
  __t = (typeof spider === 'function') ? new spider(__api, __ext) : spider;
}} else if (typeof rule !== 'undefined' && rule !== null) {{
  __t = __drpyWrap(rule, __api, __ext);
}} else if (typeof {func} === 'function') {{
  __t = __global;
}} else {{
  throw new Error('spider 未定义且全局无函数 ' + {func});
}}
const __args = {args};
const __r = (__t === __global) ? __global[{func}](...__args) : __t[{func}](...__args);
JSON.stringify(__r === undefined ? null : __r);
"#,
            api = api_lit,
            ext = ext_lit,
            func = func_lit,
            args = args_lit,
        );
        let out: String = ctx.eval(expr.as_str()).map_err(|e| {
            eprintln!("[spider-call-fail] func={} 错误={}", payload.func, e);
            for (i, line) in code.lines().take(12).enumerate() {
                eprintln!("[spider-call-fail] L{}: {}", i + 1, line);
            }
            format!("调用 {} 失败: {e}", payload.func)
        })?;
        println!(
            "[spider-debug] 调用 {} 返回长度={}",
            payload.func,
            out.len()
        );
        Ok(out)
    })
}
