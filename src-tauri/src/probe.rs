//! 本地流式媒体代理的运行时诊断（V3.6.8）。
//!
//! ## 为什么需要它
//!
//! V3.6.5 引入本地流式代理后，部分真机出现「一直转圈 / 解码错误」，但开发机能复现的只有
//! 「分片能拉下来」。播放链路上真正出事的那一环（WebView 到底有没有连上 127.0.0.1、
//! 上游回的是 200 还是 206、分片是一整片还是 1 字节、hls.js 报的是网络错还是解码错）
//! 在 PC 上无论如何都抓不到——只有真机能给答案。
//!
//! 本模块把这些事实收集成一个可复制的文本报告，由「设置 → 开发者调试」展示。
//! 默认只记录**请求行**（URL / 方法 / client 地址），不记录响应体，开销极低；
//! 但诊断期间需要看到状态码与字节数，故在代理 handler 内直接写入。
//!
//! ## 设计取舍
//!
//! 引擎源（苹果 CMS / drpy）的请求不走这里，别去动 `debugLog`，避免把诊断面板刷爆。
//! 用有界环形缓冲（最多 [`MAX_EVENTS`] 条）而不是全量日志，避免 Android 上长播一部剧
//! 就把内存吃光。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

/// 环形缓冲上限。一部剧按 2000 个分片估算也够用；超出后丢最旧的。
pub const MAX_EVENTS: usize = 2000;

/// 单条媒体代理请求事件。字段刻意保持扁平，方便前端一行行打印。
#[derive(Clone, serde::Serialize)]
pub struct ProxyEvent {
    /// 单调递增序号（从 1 开始），用于判断有无丢事件
    pub seq: u64,
    /// 毫秒时间戳（SystemTime → UNIX_EPOCH）
    pub ts: u64,
    /// 上游目标地址（截断到 [`URL_MAX`] 字符）
    pub url: String,
    /// HTTP 方法（GET / HEAD / OPTIONS）
    pub method: String,
    /// 保留字段（hyper 1.x 的 service_fn 取不到 TCP peer 地址）。当前恒为空字符串。
    pub client: String,
    /// 上游 HTTP 状态码；未发起上游请求时为 0
    pub status: u16,
    /// 原始 Range 请求头（hls.js 的探测与预取都靠它区分）
    pub range: String,
    /// 实际转发给上游的 Range；为空代表该请求的 Range 被判为「探测」已丢弃
    pub fwd_range: String,
    /// 回给 WebView 的字节数；流式转发时未知（记 -1）
    pub body_len: i64,
    /// 是否命中 m3u8 重写分支
    pub m3u8: bool,
    /// 上游 / 代理侧的错误简述；正常为空
    pub note: String,
}

/// URL 截断长度：够看出域名 + 路径 + 关键 query，又不至于把日志撑爆。
const URL_MAX: usize = 300;

static EVENTS: OnceLock<Mutex<VecDeque<ProxyEvent>>> = OnceLock::new();
static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 媒体代理总请求计数（包括未记录的 OPTIONS）。用于一眼看出「WebView 到底连没连上代理」。
static TOTAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// 上游请求成功计数
static UPSTREAM_OK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// 上游请求失败计数（连接超时 / DNS 失败 / 非 2xx）
static UPSTREAM_FAIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Range 被判为「探测」而丢弃的次数
static RANGE_DROPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 请求记录开关。默认开启（环形缓冲 + 截断 URL，开销可忽略）；
/// 关闭后仍保留上述计数器，供「只看统计」使用。
static RECORDING: AtomicBool = AtomicBool::new(true);

fn buf() -> &'static Mutex<VecDeque<ProxyEvent>> {
    EVENTS.get_or_init(|| Mutex::new(VecDeque::with_capacity(256)))
}

/// 记录一条事件并入环形缓冲。任何锁中毒都不应影响播放主链路，故全程 let _ = 忽略。
pub fn record(mut ev: ProxyEvent) {
    TOTAL.fetch_add(1, Ordering::Relaxed);
    if ev.status >= 200 && ev.status < 300 {
        UPSTREAM_OK.fetch_add(1, Ordering::Relaxed);
    } else if ev.status != 0 {
        UPSTREAM_FAIL.fetch_add(1, Ordering::Relaxed);
    }
    if !RECORDING.load(Ordering::Relaxed) {
        return;
    }
    ev.seq = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    ev.ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Ok(mut b) = buf().lock() {
        if b.len() >= MAX_EVENTS {
            b.pop_front();
        }
        b.push_back(ev);
    }
}

/// 记录「Range 被丢弃」这一独立事实（它正是 V3.6.7 想修的坑，需要单独可观测）。
pub fn note_range_dropped() {
    RANGE_DROPPED.fetch_add(1, Ordering::Relaxed);
}

/// 快照：返回最近 [`limit`] 条事件（时间正序），以及累计计数。
pub fn snapshot(limit: usize) -> (Vec<ProxyEvent>, Counters) {
    let out: Vec<ProxyEvent> = buf()
        .lock()
        .map(|b| {
            let skip = b.len().saturating_sub(limit);
            b.iter().skip(skip).cloned().collect()
        })
        .unwrap_or_default();
    (out, counters())
}

#[derive(serde::Serialize)]
pub struct Counters {
    pub total: u64,
    pub upstream_ok: u64,
    pub upstream_fail: u64,
    pub range_dropped: u64,
    pub recording: bool,
}

