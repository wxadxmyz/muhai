// V4.2.6 Q3 行为测试：验证 deviceMode 的 TV 判定放宽后，各类设备仍被正确分类。
// 用 esbuild 把 TS 转译到 /tmp 后注入 mock 的 window/navigator/localStorage 环境导入。
// 用法：node verify_device_mode.mjs（在 muhai 根，先跑 build_esbuild 步骤）
import { readFileSync } from 'node:fs';

const SRC = process.argv[2] || '/tmp/deviceMode_test.mjs';

// 每次用例重新 import（模块会缓存 cached 形态），所以给 URL 加唯一 query。
let seq = 0;
async function detect({ ua, width, touch, pointerCoarse, hoverNone, anyPointerFine, manual }) {
  // 构造受控的全局环境
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return (manual === 'on' && k === 'muhai_tv_mode') ? '1' : (this._d[k] ?? null); },
    setItem(k, v) { this._d[k] = String(v); },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua, maxTouchPoints: touch ? 5 : 0 },
    configurable: true, writable: true,
  });
  globalThis.window = {
    innerWidth: width,
    matchMedia(q) {
      let m = false;
      if (q === '(pointer: coarse)') m = !!touch;
      else if (q === '(hover: none)') m = !!hoverNone;
      else if (q === '(any-pointer: coarse)') m = !!pointerCoarse;
      else if (q === '(any-pointer: fine)') m = !!anyPointerFine;
      return { matches: m };
    },
    addEventListener() {},
  };
  if (!touch) delete globalThis.window.ontouchstart;
  else globalThis.window.ontouchstart = null;

  const mod = await import(`file://${SRC}?v=${++seq}`);
  return mod.detectDeviceMode();
}

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const TV_LEANBACK_UA = 'Mozilla/5.0 (Linux; Android 11; TV) AppleWebKit/537.36 Leanback Chrome/120 Safari/537.36';
const TV_BOX_UA = 'Mozilla/5.0 (Linux; Android 11; MI-BOX) AppleWebKit/537.36 Chrome/120 Safari/537.36'; // 无 TV 字样
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36';

const CASES = [
  // [说明, 环境, 期望]
  ['手机竖屏（有触摸、窄屏）', { ua: MOBILE_UA, width: 400, touch: true }, 'phone'],
  ['横屏平板（有触摸、大屏、有 hover 鼠标）', { ua: MOBILE_UA, width: 1280, touch: true, hoverNone: false, anyPointerFine: true }, 'desktop'],
  ['桌面浏览器（非 Android、无触摸）', { ua: DESKTOP_UA, width: 1920, touch: false }, 'desktop'],
  ['Android TV（Leanback UA、无触摸）', { ua: TV_LEANBACK_UA, width: 1920, touch: false }, 'tv'],
  ['盒子无触摸大屏（旧版已能判 tv）', { ua: TV_BOX_UA, width: 1920, touch: false }, 'tv'],
  // ↓ V4.2.6 新增能力：谎报触摸的国产盒子
  ['【Q3 核心】国产盒子谎报触摸 + 大屏 + 无 hover/精细指针 → tv',
    { ua: TV_BOX_UA, width: 1920, touch: true, pointerCoarse: true, hoverNone: true, anyPointerFine: false }, 'tv'],
  ['国产盒子谎报触摸 + Leanback UA → tv（强信号）',
    { ua: TV_LEANBACK_UA, width: 1920, touch: true, pointerCoarse: true, hoverNone: true, anyPointerFine: false }, 'tv'],
  // 手动开关最高优先，任何环境都强制 tv
  ['【Q3 死循环】手机里手动开电视模式 → 立即 tv',
    { ua: MOBILE_UA, width: 400, touch: true, manual: 'on' }, 'tv'],
  // 边界：有触摸大屏但 hover/精细指针都在（=真平板+鼠标），不应误判成 tv
  ['有触摸大屏 + 有精细指针（真平板），不误判 tv',
    { ua: MOBILE_UA, width: 1920, touch: true, hoverNone: false, anyPointerFine: true, pointerCoarse: false }, 'desktop'],
];

let fail = 0;
console.log('=== V4.2.6 Q3 · deviceMode 行为测试 ===');
for (const [name, env, expect] of CASES) {
  const got = await detect(env);
  const ok = got === expect;
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}  →  ${got}${ok ? '' : `（期望 ${expect}）`}`);
}
console.log(`\n${fail ? '❌ ' + fail + ' 项失败' : '✅ 全部通过'}（${CASES.length} 组用例）`);
if (fail) process.exit(1);
