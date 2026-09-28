// TV 端 DPAD 焦点系统（遥控器方向键导航底座）。
//
// 设计目标（与《平板电视适配-更改清单.md》§3.9 / §3.12 一致）：
//   1. 全局 keydown 监听 ArrowUp/Down/Left/Right（空间导航）+ Enter/Space（确认）+ Backspace/Esc（返回）；
//   2. 维护可聚焦元素（`data-focusable` + 自动补 `tabindex="0"`），方向键按几何就近匹配移动焦点；
//   3. scroll-into-view：焦点项始终滚入可视区（电视无滚轮，靠方向键带滚动）；
//   4. 浮层焦点陷阱：打开带 `data-focus-root` 的弹层时，焦点锁在该层内，关闭归还；与 backStack 协同；
//   5. 对触屏透明：`isTV() && !isTouchDevice()` 才激活，手机/平板/桌面键鼠完全不受影响。
//
// 注意：本文件不渲染任何 UI，只管理焦点。视觉焦点环在 tv.css 里用 `[data-focusable]:focus` 实现。

import { isTV, isTouchDevice } from './deviceMode';
import { dispatchBack } from './backStack';

export function isFocusNavActive(): boolean {
  return isTV() && !isTouchDevice();
}

let installed = false;
let currentEl: HTMLElement | null = null;

function prep(el: HTMLElement) {
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
}

function rectOf(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    cx: r.left + r.width / 2,
    cy: r.top + r.height / 2,
    w: r.width,
    h: r.height,
  };
}

function isVisible(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled')) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  // 被 overflow 容器裁剪（off-screen）的元素仍参与导航，否则长列表无法滚到；
  // 仅排除 display:none / 祖先隐藏（rect 为 0 已由上方判断）。
  return true;
}

// 当前焦点作用域：取最上层 `[data-focus-root]`；无则整页（body）。
function getScope(): HTMLElement {
  const roots = Array.from(document.querySelectorAll<HTMLElement>('[data-focus-root]'));
  for (let i = roots.length - 1; i >= 0; i--) {
    const rr = roots[i];
    const cs = getComputedStyle(rr);
    // 浮层多为 fixed；普通容器则要求可见
    if (cs.position === 'fixed' || cs.display !== 'none') return rr;
  }
  return document.body;
}

function focusablesIn(scope: HTMLElement): HTMLElement[] {
  const all = Array.from(scope.querySelectorAll<HTMLElement>('[data-focusable]'));
  return all.filter((el) => {
    if (!scope.contains(el)) return false;
    if (!isVisible(el)) return false;
    prep(el);
    return true;
  });
}

function focusEl(el: HTMLElement) {
  if (!el) return;
  currentEl = el;
  prep(el);
  try {
    el.focus({ preventScroll: true });
  } catch {
    /* 某些环境 focus 抛错，忽略 */
  }
  // 电视无滚轮：方向键移动焦点时自动把焦点项滚入可视区（block/inline 就近即可）。
  try {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } catch {
    /* ignore */
  }
}

type Dir = 'up' | 'down' | 'left' | 'right';

