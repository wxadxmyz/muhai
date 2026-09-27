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

// V3.8.9 #B1：应用内输入弹窗，替代 WebView 原生 prompt。
// 原生 prompt() 的按钮同样是 WebView 决定的英文 "Cancel"/"OK"，且只有一个单行输入框，
// 粘贴多行 JSON 源/分享码时极难用。这里用与 showAlert 同一套浮层实现：
//   · 按钮统一为中文「取消 / 确定」
//   · 多行 textarea（影视源 JSON 与分享码都是多行长文本，单行 input 根本没法用）
//   · 字号 16px：低于 16px 时 iOS Safari 聚焦会自动放大页面，弹窗会被顶变形
//   · 点遮罩 / 取消 → resolve(null)，与原生 prompt 取消返回 null 的语义一致
export function showPrompt(
  title: string,
  hint = '',
  defaultValue = ''
): Promise<string | null> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.62);padding:20px;';

    const box = document.createElement('div');
    box.style.cssText =
      'width:min(560px,94vw);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;' +
      'background:#1b1b1f;border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.55);';

    const head = document.createElement('div');
    head.textContent = title;
    head.style.cssText =
      'padding:14px 16px;font-size:15px;font-weight:600;color:#fff;border-bottom:1px solid rgba(255,255,255,.08);';

    const ta = document.createElement('textarea');
    ta.value = defaultValue;
    ta.placeholder = '在此粘贴内容…';
    ta.spellcheck = false;
    ta.style.cssText =
      'margin:12px 16px;padding:10px 12px;min-height:150px;resize:vertical;' +
      'background:#121215;border:1px solid rgba(255,255,255,.14);border-radius:8px;' +
      'color:#e8e8e8;font-size:16px;line-height:1.5;font-family:monospace;outline:none;';

    const foot = document.createElement('div');
    foot.style.cssText = 'padding:10px 16px 14px;display:flex;justify-content:flex-end;gap:10px;';

    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.style.cssText =
      'padding:8px 20px;border:1px solid rgba(255,255,255,.18);border-radius:8px;' +
      'background:transparent;color:#c8c8c8;font-size:14px;cursor:pointer;';

    const ok = document.createElement('button');
    ok.textContent = '确定';
    ok.style.cssText =
      'padding:8px 24px;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-size:14px;cursor:pointer;';

    const done = (v: string | null) => {
      wrap.remove();
      resolve(v);
    };
    ok.onclick = () => done(ta.value);
    cancel.onclick = () => done(null);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) done(null);
    });

    const parts: HTMLElement[] = [head];
    if (hint) {
      const h = document.createElement('div');
      h.textContent = hint;
      h.style.cssText =
        'padding:10px 16px 0;font-size:12px;line-height:1.6;color:#9a9a9a;white-space:pre-wrap;';
      parts.push(h);
    }
    parts.push(ta, foot);
    foot.append(cancel, ok);
    box.append(...parts);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
    ta.focus();
  });
}
