/// <reference types="vite/client" />

// #15 版本号自动化：构建期由 vite.config.ts 从 package.json 注入。
// 注意：本文件含顶层 import，已是模块，须用 declare global 才能声明全局常量。
declare global {
  const __APP_VERSION__: string;
}

// V3.5.3：补齐历史遗留的 Tauri 窗口返回键监听类型。
// 代码里用 getCurrentWindow().onBackButton(cb) 监听安卓返回键，
// 但当前 @tauri-apps/api 版本已在类型层移除了该方法（迁到 app.onBackButtonPress）。
// 这里是运行期兼容调用，仅补类型声明消除 tsc 报错，不改运行时行为。
import type { Window } from '@tauri-apps/api/window';

declare module '@tauri-apps/api/window' {
  interface Window {
    /** 安卓返回键监听（运行期由 Tauri 注入；类型层已迁走，此处补声明） */
    onBackButton(handler: (event: { preventDefault: () => void }) => void): Promise<() => void>;
  }
}
