// 幕海 × drpy3 胶水层
//
// 把 drpy3 引擎（dist/drpy3.js + peer 链 + 库包）与 pdf 四件套（cli/htmlParser.js，cheerio 版 jsoup）
// 打成单文件脚本（IIFE），挂载到 globalThis.__DRPY3__，供 QuickJS（rquickjs）直接 eval。
//
// 与官方 hosts/fjs/glue.mjs 的差异（针对幕海的 QuickJS 沙箱改造）：
//   1. 产物形态：IIFE 全局脚本（QuickJS 无 ESM 装载能力），而非 ESM 模块。
//   2. HTTP：req / syncReq 均为**同步**桥（globalThis.__mhHttp），档 C 语义，
//      Rust 侧 reqwest::blocking 实现；不用 fjs 的 bridge_call 异步通道。
//   3. 不注入 evalModule —— 源走引擎的「中性形态」求值（AsyncFunction 包裹），
//      避免 QuickJS 侧实现动态 import；含相对 import 的源需先做模式 B 预打包。
//   4. 补齐 QuickJS 缺失的全局：URL / TextEncoder / TextDecoder / WebAssembly / Uint8Array.fromBase64。
import './quickjs-pre.js';
import './quickjs-shims.js';
import {Runtime} from './dist/drpy3.js';
import {jsoup} from './cli/htmlParser.js';

// ───────────────────────── 同步 HTTP 桥 ─────────────────────────
// Rust 侧注入 globalThis.__mhHttp(json) -> json，blocking 实现。
// 返回 {content, headers, b64}：b64 为响应体原始字节的 base64（buffer:1/2 用）。
function mhHttp(url, options) {
    const fn = globalThis.__mhHttp;
    if (typeof fn !== 'function') return {content: '', headers: {error: '宿主未提供 __mhHttp'}};
    let raw;
    try {
        raw = fn(JSON.stringify({url: String(url), options: options || {}}));
    } catch (e) {
        return {content: '', headers: {error: String((e && e.message) || e)}};
    }
    let r;
    try {
        r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
        return {content: '', headers: {error: '桥返回非法 JSON'}};
    }
    if (!r || typeof r !== 'object') return {content: '', headers: {error: '桥返回为空'}};
    const o = options || {};
    if (r.b64 && (o.buffer === 1 || o.buffer === 2)) {
        if (o.buffer === 2) return {content: String(r.b64), headers: r.headers || {}};
        try {
            return {content: Uint8Array.fromBase64(String(r.b64)), headers: r.headers || {}};
        } catch { /* fallthrough */ }
    }
    return {content: typeof r.content === 'string' ? r.content : '', headers: r.headers || {}};
}

const toBytes = (v) => (v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : v);

// ───────────────────────── HostEnv ─────────────────────────
const STORE_MAP = new Map();

function makeHostEnv(opts = {}) {
    const storeMap = STORE_MAP;
    return {
        engine: 'muhai (quickjs via rquickjs)',
        version: opts.appVersion || '',

        // ═══ 必选五件套（同步实现：档 C，await 由宿主泵 job 完成）═══
        req: (url, options = {}) => mhHttp(url, options),
        syncReq: (url, options = {}) => mhHttp(url, options),
        pdfh: (html, parse, baseUrl = '') => new jsoup(baseUrl || '').pdfh(html, parse, baseUrl || ''),
        pdfa: (html, parse) => new jsoup('').pdfa(html, parse),
        pd: (html, parse, baseUrl = '') => new jsoup(baseUrl || '').pd(html, parse, baseUrl || ''),
        pdfl: (html, parse, listText, listUrl, myUrl) =>
            new jsoup(myUrl || '').pdfl(html, parse, listText, listUrl, myUrl),

        // ═══ 可选注入 ═══
        store: {
            get(ns, k, def = undefined) {
                const key = ns + '|' + k;
                return storeMap.has(key) ? storeMap.get(key) : def;
            },
            set(ns, k, v) {
                storeMap.set(ns + '|' + k, v);
                return v;
            },
            delete(ns, k) {
                storeMap.delete(ns + '|' + k);
            },
        },
        log: (...args) => {
            try {
                const fn = globalThis.__mhLog;
                const line = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
                if (typeof fn === 'function') fn('[drpy3] ' + line);
            } catch { /* ignore */ }
        },
        getProxy: () => (typeof globalThis.__mhProxy === 'function' ? String(globalThis.__mhProxy()) : 'http://127.0.0.1:9978/proxy?do=js'),
        loadAsset: (p) => {
            try {
                const fn = globalThis.__mhAsset;
                if (typeof fn !== 'function') return '';
                const r = fn(String(p));
                return r == null ? '' : toBytes(r);
            } catch {
                return '';
            }
        },
        // 刻意不注入 evalModule：源走引擎中性形态求值（AsyncFunction），
        // 避免宿主实现动态 import；含相对 import 的源走模式 B 预打包。
        env: opts.env || {},
        action: opts.action !== false,
        lifecycle: {idleTTL: 300, maxHot: 24},
    };
}

