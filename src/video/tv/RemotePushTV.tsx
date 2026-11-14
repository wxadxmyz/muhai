// TV 扫码远程推送（清单 §3.7 / §3.8）：TV 端生成二维码（本机局域网 IP + 临时 token + 接收端点），
// 手机扫码 → 手机端网页/App 输入「名字 + 推送链接/JSON」→ 提交到 TV 端局域网接口 → TV 接收后写入 store。
//
// ⚠️ 接口边界（风险清单 #4）：真正的「局域网/云端 relay 推送」需要后端承接，无法在沙箱内验证，
// 此处前端先行、按契约实现，后端命令缺失时优雅降级（显示说明，不崩溃）。
// 约定后端提供三个 Tauri 命令（src-tauri 侧实现）：
//   - start_push_listener()                → { ip: string; port: number; token: string }
//   - poll_push_result({ token })           → string | null   （JSON 源数组、或搜索词文本）
//   - stop_push_listener({ token })         → void
// TV 出的二维码内容 = `https://{ip}:{port}/?token={token}&type={mode}`，
// 手机扫码打开承接页，把源 JSON 或搜索词 POST 回该端点即可被 poll 轮询到。
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { invoke } from '@tauri-apps/api/core';
import { useSources } from '../../store';
import { toast } from '../../lib/toast';

type Status = 'loading' | 'ready' | 'missing' | 'received';

interface ListenerInfo { ip: string; port: number; token: string; }

export function RemotePushTV({ onClose, mode = 'source', onSearch }: { onClose?: () => void; mode?: 'source' | 'search'; onSearch?: (q: string) => void }) {
  const store = useSources('video');
  const [status, setStatus] = useState<Status>('loading');
  const [qr, setQr] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [info, setInfo] = useState<ListenerInfo | null>(null);
  const [error, setError] = useState('');
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await invoke<ListenerInfo>('start_push_listener');
        if (!alive) return;
        setInfo(r);
        // V4.3.4：局域网服务走 http（LAN 无受信证书，https 在手机浏览器会被拦）
        const url = `http://${r.ip}:${r.port}/?token=${encodeURIComponent(r.token)}&type=${mode}`;
        setEndpoint(url);
        try { setQr(await QRCode.toDataURL(url, { width: 280, margin: 1 })); } catch { setQr(''); }
        setStatus('ready');
        poll(r.token);
      } catch (e: any) {
        if (!alive) return;
        // V4.3.5：把真实报错暴露出来（不再笼统显示「未就绪」），方便定位是权限/端口/网络策略。
        const msg = (e && (e.message || (typeof e === 'string' ? e : ''))) || '未知错误（请查看终端/日志）';
        setError(msg);
        setStatus('missing');
      }
    })();
    return () => { alive = false; if (timer.current) window.clearInterval(timer.current); try { if (info) invoke('stop_push_listener', { token: info.token }); } catch { /* ignore */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function poll(token: string) {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(async () => {
      try {
        const payload = await invoke<string | null>('poll_push_result', { token });
        if (payload) {
          try {
            if (mode === 'source') {
              const arr = JSON.parse(payload);
              if (Array.isArray(arr)) {
                const r = store.importSources(payload);
                toast(`已导入 ${r.added} 个源${r.skipped ? `，跳过 ${r.skipped} 个已存在` : ''}`);
              } else toast('收到的内容不是源数组');
            } else {
              // 远程搜索：把提交的关键词直接触发电视端搜索（切换到搜索页并展示结果）
              if (onSearch) onSearch(payload.trim());
              else toast('已收到远程搜索请求：' + payload.slice(0, 20));
            }
            if (timer.current) window.clearInterval(timer.current);
            setStatus('received');
          } catch (e: any) {
            toast('解析推送内容失败：' + (e?.message ?? e), 'err');
          }
        }
      } catch { /* 轮询失败静默重试 */ }
    }, 1500);
  }

  return (
    <div className="tv-push">
      <h2>{mode === 'source' ? '扫码添加影视源' : '远程搜索'}</h2>
      {status === 'loading' && <div className="status">正在启动局域网接收…</div>}

      {status === 'ready' && (
        <>
          <div className="qr">{qr ? <img src={qr} alt="扫码" /> : <div className="tv-empty">二维码生成失败</div>}</div>
          <div className="hint">
            用手机端 MuHai App 或浏览器扫描二维码，把影视源 JSON 提交到本机。<br />
            也可手动将源粘贴到承接页后回推。
          </div>
          <div className="status">等待接收…（endpoint 已就绪）</div>
        </>
      )}

      {status === 'received' && <div className="status">✓ 已接收并处理</div>}

      {status === 'missing' && (
        <>
          <div className="tv-push-icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
              <path d="M12 9v4M12 17h.01" />
            </svg>
          </div>
          <div className="status" style={{ color: 'var(--danger)' }}>后端推送服务未就绪</div>
          {error && (
            <div style={{ maxWidth: 560, color: 'var(--danger)', fontSize: 14, background: 'color-mix(in srgb, var(--danger) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', borderRadius: 10, padding: '10px 14px', textAlign: 'left', wordBreak: 'break-word', lineHeight: 1.6 }}>
              错误详情：{error}
            </div>
          )}
          <div className="hint">
            电视端已尝试在局域网起接收服务但失败了。你仍可用以下方式添加影视源：
          </div>
          <ul className="tv-push-tips">
            <li>手机 / 电脑端导入源 JSON，再经「设置 → 同步」或同账号云盘共享到电视端；</li>
            <li>把上面的错误详情发给我，我可针对性修复（多为 Android 监听端口权限问题）。</li>
          </ul>
        </>
      )}

      {onClose && (
        <button className="tv-action-btn" data-focusable="" data-autofocus="" onClick={onClose} style={{ marginTop: 8 }}>
          关闭
        </button>
      )}
    </div>
  );
}
