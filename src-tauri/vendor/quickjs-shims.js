// QuickJS 全局补齐 · 第二层（依赖 whatwg-url）
//
// 第一层（quickjs-pre.js）已把 atob / TextEncoder / ArrayBuffer.resizable 等补齐，
// 本层才敢装载 whatwg-url —— 它在模块初始化期就会用到这些全局。
import {URL as PolyURL, URLSearchParams as PolyURLSearchParams} from 'whatwg-url';

if (typeof globalThis.URL === 'undefined' && typeof PolyURL !== 'undefined') {
    globalThis.URL = PolyURL;
}
if (typeof globalThis.URLSearchParams === 'undefined' && typeof PolyURLSearchParams !== 'undefined') {
    globalThis.URLSearchParams = PolyURLSearchParams;
}

// UTF-8 / latin1 的极简 TextEncoder（QuickJS 原生无此对象）
