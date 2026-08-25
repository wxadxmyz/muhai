import { useState } from 'react';
import { useSyncExternalStore } from 'react';
import { debugLog, DebugEntry } from '../lib/debug';
import { getAllSpiderRaw } from '../engine/adapters/js';

function fmtTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function DebugPanel({ onClose }: { onClose: () => void }) {
  const entries = useSyncExternalStore(debugLog.subscribe, debugLog.get);
  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied] = useState(false);

  // v2.5.3：一键复制 spider 报错日志（绕开 ADB/鸿蒙无法直接 logcat 的限制）
  const copySpiderLog = async () => {
    const raw = getAllSpiderRaw();
    const lines: string[] = ['==== 幕海 spider 报错日志 ===='];
    const keys = Object.keys(raw);
    if (keys.length === 0) {
      lines.push('（暂无 spider 原始错误，去搜索/首页触发一次后再点此按钮）');
    } else {
      for (const k of keys) {
        lines.push(`\n--- 源 ${k} ---`);
        lines.push(raw[k]);
      }
    }
    // 附带最近的失败请求
    const fails = entries.filter((e) => !e.ok);
    if (fails.length) {
      lines.push('\n==== 最近失败请求 ====');
      for (const e of fails.slice(0, 20)) {
        lines.push(`[${fmtTime(e.ts)}] ${e.method} ${e.url} ${e.error ?? ''}`);
      }
    }
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用时退化为弹窗展示，用户可长按选择复制
      alert(text);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-debug" onClick={(e) => e.stopPropagation()}>
        <div className="dbg-head">
          <h3>开发者调试面板</h3>
          <div className="dbg-tools">
            <button onClick={copySpiderLog}>{copied ? '已复制' : '复制报错日志'}</button>
            <button onClick={() => setShowPreview((v) => !v)}>{showPreview ? '隐藏响应' : '显示响应'}</button>
            <button onClick={() => debugLog.clear()}>清空</button>
            <button className="primary" onClick={onClose}>关闭</button>
          </div>
        </div>
        <p className="muted sm">展示引擎每一次请求/响应/耗时，方便自己写音源适配器时调试。</p>
        <p className="muted sm">搜索/首页空白时点「复制报错日志」，把内容发给开发者即可定位问题（无需电脑 ADB）。</p>
        <div className="dbg-list">
          {entries.length === 0 && <div className="empty">暂无请求，去搜索或播放试试。</div>}
          {entries.map((e: DebugEntry) => (
            <div key={e.id} className="dbg-item">
              <div className="dbg-line1">
                <span className={'dbg-dot ' + (e.ok ? 'ok' : 'fail')} />
                <span className="dbg-method">{e.method}</span>
                <span className="dbg-url">{e.url}</span>
                <span className="dbg-meta">
                  {e.status ? `HTTP ${e.status} · ` : ''}
                  {e.durationMs}ms
                </span>
              </div>
              <div className="dbg-line2 muted sm">{fmtTime(e.ts)}{e.error ? ' · ' + e.error : ''}</div>
              {showPreview && e.preview && <pre className="dbg-preview">{e.preview}</pre>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
