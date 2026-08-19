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
use rquickjs::{Context, Function, Runtime};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct SpiderCall {
    /// spider 脚本全文（定义 home/search/detail/play 等函数，或定义 `spider` 类）
    pub code: String,
    /// 要调用的函数名，如 "search" / "home" / "detail" / "play"
    pub func: String,
    /// 函数参数（字符串数组，引擎内部 JSON.parse 后展开传入）
    pub args: Vec<String>,
    /// TVBox csp 模型：站点代号（如 "csp_DoubanGuard"），传给 spider 构造器选路
    #[serde(default)]
    pub api: Option<String>,
    /// TVBox csp 模型：站点 ext 配置（JSON 字符串），传给 spider 构造器
    #[serde(default)]
    pub ext: Option<String>,
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
            let mut req = if let Some(d) = &data {
                client.post(&url).body(d.clone())
            } else {
                client.get(&url)
            };
            // TVBox 生态普遍只对 okhttp UA 返回正常内容；若调用方通过 headers
            // 显式指定了 UA，则尊重之，否则默认 okhttp。
            let mut ua = "okhttp/4.10.0".to_string();
            if let Some(h) = &hd {
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

        // 执行 spider 代码（定义各函数，或定义 `spider` 类/对象）
        ctx.eval::<(), _>(payload.code.as_str())
            .map_err(|e| format!("脚本执行失败: {e}"))?;

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
const __ext = {ext} ? JSON.parse({ext}) : null;
let __t;
if (typeof spider !== 'undefined' && spider !== null) {{
  __t = (typeof spider === 'function') ? new spider(__api, __ext) : spider;
}} else if (typeof {func} === 'function') {{
  __t = globalThis;
}} else {{
  throw new Error('spider 未定义且全局无函数 ' + {func});
}}
const __args = {args};
const __r = (__t === globalThis) ? globalThis[{func}](...__args) : __t[{func}](...__args);
JSON.stringify(__r === undefined ? null : __r);
"#,
            api = api_lit,
            ext = ext_lit,
            func = func_lit,
            args = args_lit,
        );
        let out: String = ctx
            .eval(expr.as_str())
            .map_err(|e| format!("调用 {} 失败: {e}", payload.func))?;
        Ok(out)
    })
}
