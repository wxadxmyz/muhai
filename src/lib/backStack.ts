// V3.3.5 B2：全局返回键栈式调度（back-handler stack）。
//
// 旧架构的病根：各页面/弹层各自挂 window.__onAndroidBack 单槽回调，挂载时保存 prev、
// 卸载时链式还原——层级一多（播放器横屏 → 选集浮层 → 设置面板）任意一环卸载顺序
// 不符合预期就断链：要么「一次返回关掉多层」，要么「返回无响应」。
// V3.3.4 补 epOpen 依赖就是这类补丁，属结构性脆弱。
//
// 新架构：返回键从栈顶逐层询问，谁消费谁拦截（handler 返回 true），
// 栈空才放行（false → 调用方走外层分级或交系统退出）。组件挂载 push、卸载 pop，
// 互不感知 prev，天然不会断链。

export type BackHandler = () => boolean; // true = 本次返回已被消费（拦截）；false = 不处理，继续问下一层

interface StackEntry {
  id: number;
  handler: BackHandler;
}

const stack: StackEntry[] = [];
let seq = 0;

/** 挂载时压栈；返回退栈函数（放在 useEffect 的 cleanup 里） */
export function pushBackHandler(handler: BackHandler): () => void {
  const id = ++seq;
  stack.push({ id, handler });
  return () => popBackHandler(id);
}

export function popBackHandler(id: number): void {
  const i = stack.findIndex((e) => e.id === id);
  if (i >= 0) stack.splice(i, 1);
}

/** 返回键统一入口：从栈顶逐层询问。返回 true=已消费（拦截），false=栈全不处理（放行） */
export function dispatchBack(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    try {
      if (stack[i].handler()) return true;
    } catch {
      // 抛异常的 handler 视为失效，弹出后继续问下一层，避免整条返回链卡死
      stack.splice(i, 1);
    }
  }
  return false;
}

/** 测试/调试：当前栈深 */
export function backStackDepth(): number {
  return stack.length;
}
