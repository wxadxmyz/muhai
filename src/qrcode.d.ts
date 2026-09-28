// qrcode 库未随包提供类型声明，这里补最小声明以通过 tsc。
// 仅覆盖本仓库实际使用到的 API（默认导出的 toDataURL）。
declare module 'qrcode' {
  type QRCodeToDataURLOptions = {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    scale?: number;
    width?: number;
    color?: { dark?: string; light?: string };
  };
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
  const _default: { toDataURL: typeof toDataURL };
  export default _default;
}
