// V4.5.1 方案 C：详情页小窗与 TV 大屏播放器共用同一个 <video> DOM 节点。
//
// 目标（用户第 9 条）：小窗正在播放时确认进大屏，直接出画面、不重新加载；
// 大屏返回详情，小窗立马继续播。根因是旧架构两个独立 <video> 各自 attachHls，
// 切一次就重新解析+缓冲一次。共用同一节点后播放全程不中断。
//
// 实现方式：原生 DOM 搬运（appendChild），不走 React 重建。
//  - DetailTV 挂载时把小窗 video 注册进 bus，并记录它的原始父容器（小窗 slot）。
//  - 进大屏：VideoPlayer 把该 video append 到自己的 screen，videoRef 指向它，
//    跳过 ensureResolved/attachHls（流已在播），player.attachVideo 接管控制。
//  - 返回详情：VideoPlayer 卸载前把 video append 回原 slot，继续播。
//  bus 只存 DOM 引用与 key，不含 React 状态，避免跨组件 re-render 干扰。

export interface MiniVideoEntry {
  video: HTMLVideoElement;
  slot: HTMLElement;      // 小窗 video 的原始父容器（详情页里）
  key: string;            // `${sourceId}:${id}:${index}`，用于确认是同一集
}

let entry: MiniVideoEntry | null = null;

export function registerMiniVideo(e: MiniVideoEntry): void {
  entry = e;
}

export function getMiniVideo(): MiniVideoEntry | null {
  return entry;
}

export function clearMiniVideo(): void {
  entry = null;
}
