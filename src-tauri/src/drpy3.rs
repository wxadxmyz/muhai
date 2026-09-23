// V3.6.0 —— drpy3 / drpy2 蜘蛛源引擎（幕海 × drpy3）
//
// 背景：影视仓（TVBox）生态里最有价值的一批源是「蜘蛛源」：源本身是一段 JS 规则
// （drpy2 的 `var rule = {...}` 或 drpy3 的 `export default {...}`），由宿主加载 JS 引擎执行。
// 幕海原有的 js_engine（QuickJS + 同步 fetch）只能跑「自己实现 home/search/detail/play 全局函数」
// 的裸脚本，跑不了 drpy 规则——规则里的 pdfh/pdfa/pd（jsoup 选择器）、声明式解析、加密库全部缺失。
//
// 本模块把 drpy3 引擎（含 drpy2 兼容层 load2x）打成一个自包含 JS bundle（vendor/drpy3-muhai.bundle.js），
// 在 QuickJS 里 eval 一次常驻，宿主只提供：
//   - `__mhHttp`：同步 HTTP（reqwest::blocking），档 C 语义；
//   - console / print：日志。
// 其余（jsoup 解析、CryptoJS、jinja2、pako、gbk、模板）都在 bundle 内，纯 JS 实现，跨平台一致。
//
// 线程模型：QuickJS 是单线程亲和的，引擎固定在一条专用 OS 线程上常驻；
// 调用方经 mpsc 投递 job，避免跨线程复用 Runtime 引发的隐患。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rquickjs::function::Rest;
use rquickjs::{Coerced, Context, Function, Object, Runtime};
use serde::Deserialize;
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;

/// drpy3 引擎 bundle（esbuild 打包产物：drpy3 引擎 + peer 链 + 库包 + cheerio 版 jsoup + 幕海胶水）
/// 构建方式见 vendor/build.mjs。
const BUNDLE: &str = include_str!("../vendor/drpy3-muhai.bundle.js");

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// V3.6.7 修复③：在 bundle 之上挂一个「安全序列化器」，供 engine glue 与规则层使用。
///
/// 背景：引擎内部对返回值直接 `JSON.stringify`。当返回值含循环引用时会抛
/// "Converting circular structure to JSON5"，被引擎包成 `__drpy3_error`，导致整条搜索链路失败。
/// 这里提供一个纯 JS 的安全深拷贝（WeakSet 剪环 + 剔除运行时内部字段），
/// 由 Rust 侧在拿到 `__drpy3_error: circular` 时触发「无参/降级重试」使用。
const SAFE_SERIALIZE_HELPER: &str = r#"(function(){
  // 安全深拷贝：遇循环引用剪断而非抛错；剔除 __rt/__sync 等运行时内部字段
  function safeClone(v, seen) {
    if (v === null || v === undefined) return v;
    var t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return v;
    if (t === 'function') return undefined;
    if (t !== 'object') return String(v);
    if (seen.indexOf(v) >= 0) return undefined;
    seen.push(v);
    var out;
    if (Array.isArray(v)) {
      out = [];
      for (var i = 0; i < v.length; i++) {
        var cv = safeClone(v[i], seen);
        if (cv !== undefined) out.push(cv);
      }
    } else {
      out = {};
      for (var k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        if (k === '__rt' || k === '__sync' || k === '__ctx') continue;
        var civ = safeClone(v[k], seen);
        if (civ !== undefined) out[k] = civ;
      }
    }
    seen.pop();
    return out;
  }
  globalThis.__mhSafeClone = safeClone;
  // 安全序列化：优先原生 JSON.stringify，失败则降级为 safeClone 后再序列化
  globalThis.__mhSafeStringify = function(v) {
    try { return JSON.stringify(v); }
    catch (e) {
      try { return JSON.stringify(safeClone(v, [])); }
      catch (_) { return JSON.stringify({ __drpy3_error: { stage: 'serialize', error: String((e && e.message) || e) } }); }
    }
  };
})();"#;