// 空间导航：在 dir 方向上选「主轴距离 + 垂直偏移」加权最小的候选。
function bestCandidate(dir: Dir, cur: HTMLElement, list: HTMLElement[]): HTMLElement | null {
  const c = rectOf(cur);
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === cur) continue;
    const r = rectOf(el);
    let primary = 0; // 沿移动轴的前进距离
    let secondary = 0; // 垂直轴偏移（惩罚「隔着很远但勉强同方向」的元素）
    switch (dir) {
      case 'right':
        if (r.left < c.cx - 0.5) continue; // 必须在右侧
        primary = r.left - c.right;
        secondary = Math.abs(r.cy - c.cy);
        break;
      case 'left':
        if (r.right > c.cx + 0.5) continue; // 必须在左侧
        primary = c.left - r.right;
        secondary = Math.abs(r.cy - c.cy);
        break;
      case 'down':
        if (r.top < c.cy - 0.5) continue; // 必须在下方
        primary = r.top - c.bottom;
        secondary = Math.abs(r.cx - c.cx);
        break;
      case 'up':
        if (r.bottom > c.cy + 0.5) continue; // 必须在上方
        primary = c.top - r.bottom;
        secondary = Math.abs(r.cx - c.cx);
        break;
    }
    if (primary < 0) primary = 0; // 边缘重叠按 0 计
    const score = primary + secondary * 1.4;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function scrollScope(dir: Dir, scope: HTMLElement) {
  // 当前方向上没有候选：把可滚动容器滚一屏，让后续焦点有机会匹配（电视无滚轮兜底）。
  const scroller =
    (scope.matches('.tv-scroll, [data-scroll]') ? scope : scope.querySelector<HTMLElement>('.tv-scroll, [data-scroll]')) ||
    null;
  if (!scroller) return;
  const step = Math.max(120, scroller.clientHeight * 0.8);
  if (dir === 'down') scroller.scrollBy({ top: step, behavior: 'smooth' });
  else if (dir === 'up') scroller.scrollBy({ top: -step, behavior: 'smooth' });
  else if (dir === 'right') scroller.scrollBy({ left: step, behavior: 'smooth' });
  else if (dir === 'left') scroller.scrollBy({ left: -step, behavior: 'smooth' });
}

function activeFocusable(): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  if (a && a !== document.body && a.hasAttribute && a.hasAttribute('data-focusable')) return a;
  return currentEl;
}

function onKeyDown(e: KeyboardEvent) {
  if (!isFocusNavActive()) return;
  // 真实输入框（如网盘粘贴）交给系统，不劫持方向键
  const tag = (document.activeElement as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement as HTMLElement | null)?.isContentEditable) return;

  const key = e.key;
  let dir: Dir | null = null;
  if (key === 'ArrowUp' || key === 'Up') dir = 'up';
  else if (key === 'ArrowDown' || key === 'Down') dir = 'down';
  else if (key === 'ArrowLeft' || key === 'Left') dir = 'left';
  else if (key === 'ArrowRight' || key === 'Right') dir = 'right';

  if (key === 'Enter' || key === 'OK' || key === 'Select' || key === ' ' || key === 'Spacebar') {
    const a = activeFocusable();
    if (a && a === document.activeElement) {
      e.preventDefault();
      a.click();
    }
    return;
  }
  if (key === 'Backspace' || key === 'Escape' || key === 'GoBack' || key === 'BrowserBack' || key === 'Back' || key === 'Go back') {
    e.preventDefault();
    dispatchBack();
    return;
  }

  if (!dir) return;
  e.preventDefault();

  const scope = getScope();
  const list = focusablesIn(scope);
  if (!list.length) return;
  let cur = activeFocusable();
  if (!cur || !scope.contains(cur) || !cur.hasAttribute('data-focusable')) {
    focusEl(list[0]);
    return;
  }
  const next = bestCandidate(dir, cur, list);
  if (next) focusEl(next);
  else scrollScope(dir, scope);
}

function onFocusIn(e: FocusEvent) {
  const t = e.target as HTMLElement | null;
  if (t && t.hasAttribute && t.hasAttribute('data-focusable')) currentEl = t;
}

/** 安装全局焦点系统（幂等）。由 main.tsx 在启动时调用。 */
export function initFocusNav() {
  if (installed) return;
  installed = true;
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('focusin', onFocusIn, true);
}

/** 聚焦某作用域内第一个可聚焦元素（页面/弹层打开后调用，把焦点带进新视图）。 */
export function focusFirstIn(scope?: HTMLElement | Document) {
  const root = scope || document;
  const list = focusablesIn((root as HTMLElement) || document.body);
  if (list.length) focusEl(list[0]);
}

/** 聚焦某个具体元素（供组件在切页/开弹层后主动把焦点放到目标上）。 */
export function focusElement(el: HTMLElement | null) {
  if (el) focusEl(el);
}