pub fn counters() -> Counters {
    Counters {
        total: TOTAL.load(Ordering::Relaxed),
        upstream_ok: UPSTREAM_OK.load(Ordering::Relaxed),
        upstream_fail: UPSTREAM_FAIL.load(Ordering::Relaxed),
        range_dropped: RANGE_DROPPED.load(Ordering::Relaxed),
        recording: RECORDING.load(Ordering::Relaxed),
    }
}

pub fn clear() {
    if let Ok(mut b) = buf().lock() {
        b.clear();
    }
    // 序号必须一并归零：诊断报告的用途是「清空 → 复现一次 → 复制」，
    // 若 seq 从旧值续着涨，报告第一条会显示 `#5`，用户会误以为丢了 4 条记录。
    SEQ.store(0, Ordering::Relaxed);
    TOTAL.store(0, Ordering::Relaxed);
    UPSTREAM_OK.store(0, Ordering::Relaxed);
    UPSTREAM_FAIL.store(0, Ordering::Relaxed);
    RANGE_DROPPED.store(0, Ordering::Relaxed);
}

pub fn set_recording(on: bool) {
    RECORDING.store(on, Ordering::Relaxed);
}

/// 把 URL 截断到 [`URL_MAX`]，避免超长签名 URL 把日志撑爆。
pub fn truncate_url(u: &str) -> String {
    if u.chars().count() <= URL_MAX {
        return u.to_string();
    }
    let head: String = u.chars().take(URL_MAX).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// probe 的缓冲与计数器是进程级全局状态，cargo 默认并行跑测试会让它们互相踩
    /// （`clear()` 清掉别的测试刚写的数据 → 断言看到 1964 而不是 2000）。
    /// 这里用一个全局互斥把测试串行化，而不是改生产代码去迁就测试。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn ev(status: u16, url: &str) -> ProxyEvent {
        ProxyEvent {
            seq: 0,
            ts: 0,
            url: url.to_string(),
            method: "GET".into(),
            client: String::new(),
            status,
            range: String::new(),
            fwd_range: String::new(),
            body_len: -1,
            m3u8: false,
            note: String::new(),
        }
    }

    #[test]
    fn record_fills_seq_and_ts() {
        let _g = lock();
        clear();
        record(ev(200, "https://a/1.ts"));
        let (events, c) = snapshot(10);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].seq, 1, "序号应从 1 开始");
        assert!(events[0].ts > 0, "时间戳应被填充");
        assert_eq!(c.total, 1);
        assert_eq!(c.upstream_ok, 1);
        assert_eq!(c.upstream_fail, 0);
    }

    #[test]
    fn counters_split_ok_and_fail() {
        let _g = lock();
        clear();
        record(ev(200, "https://a/1.ts"));
        record(ev(206, "https://a/2.ts"));
        record(ev(404, "https://a/3.ts"));
        record(ev(502, "https://a/4.ts"));
        let (_, c) = snapshot(10);
        assert_eq!(c.upstream_ok, 2, "200/206 计成功");
        assert_eq!(c.upstream_fail, 2, "404/502 计失败");
        assert_eq!(c.total, 4);
    }

    #[test]
    fn ring_buffer_drops_oldest() {
        let _g = lock();
        clear();
        for i in 0..(MAX_EVENTS + 50) {
            record(ev(200, &format!("https://a/{i}.ts")));
        }
        let (events, c) = snapshot(MAX_EVENTS + 100);
        assert_eq!(events.len(), MAX_EVENTS, "缓冲不应超过上限");
        assert_eq!(c.total as usize, MAX_EVENTS + 50, "累计计数不丢");
        // 最旧的应已被丢弃
        assert!(events[0].url.ends_with("/50.ts"), "最早 50 条应被丢弃");
    }

    #[test]
    fn snapshot_limit_returns_tail_in_order() {
        let _g = lock();
        clear();
        for i in 0..10 {
            record(ev(200, &format!("https://a/{i}.ts")));
        }
        let (events, _) = snapshot(3);
        assert_eq!(events.len(), 3);
        assert!(events[0].url.ends_with("/7.ts"), "应取最近 3 条");
        assert!(events[2].url.ends_with("/9.ts"), "且保持时间正序");
    }

    #[test]
    fn recording_off_keeps_counters() {
        let _g = lock();
        clear();
        set_recording(false);
        record(ev(200, "https://a/1.ts"));
        let (events, c) = snapshot(10);
        assert!(events.is_empty(), "关闭记录时不落事件");
        assert_eq!(c.total, 1, "但计数照常累计");
        assert!(!c.recording);
        set_recording(true); // 复位，避免污染其它测试
    }

    #[test]
    fn range_dropped_counter() {
        let _g = lock();
        clear();
        note_range_dropped();
        note_range_dropped();
        let (_, c) = snapshot(10);
        assert_eq!(c.range_dropped, 2);
    }

    #[test]
    fn truncate_url_keeps_short_and_cuts_long() {
        let short = "https://a/1.ts";
        assert_eq!(truncate_url(short), short);
        let long = "x".repeat(URL_MAX + 100);
        let cut = truncate_url(&long);
        assert!(cut.ends_with('…'));
        assert_eq!(cut.chars().count(), URL_MAX + 1);
    }
}
