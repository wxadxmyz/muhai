import { useState } from 'react';
import { useSyncExternalStore } from 'react';
import { debugLog, DebugEntry } from '../lib/debug';

function fmtTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function DebugPanel({ onClose }: { onClose: () => void }) {
  const entries = useSyncExternalStore(debugLog.subscribe, debugLog.get);
  const [showPreview, setShowPreview] = useState(false);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-debug" onClick={(e) => e.stopPropagation()}>
        <div className="dbg-head">
          <h3>开发者调试面板</h3>
          <div className="dbg-tools">
            <button onClick={() => setShowPreview((v) => !v)}>{showPreview ? '隐藏响应' : '显示响应'}</button>
            <button onClick={() => debugLog.clear()}>清空</button>
            <button className="primary" onClick={onClose}>关闭</button>
          </div>
        </div>
        <p className="muted sm">展示引擎每一次请求/响应/耗时，方便自己写音源适配器时调试。</p>
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
