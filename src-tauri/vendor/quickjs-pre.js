// QuickJS 全局补齐 · 第一层（零依赖）
//
// 为什么单独一层：whatwg-url → webidl-conversions 在模块初始化期就会读
// ArrayBuffer.prototype.resizable 的描述符；而 URL polyfill 本身依赖 whatwg-url，
// 若把两者放进同一个模块，就会形成"先求值 URL 依赖 → 再补 resizable"的死结。
// 本层不 import 任何东西，保证最先执行。

// ───────────────────────── 全局垫片（QuickJS 缺失项） ─────────────────────────

// atob / btoa（WHATWG 语义：atob 解码 base64→字符串，btoa 编码字符串→base64）
// 注意：幕海早期把这两个名字接反了（atob=编码），这里是 drpy3 沙箱专用上下文，按标准语义提供。
if (typeof globalThis.atob !== 'function') {
    const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const LK = new Int8Array(128).fill(-1);
    for (let i = 0; i < 64; i++) LK[AL.charCodeAt(i)] = i;
    globalThis.atob = function (s) {
        const clean = String(s).replace(/[\s=]/g, '');
        let out = '', buf = 0, bits = 0;
        for (let i = 0; i < clean.length; i++) {
            buf = (buf << 6) | LK[clean.charCodeAt(i)];
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out += String.fromCharCode((buf >> bits) & 0xff);
            }
        }
        return out;
    };
    globalThis.btoa = function (s) {
        const str = String(s);
        let out = '', buf = 0, bits = 0;
        for (let i = 0; i < str.length; i++) {
            buf = (buf << 8) | (str.charCodeAt(i) & 0xff);
            bits += 8;
            while (bits >= 6) {
                bits -= 6;
                out += AL[(buf >> bits) & 0x3f];
            }
        }
        if (bits > 0) out += AL[(buf << (6 - bits)) & 0x3f] + '=='.slice(0, (6 - bits) / 2 | 0);
        return out;
    };
}

// ArrayBuffer.prototype.resizable / SharedArrayBuffer.prototype.growable
// （ES2024；QuickJS 未实现，whatwg-url → webidl-conversions 在模块初始化期直接取 .get）
try {
    if (!Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')) {
        Object.defineProperty(ArrayBuffer.prototype, 'resizable', {get() { return false; }, configurable: true});
    }
    if (!Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'maxByteLength')) {
        Object.defineProperty(ArrayBuffer.prototype, 'maxByteLength', {get() { return this.byteLength; }, configurable: true});
    }
} catch { /* ignore */ }
try {
    if (!Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'growable')) {
        Object.defineProperty(SharedArrayBuffer.prototype, 'growable', {get() { return false; }, configurable: true});
    }
    if (!Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'maxByteLength')) {
        Object.defineProperty(SharedArrayBuffer.prototype, 'maxByteLength', {get() { return this.byteLength; }, configurable: true});
    }
} catch { /* ignore */ }

// crypto.getRandomValues（jsbn / node-rsa / CryptoJS 可能取用）
if (typeof globalThis.crypto === 'undefined') {
    globalThis.crypto = {
        getRandomValues(arr) {
            for (let i = 0; i < arr.length; i++) arr[i] = (Math.random() * 256) & 0xff;
            return arr;
        },
    };
} else if (typeof globalThis.crypto.getRandomValues !== 'function') {
    globalThis.crypto.getRandomValues = function (arr) {
        for (let i = 0; i < arr.length; i++) arr[i] = (Math.random() * 256) & 0xff;
        return arr;
    };
}

// performance.now（部分源做耗时统计）
if (typeof globalThis.performance === 'undefined') {
    globalThis.performance = {now: () => Date.now()};
}

// queueMicrotask（引擎与库包的微任务路径）
if (typeof globalThis.queueMicrotask !== 'function') {
    globalThis.queueMicrotask = (fn) => {
        try {
            Promise.resolve().then(fn);
        } catch { /* ignore */ }
    };
}