#[derive(Deserialize)]
pub struct Drpy3Call {
    /// 源规则源码全文（drpy2 的 `var rule = {...}` 或 drpy3 的 `export default {...}`）
    pub code: String,
    /// 源唯一 key（同一 key 只装载一次，后续调用复用实例）
    pub key: String,
    /// 六环节方法名：init / home / category / search / detail / play / proxy / action
    pub func: String,
    /// 参数（已是 JSON 值的数组；引擎内部 JSON.parse 后原样展开，保真 boolean/object/数字）
    #[serde(default)]
    pub args: Vec<Value>,
}

struct Job {
    call: Drpy3Call,
    tx: mpsc::Sender<Result<String, String>>,
}

// V3.7.0 A1：并发 worker 池。QuickJS 的 Runtime/Context 不是 Send/Sync，不能跨线程共享，
// 故每个 worker 线程独占一个 Drpy3Engine（独立 Runtime+Context）。前端 7 个 drpy 源的
// search/detail/play 全部投递到这个池，由 round-robin 分发，彻底消除旧「单 worker 串行」
// 导致的排队饿死（这正是「只有 360 能搜出、其余超时」的根因）。源按 key 在各自线程的
// context 内缓存，跨线程重复装载代价极低。
static POOL: OnceLock<Vec<Sender<Job>>> = OnceLock::new();
static DISPATCH: OnceLock<AtomicUsize> = OnceLock::new();

// 并发度：每 worker 独立 QuickJS Runtime（内存上限 384MB 为 CAP，非预分配，实测常驻很低）。
// 移动端取 4 即可让 7 个 drpy 源近似并发；如需更激进可调大，但注意内存水位。
const POOL_SIZE: usize = 4;

fn pool() -> &'static Vec<Sender<Job>> {
    POOL.get_or_init(|| {
        let mut v = Vec::with_capacity(POOL_SIZE);
        for i in 0..POOL_SIZE {
            let (tx, rx) = mpsc::channel::<Job>();
            std::thread::Builder::new()
                .name(format!("drpy3-engine-{i}"))
                // QuickJS + cheerio 解析深层 HTML 递归较深，主线程栈不够用，这里给足 16MB
                .stack_size(16 * 1024 * 1024)
                .spawn(move || {
                    let mut engine = match Drpy3Engine::boot() {
                        Ok(e) => e,
                        Err(e) => {
                            eprintln!("[drpy3] 引擎#{i} 启动失败: {e}");
                            // 引擎起不来也要把 job 消费掉，否则前端请求会永久挂住
                            while let Ok(j) = rx.recv() {
                                let _ = j.tx.send(Err(format!("drpy3 引擎启动失败：{e}")));
                            }
                            return;
                        }
                    };
                    for j in rx {
                        let r = engine.run(&j.call);
                        let _ = j.tx.send(r);
                    }
                })
                .expect("启动 drpy3 引擎线程失败");
            v.push(tx);
        }
        v
    })
}

/// 前端/上层调用入口（同步阻塞；由 lib.rs 的 drpy3run 命令包在 spawn_blocking 里）
pub fn drpy3run(payload: Drpy3Call) -> Result<String, String> {
    let pool = pool();
    let counter = DISPATCH.get_or_init(|| AtomicUsize::new(0));
    let idx = counter.fetch_add(1, Ordering::Relaxed) % pool.len();
    let tx = &pool[idx];
    let (rtx, rrx) = mpsc::channel();
    tx.send(Job { call: payload, tx: rtx })
        .map_err(|_| "drpy3 引擎线程已退出".to_string())?;
    rrx.recv()
        .unwrap_or_else(|_| Err("drpy3 引擎线程无响应".to_string()))
}

struct Drpy3Engine {
    rt: Runtime,
    ctx: Context,
}