// ───────────────────────── 调度面 ─────────────────────────
const SOURCES = new Map();
let RT = null;
let OPTS = {};

function rt() {
    if (!RT) RT = new Runtime(makeHostEnv(OPTS));
    return RT;
}

export function drpy3Setup(optsJson) {
    OPTS = optsJson ? JSON.parse(optsJson) : {};
    RT = null;
    return JSON.stringify(rt().check());
}

export async function drpy3Load(code, key, path, extendJson) {
    // 只有宿主提供 loadAsset（能按路径回读源文本）时才传 path：
    // 生命周期会用 path 做 signature 热更比对，读不到内容会每次调用都触发一次失败的重建。
    const canHotReload = typeof globalThis.__mhAsset === 'function';
    const src = await rt().load(String(code), {
        key: String(key),
        ...(canHotReload && path ? {path: String(path)} : {}),
        ...(extendJson ? {extend: JSON.parse(extendJson)} : {}),
    });
    SOURCES.set(String(key), src);
    return JSON.stringify({key: src.key, form: src.form, is2x: !!src.is2x});
}

/** 六环节统一入口：method ∈ init/home/homeVod/category/search/detail/play/proxy/action/sniffer/isVideo */
export async function drpy3Call(key, method, argsJson) {
    const src = SOURCES.get(String(key));
    if (!src) return JSON.stringify({__drpy3_error: {stage: 'dispatch', error: `源未装载: ${key}`}});
    let args = [];
    if (argsJson) {
        try {
            args = JSON.parse(argsJson);
        } catch {
            return JSON.stringify({__drpy3_error: {stage: 'dispatch', error: 'argsJson 非法'}});
        }
    }
    try {
        const out = await src[method](...args);
        return JSON.stringify(out === undefined ? null : out);
    } catch (e) {
        const detail = e && typeof e.toJSON === 'function' ? e.toJSON() : {stage: method, error: String((e && e.message) || e)};
        return JSON.stringify({__drpy3_error: detail});
    }
}

export function drpy3Capabilities() {
    return JSON.stringify(rt().capabilities);
}

export function drpy3HasSource(key) {
    return SOURCES.has(String(key));
}

export function drpy3Drop(key) {
    SOURCES.delete(String(key));
    return JSON.stringify({ok: true});
}

export async function drpy3Sweep(optsJson) {
    const r = await rt().sweep(optsJson ? JSON.parse(optsJson) : {});
    return JSON.stringify(r);
}

export function drpy3StoreExport() {
    const dump = {};
    for (const [key, v] of STORE_MAP.entries()) {
        const i = key.indexOf('|');
        const ns = i > 0 ? key.slice(0, i) : '';
        const k = i > 0 ? key.slice(i + 1) : key;
        (dump[ns] || (dump[ns] = {}))[k] = v;
    }
    return JSON.stringify(dump);
}

export function drpy3StoreImport(json) {
    const dump = JSON.parse(String(json || '{}'));
    for (const [ns, kv] of Object.entries(dump || {})) {
        for (const [k, v] of Object.entries(kv || {})) STORE_MAP.set(ns + '|' + k, v);
    }
    return JSON.stringify({ok: true});
}
