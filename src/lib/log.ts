// Q3：统一调试日志开关——打包产物（生产构建）不再向终端吐调试信息，仅 dev 环境打印。
// 取代散落在 SearchView / js.ts / Live.tsx / hlsPlayer 等处的 console.* 调试残留。
// 用法：把 `console.log(x)` 换成 `devLog(x)`，生产构建里 import.meta.env.DEV 为 false，整行被摇树移除。
const dev = import.meta.env.DEV;

export const devLog = (...args: unknown[]): void => {
  if (dev) console.log(...args);
};

export const devWarn = (...args: unknown[]): void => {
  if (dev) console.warn(...args);
};

export const devError = (...args: unknown[]): void => {
  if (dev) console.error(...args);
};