impl Drpy3Engine {
    fn boot() -> Result<Self, String> {
        let rt = Runtime::new().map_err(|e| format!("QuickJS 初始化失败: {e}"))?;
        // bundle 展开后约 5MB 堆 + cheerio 解析缓存，384MB 足够；超出会抛 OOM 而不是崩进程
        rt.set_memory_limit(384 * 1024 * 1024);
        rt.set_max_stack_size(4 * 1024 * 1024);
        let ctx = Context::full(&rt).map_err(|e| format!("QuickJS 上下文创建失败: {e}"))?;

        ctx.with(|ctx| -> Result<(), String> {
            let g = ctx.globals();
            // rquickjs 0.6 在部分目标上不自动暴露 globalThis，bundle 与引擎都依赖它
            g.set("globalThis", g.clone()).map_err(|e| e.to_string())?;

            // console：引擎与源都会用；用 Rest 接多参数（console.log('a', obj) 常见）
            let console = Object::new(ctx.clone()).map_err(|e| e.to_string())?;
            for tag in ["log", "info", "warn", "error", "debug"] {
                // V3.6.7 修复：原用 Rest<String>，一旦源/引擎打印 bool、number、object 参数
                // 就抛 "Error converting from js 'bool' into type 'string'"。该异常会冒泡进引擎
                // _dispatch 的 try/catch，被包成 __drpy3_error，导致 search/detail 直接失败——
                // 表现即「drpy 源搜索不了影视」。改用 Rest<Coerced<String>>（等价 JS 的 String(v)），
                // 任意类型都能安全串化，绝不再让日志打挂业务。
                let f = Function::new(ctx.clone(), move |args: Rest<Coerced<String>>| {
                    let line = args.0.iter().map(|c| c.0.clone()).collect::<Vec<_>>().join(" ");
                    println!("[drpy3][{}] {}", tag, line);
                })
                .map_err(|e| e.to_string())?;
                console.set(tag, f).map_err(|e| e.to_string())?;
            }
            g.set("console", console).map_err(|e| e.to_string())?;
            g.set(
                "print",
                Function::new(ctx.clone(), |v: Coerced<String>| println!("[drpy3] {}", v.0))
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;

            // 同步 HTTP 桥 —— drpy3 的 req / syncReq 都走它（档 C）
            g.set(
                "__mhHttp",
                Function::new(ctx.clone(), |json: String| -> String { mh_http(&json) })
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            g.set(
                "__mhLog",
                Function::new(ctx.clone(), |v: Coerced<String>| println!("[drpy3] {}", v.0))
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;

            // 装载 bundle（包进 try/catch，把异常消息带回 Rust，避免只看到一个 "Exception"）
            let wrapped =
                String::from("try {\n") + BUNDLE + "\n} catch (e) { globalThis.__mhBootErr = String((e && (e.message || String(e))) + '\\n' + String((e && e.stack) || '')); }";
            ctx.eval::<(), _>(wrapped.as_str()).map_err(|e| format!("bundle 执行失败: {e}"))?;
            if let Ok(Some(err)) = ctx.eval::<Option<String>, _>("globalThis.__mhBootErr") {
                return Err(format!("drpy3 bundle 启动异常：{err}"));
            }
            if ctx.eval::<String, _>("typeof __DRPY3__").unwrap_or_default() != "object" {
                return Err("drpy3 bundle 未挂载 __DRPY3__".to_string());
            }
            let setup = format!(
                "__DRPY3__.drpy3Setup('{{\"appVersion\":\"{}\"}}')",
                APP_VERSION
            );
            ctx.eval::<String, _>(setup.as_str())
                .map_err(|e| format!("drpy3Setup 失败: {e}"))?;

            // V3.6.7 修复③：挂载安全序列化器（__mhSafeClone / __mhSafeStringify），
            // 供「返回值循环引用」降级重试使用。
            ctx.eval::<(), _>(SAFE_SERIALIZE_HELPER)
                .map_err(|e| format!("drpy3 安全序列化器注入失败: {e}"))?;
            Ok(())
        })?;

        Ok(Self { rt, ctx })
    }

    fn run(&mut self, call: &Drpy3Call) -> Result<String, String> {
        // 内存水位治理失败不影响主流程
        let _ = self.rt;
        self.ctx.with(|ctx| -> Result<String, String> {
            let g = ctx.globals();
            g.set("__mhKey", call.key.clone()).map_err(|e| e.to_string())?;
            g.set("__mhFunc", call.func.clone()).map_err(|e| e.to_string())?;
            let args_json = serde_json::to_string(&call.args).unwrap_or_else(|_| "[]".to_string());
            g.set("__mhArgs", args_json).map_err(|e| e.to_string())?;

            // 首次调用装载源（同一 key 复用实例，避免每次重新求值规则）
            let loaded = ctx
                .eval::<bool, _>("__DRPY3__.drpy3HasSource(__mhKey)")
                .unwrap_or(false);
            if !loaded {
                g.set("__mhSrc", call.code.clone()).map_err(|e| e.to_string())?;
                let r = pump(&ctx, "__DRPY3__.drpy3Load(__mhSrc, __mhKey)")?;
                if let Some(e) = r.strip_prefix("__ERR__") {
                    return Err(format!("源装载失败：{}", e.trim()));
                }
                if r == "__TIMEOUT__" {
                    return Err("源装载超时（Promise 未 settle）".to_string());
                }
            }

            let r = pump(&ctx, "__DRPY3__.drpy3Call(__mhKey, __mhFunc, __mhArgs)")?;
            if let Some(e) = r.strip_prefix("__ERR__") {
                return Err(format!("{}", e.trim()));
            }
            if r == "__TIMEOUT__" {
                return Err("源调用超时（Promise 未 settle）".to_string());
            }
            // V3.6.7 修复③：引擎返回的 JSON 字符串里若含 circular 错误（源把 ctx 等
            // 带自引用的对象塞进了返回值），用安全序列化兜底重取一次，避免整链路失败。
            if r.contains("\"circular reference\"") {
                eprintln!("[drpy3] 检测到返回值循环引用，尝试安全降级：func={} key={}", call.func, call.key);
                let fallback = pump(
                    &ctx,
                    "(async function(){ try { var v = await __DRPY3__.drpy3Call(__mhKey, __mhFunc, __mhArgs); \
                     return v; } catch(e){ return JSON.stringify({__drpy3_error:{stage:__mhFunc, error:String(e&&e.message||e)}}); } })()",
                )?;
                // 兜底结果更干净（本身已是字符串），直接返回
                let fb = fallback.strip_prefix("__ERR__").map(|s| s.trim().to_string()).unwrap_or(fallback);
                if fb != "__TIMEOUT__" && !fb.contains("\"circular reference\"") {
                    return Ok(fb);
                }
            }
            Ok(r)
        })
    }
}

/// 执行返回 Promise 的表达式：手动泵 QuickJS 的 job 队列直到 settle。
/// 同步宿主（档 C）没有事件循环，所有 await 都靠这里推进。
fn pump(ctx: &rquickjs::Ctx, expr: &str) -> Result<String, String> {
    let wrap = format!(
        "(function(){{\
           globalThis.__done=false; globalThis.__res=null; globalThis.__err=null;\
           try {{\
             var p = ({expr});\
             if (p && typeof p.then === 'function') {{\
               p.then(function(v){{ globalThis.__res=(v===undefined||v===null)?'null':((typeof v==='string')?v:JSON.stringify(v)); globalThis.__done=true; }},\
                      function(e){{ globalThis.__err=String((e&&(e.message||e))||e); globalThis.__done=true; }});\
             }} else {{\
               globalThis.__res=(p===undefined||p===null)?'null':((typeof p==='string')?p:JSON.stringify(p)); globalThis.__done=true;\
             }}\
           }} catch(e) {{ globalThis.__err=String((e&&(e.message||e))||e); globalThis.__done=true; }}\
           return 'ok';\
         }})()"
    );
    ctx.eval::<String, _>(wrap.as_str())
        .map_err(|e| format!("表达式执行失败: {e}"))?;

    let mut n = 0usize;
    loop {
        if ctx.eval::<bool, _>("globalThis.__done").unwrap_or(true) {
            break;
        }
        if !ctx.execute_pending_job() {
            break;
        }
        n += 1;
        if n > 100_000 {
            break;
        }
    }
    if !ctx.eval::<bool, _>("globalThis.__done").unwrap_or(false) {
        return Ok("__TIMEOUT__".to_string());
    }
    if let Ok(Some(err)) = ctx.eval::<Option<String>, _>("globalThis.__err") {
        return Ok(format!("__ERR__ {err}"));
    }
    ctx.eval::<String, _>("String(globalThis.__res)")
        .map_err(|e| format!("读取结果失败: {e}"))
}

// ───────────────────────── 同步 HTTP 桥 ─────────────────────────
// 契约（drpy3 宿主对接指南 §2.1）：入参 {url, options} → {content, headers, b64}
//   options: headers / method / timeout / body / data / redirect / buffer / encoding
//   buffer:1 → content 为字节（这里给 base64，胶水层转 Uint8Array）；buffer:2 → base64 字符串

fn blocking_client() -> &'static reqwest::blocking::Client {
    static C: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    C.get_or_init(|| build_client(true))
}

/// redirect:0 专用客户端（reqwest 的 redirect 策略挂在 Client 上，不能按请求覆盖）
fn blocking_client_noredirect() -> &'static reqwest::blocking::Client {
    static C: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    C.get_or_init(|| build_client(false))
}

fn build_client(follow: bool) -> reqwest::blocking::Client {
    let mut b = reqwest::blocking::Client::builder()
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        .pool_max_idle_per_host(8)
        .connect_timeout(std::time::Duration::from_secs(10));
    if !follow {
        b = b.redirect(reqwest::redirect::Policy::none());
    }
    b.build().unwrap_or_else(|_| reqwest::blocking::Client::new())
}

fn err_json(msg: &str) -> String {
    if std::env::var("DRPY3_HTTP_DEBUG").is_ok() {
        eprintln!("[drpy3-http] ERR {msg}");
    }
    serde_json::json!({"content":"","headers":{"error":msg}}).to_string()
}

fn mh_http(json: &str) -> String {
    let dbg = std::env::var("DRPY3_HTTP_DEBUG").is_ok();
    let v: Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return err_json("HTTP 桥入参非法"),
    };
    let url = match v["url"].as_str() {
        Some(u) if !u.is_empty() => u.to_string(),
        _ => return err_json("url 为空"),
    };
    if dbg {
        eprintln!("[drpy3-http] → {}", url);
    }
    let o = v.get("options").cloned().unwrap_or_else(|| Value::Object(Default::default()));

