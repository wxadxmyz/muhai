// V3.8.8 #3：应用内提示弹窗，替代 WebView 原生 alert。
//
// 原生 alert() 的按钮文字由 WebView 自己决定 —— 真机上恒为英文 "OK"，JS 层无法改动，
// 与本影视 App 的中文界面不一致。这里用应用内浮层实现同一能力：
//   · 按钮统一为中文「确定」
//   · 内容可选中、可长按复制（诊断报告 / 报错日志这类长文本正是靠这点兜底剪贴板不可用）
//   · 纯 DOM 命令式，无需 React Provider，任何模块 import 即用，不侵入组件树
export function showAlert(message: string, title = '提示'): Promise<void> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.62);padding:24px;';

    const box = document.createElement('div');
    box.style.cssText =
      'width:min(520px,92vw);max-height:80vh;display:flex;flex-direction:column;overflow:hidden;' +
      'background:#1b1b1f;border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.55);';

    const head = document.createElement('div');
    head.textContent = title;
    head.style.cssText =
      'padding:14px 16px;font-size:15px;font-weight:600;color:#fff;border-bottom:1px solid rgba(255,255,255,.08);';

    const body = document.createElement('div');
    body.textContent = message;
    body.style.cssText =
      'padding:14px 16px;overflow:auto;font-size:13px;line-height:1.65;color:#dcdcdc;' +
      'white-space:pre-wrap;word-break:break-word;user-select:text;-webkit-user-select:text;';

    const foot = document.createElement('div');
    foot.style.cssText = 'padding:10px 16px 14px;display:flex;justify-content:flex-end;';

    const btn = document.createElement('button');
    btn.textContent = '确定';
    btn.style.cssText =
      'padding:8px 24px;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-size:14px;cursor:pointer;';

    const close = () => {
      wrap.remove();
      resolve();
    };
    btn.onclick = close;
    // 点遮罩空白处也关闭，符合移动端习惯
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close();
    });

    foot.appendChild(btn);
    box.append(head, body, foot);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
  });
}
