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
    /// TVBox csp 模型：站点 ext 配置（字符串或对象皆可），传给 spider 构造器。
    /// 改为 serde_json::Value 以兼容对象型 ext（如 {"class":"电影"}），
    /// 否则 ext 为对象时 Option<String> 反序列化失败、整个 run_spider 抛错，
    /// 导致依赖 ext 的 drpy2/csp 站点（问题 #1/#2）全部返回空。
    #[serde(default)]
    pub ext: Option<serde_json::Value>,
}

/// 执行一段 spider 脚本并调用指定函数，,返回 JSON 字符串。
/// 注意：本函数不再是 Tauri 命令，由 lib.rs 顶层 spiderrun 命令委托调用，
/// 以避免子模块命令在 Tauri v2 ACL 权限标识生成上的限制。
pub fn spiderrun(payload: SpiderCall) -> Result<String, String> {
    // [DEBUG-搜空] 记录收到的调用类型与各字段，定位"搜索/主页全 0"根因
    println!(
        "[spider-debug] func={} api={:?} ext_type={} code_len={}",
        payload.func,
        payload.api,
        match &payload.ext {
            Some(v) => if v.is_object() { "object" } else { "string/other" },
            None => "none",
        },
        payload.code.len()
    );
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

        // 执行 spider 代码（定义各函数，或定义 `spider` 类/对象）
        ctx.eval::<(), _>(payload.code.as_str()).map_err(|e| {
            // v2.5.1：eval 失败时 dump 脚本前 12 行到 stderr，便于在 CI/日志里定位报错行
            eprintln!("[spider-eval-fail] func={} 错误={}", payload.func, e);
            for (i, line) in payload.code.lines().take(12).enumerate() {
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
            for (i, line) in payload.code.lines().take(12).enumerate() {
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