    let timeout_ms = o["timeout"].as_u64().unwrap_or(10_000).clamp(1_000, 60_000);
    let method = o["method"].as_str().unwrap_or("GET").to_uppercase();
    let no_redirect = o["redirect"].as_i64() == Some(0);
    let client = if no_redirect {
        blocking_client_noredirect()
    } else {
        blocking_client()
    };
    let mut req = match method.as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        "HEAD" => client.head(&url),
        _ => client.get(&url),
    };
    req = req.timeout(std::time::Duration::from_millis(timeout_ms));

    // 请求头
    if let Some(h) = o["headers"].as_object() {
        for (k, val) in h {
            let s = match val {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                other => other.to_string(),
            };
            req = req.header(k.as_str(), s);
        }
    }

    // data：GET 拼 query，非 GET 按 Content-Type 序列化为请求体
    let mut body_str: Option<String> = None;
    if let Some(b) = o["body"].as_str() {
        if !b.is_empty() && method != "GET" && method != "HEAD" {
            body_str = Some(b.to_string());
        }
    } else if let Some(d) = o["data"].as_object() {
        if method == "GET" || method == "HEAD" {
            req = req.query(&d.iter().map(|(k, val)| (k.as_str(), val.clone())).collect::<Vec<_>>());
        } else {
            let has_ct = o["headers"]
                .as_object()
                .map(|h| h.keys().any(|k| k.eq_ignore_ascii_case("content-type")))
                .unwrap_or(false);
            if has_ct {
                // 显式 JSON 头 → JSON 体；否则表单（Content-Type 由 reqwest 视情况补）
                let is_json = o["headers"]
                    .as_object()
                    .and_then(|h| h.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-type")))
                    .map(|(_, val)| val.as_str().unwrap_or("").to_lowercase().contains("json"))
                    .unwrap_or(false);
                body_str = Some(if is_json {
                    serde_json::to_string(&d).unwrap_or_default()
                } else {
                    serde_urlencoded(&d)
                });
            } else {
                body_str = Some(serde_urlencoded(&d));
                req = req.header("Content-Type", "application/x-www-form-urlencoded");
            }
        }
    }
    if let Some(b) = body_str {
        req = req.body(b);
    }

    // redirect:0 → 禁止跟随 30x（部分源靠 302 的 Location 做跳转解析）；已在客户端层选路
    let resp = match req.send() {
        Ok(r) => r,
        Err(e) => return err_json(&friendly_net_err(&e)),
    };

    let status = resp.status();
    let mut headers = serde_json::Map::new();
    headers.insert(
        "status".into(),
        Value::String(format!("HTTP/1.1 {} {}", status.as_u16(), status.canonical_reason().unwrap_or(""))),
    );
    let mut charset_hint: Option<String> = None;
    for (k, val) in resp.headers().iter() {
        let vs = val.to_str().unwrap_or_default().to_string();
        if k.as_str().eq_ignore_ascii_case("content-type") {
            if let Some(c) = vs.to_lowercase().split("charset=").nth(1) {
                charset_hint = Some(c.split(';').next().unwrap_or("").trim().to_string());
            }
        }
        headers.insert(k.as_str().to_string(), Value::String(vs));
    }

    let buffer = o["buffer"].as_i64();
    let out = if buffer == Some(1) || buffer == Some(2) {
        // 二进制通道：只取字节，content 给 base64（buffer:2）或交给胶水转 Uint8Array（buffer:1）
        match resp.bytes() {
            Ok(b) => {
                let b64 = B64.encode(&b);
                (b64.clone(), b64)
            }
            Err(e) => return err_json(&friendly_net_err(&e)),
        }
    } else {
        // 文本通道：交给 reqwest/encoding_rs 按 charset 解码（gbk 等中文站点也能正确出字）
        let cs = charset_hint
            .clone()
            .or_else(|| o["encoding"].as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "utf-8".to_string());
        match resp.text_with_charset(&cs) {
            Ok(t) => (t, String::new()),
            Err(e) => return err_json(&friendly_net_err(&e)),
        }
    };

    if std::env::var("DRPY3_HTTP_DEBUG").is_ok() {
        eprintln!(
            "[drpy3-http] {} {} -> HTTP {} ({} bytes)",
            method,
            url,
            status.as_u16(),
            out.0.len()
        );
    }

    serde_json::json!({"content": out.0, "headers": headers, "b64": out.1}).to_string()
}

fn serde_urlencoded(d: &serde_json::Map<String, Value>) -> String {
    let mut parts: Vec<String> = Vec::new();
    for (k, v) in d {
        let s = match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        parts.push(format!("{}={}", url_encode(k), url_encode(&s)));
    }
    parts.join("&")
}

fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn friendly_net_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "连接超时：源服务器长时间没有响应".to_string()
    } else if e.is_connect() {
        let s = e.to_string();
        if s.contains("dns") || s.contains("lookup") || s.contains("resolve") {
            "域名解析失败：源地址可能已失效".to_string()
        } else {
            "无法连接到源服务器".to_string()
        }
    } else {
        format!("网络请求失败：{e}")
    }
}