if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = class TextEncoder {
        constructor(enc = 'utf-8') {
            this.encoding = String(enc || 'utf-8').toLowerCase();
        }
        encode(input = '') {
            const s = String(input);
            if (this.encoding === 'latin1' || this.encoding === 'iso-8859-1' || this.encoding === 'ascii') {
                const out = new Uint8Array(s.length);
                for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
                return out;
            }
            const out = [];
            for (let i = 0; i < s.length; i++) {
                let c = s.charCodeAt(i);
                if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
                    const lo = s.charCodeAt(i + 1);
                    if (lo >= 0xdc00 && lo <= 0xdfff) {
                        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
                        i++;
                    }
                }
                if (c < 0x80) out.push(c);
                else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
                else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
                else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
            }
            return new Uint8Array(out);
        }
    };
}

// 极简 TextDecoder（utf-8 / latin1；gbk 由引擎库包内的 gbkTool 自行处理）
if (typeof globalThis.TextDecoder === 'undefined' || typeof globalThis.__mhDecodeUtf8 === 'function') {
    const NativeDec = typeof globalThis.TextDecoder !== 'undefined' ? globalThis.TextDecoder : null;
    globalThis.TextDecoder = class TextDecoder {
        constructor(enc = 'utf-8') {
            this.encoding = String(enc || 'utf-8').toLowerCase();
        }
        decode(buf) {
            const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf || 0);
            // utf-8 优先委托 Rust 侧（__mhDecodeUtf8），避免大文本纯 JS 解码过慢
            if ((this.encoding === 'utf-8' || this.encoding === 'utf8') && typeof globalThis.__mhDecodeUtf8 === 'function') {
                try {
                    return String(globalThis.__mhDecodeUtf8(bytes));
                } catch { /* 落到 JS 实现 */ }
            }
            if (NativeDec) {
                try {
                    return new NativeDec(this.encoding).decode(bytes);
                } catch { /* ignore */ }
            }
            if (this.encoding === 'latin1' || this.encoding === 'iso-8859-1' || this.encoding === 'ascii') {
                let s = '';
                for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
                return s;
            }
            // 手写 UTF-8 解码
            let out = '';
            for (let i = 0; i < bytes.length; ) {
                const b = bytes[i++];
                if (b < 0x80) { out += String.fromCharCode(b); continue; }
                const need = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : 0;
                if (need === 0) { out += String.fromCharCode(b); continue; }
                let cp = (b & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07));
                for (let k = 0; k < need && i < bytes.length; k++) cp = (cp << 6) | (bytes[i++] & 0x3f);
                if (cp > 0xffff) {
                    cp -= 0x10000;
                    out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
                } else out += String.fromCharCode(cp);
            }
            return out;
        }
    };
}

// Uint8Array.fromBase64（TC39 提案，Node 22 与 quickjs-ng 均无）——emscripten 胶水依赖
if (typeof Uint8Array.fromBase64 !== 'function') {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const LOOKUP = new Int8Array(128).fill(-1);
    for (let i = 0; i < 64; i++) LOOKUP[A.charCodeAt(i)] = i;
    LOOKUP['-'.charCodeAt(0)] = 62;
    LOOKUP['_'.charCodeAt(0)] = 63;
    Uint8Array.fromBase64 = function (str) {
        const clean = String(str).replace(/\s/g, '');
        const body = clean.replace(/=+$/, '');
        const out = new Uint8Array(Math.floor((body.length * 3) / 4));
        let o = 0, buf = 0, bits = 0;
        for (let i = 0; i < body.length; i++) {
            buf = (buf << 6) | LOOKUP[body.charCodeAt(i)];
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[o++] = (buf >> bits) & 0xff;
            }
        }
        return out;
    };
}

// WebAssembly 缺失时给个空壳，让引擎 capabilities.wasm 报 none、源可降级
if (typeof globalThis.WebAssembly === 'undefined') {
    const notSupported = () => {
        throw new TypeError('WebAssembly 在此引擎不可用');
    };
    globalThis.WebAssembly = {
        compile: notSupported,
        instantiate: notSupported,
        validate: () => false,
        Module: class {},
        Instance: class {},
        Memory: class {},
        Table: class {},
    };
}

