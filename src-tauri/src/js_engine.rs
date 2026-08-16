// v2.3.0 统一 JS 沙箱引擎（影流/音流共用）
//
// 在 Rust 侧嵌入 QuickJS（rquickjs），执行用户源提供的 spider 脚本，
// 让 App 像影视仓/洛雪那样靠"脚本"驱动任意源（蜘蛛源/加密源/网上各种源）。
//
// 关键约束：脚本内的网络请求一律通过 `fetch` 桥接回 Rust 代理
// （reqwest::blocking），彻底绕开 WebView 的 CORS 与 Android 明文 HTTP 限制。
// 解密原语 base64/md5 由 Rust 注入；AES/RC4 等由加载器在脚本前拼接纯 JS 实现（见 E5）。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use md5::{Digest, Md5};
use rquickjs::{Context, Function, Runtime};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct SpiderCall {
    /// spider 脚本全文（定义 home/search/detail/play 等函数）
    pub code: String,
    /// 要调用的函数名，如 "search" / "home" / "detail" / "play"
    pub func: String,
    /// 函数参数（字符串数组，引擎内部 JSON.parse 后展开传入）
    pub args: Vec<String>,
}

/// 执行一段 spider 脚本并调用指定函数，返回 JSON 字符串。
#[tauri::command]
pub fn run_spider(payload: SpiderCall) -> Result<String, String> {
    let rt = Runtime::new().map_err(|e| format!("引擎初始化失败: {e}"))?;
    let ctx = Context::full(&rt).map_err(|e| format!("上下文创建失败: {e}"))?;

    ctx.with(|ctx| -> Result<String, String> {
        let globals = ctx.globals();

        // fetch 桥接：同步 HTTP，返回响应体字符串。
        // 兼容 TVBox spider 习惯：fetch(url, headers_json?, data?)
        let fetch_fn = Function::new(ctx.clone(), |url: String, hd: Option<String>, data: Option<String>| -> Result<String, rquickjs::Error> {
            let client = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .map_err(|e| rquickjs::Error::new_into_js_message("fetch", "response", e.to_string()))?;
            let mut req = client.get(&url);
            if let Some(h) = &hd {
                if let Ok(map) = serde_json::from_str::<serde_json::Value>(h) {
                    if let Some(obj) = map.as_object() {
                        for (k, v) in obj {
                            if let Some(s) = v.as_str() {
                                req = req.header(k, s);
                            }
                        }
                    }
                }
            }
            req = req.header("User-Agent", "Mozilla/5.0 (compatible; ReelFlow/2.3.0)");
            if let Some(d) = &data {
                req = req.post(d.clone());
            }
            let resp = req.send().map_err(|e| rquickjs::Error::new_into_js_message("fetch", "response", e.to_string()))?;
            resp.text().map_err(|e| rquickjs::Error::new_into_js_message("fetch", "response", e.to_string()))
        })
        .map_err(|e| e.to_string())?;
        globals.set("fetch", fetch_fn).map_err(|e| e.to_string())?;

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

        // 执行 spider 代码（定义各函数）
        ctx.eval::<(), _>(payload.code.as_str())
            .map_err(|e| format!("脚本执行失败: {e}"))?;

        // 调用目标函数并 JSON 序列化结果
        let args_json = serde_json::to_string(&payload.args).map_err(|e| e.to_string())?;
        let expr = format!(
            "JSON.stringify((typeof {} === 'function' ? {} : (globalThis['{}'] || function(){{return '[]'}}))(...JSON.parse({})))",
            payload.func, payload.func, payload.func, args_json
        );
        let out: String = ctx
            .eval(expr.as_str())
            .map_err(|e| format!("调用 {} 失败: {e}", payload.func))?;
        Ok(out)
    })
}
