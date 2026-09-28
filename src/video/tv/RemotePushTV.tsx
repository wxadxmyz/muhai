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

export function RemotePushTV({ onClose, mode = 'source' }: { onClose?: () => void; mode?: 'source' | 'search' }) {
  const store = useSources('video');
  const [status, setStatus] = useState<Status>('loading');
  const [qr, setQr] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [info, setInfo] = useState<ListenerInfo | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await invoke<ListenerInfo>('start_push_listener');
        if (!alive) return;
        setInfo(r);
        const url = `https://${r.ip}:${r.port}/?token=${encodeURIComponent(r.token)}&type=${mode}`;
        setEndpoint(url);
        try { setQr(await QRCode.toDataURL(url, { width: 280, margin: 1 })); } catch { setQr(''); }
        setStatus('ready');
        poll(r.token);
      } catch {
        if (!alive) return;
        // 后端未实现 / 非 Tauri 环境：优雅降级，显示说明，不阻塞 TV 使用
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
              // 远程搜索：把提交的关键词回传给调用方（此处直接提示，SearchTV 可扩展监听）
              toast('已收到远程搜索请求：' + payload.slice(0, 20));
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
          <div className="status" style={{ color: 'var(--danger)' }}>后端推送服务未就绪</div>
          <div className="hint">
            当前构建未包含局域网推送后端（风险清单 #4，需在真机/盒子验证）。<br />
            添加源仍可在手机/电脑端完成：将源 JSON 导入后，通过「设置 → 同步」或同账号云盘共享到电视端；<br />
            后续版本将补齐 TV 端二维码 + 手机端承接页的端到端链路。
          </div>
        </>
      )}

      {onClose && (
        <button className="tv-action-btn" data-focusable="" onClick={onClose} style={{ marginTop: 8 }}>
          关闭
        </button>
      )}
    </div>
  );
}
