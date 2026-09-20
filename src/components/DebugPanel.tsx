import { useState } from 'react';
import { useSyncExternalStore } from 'react';
import { debugLog, DebugEntry } from '../lib/debug';
import { getAllSpiderRaw } from '../engine/adapters/js';

function fmtTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/**
 * 开发者调试面板（#11：从悬浮 FAB / 模态改为「设置页 → 检查更新下方」的内联子页）。
 * 布局对齐原型 debug 浮层：提示文案 + 小按钮行（复制报错日志 / 显示响应 / 清空）+ .set-list 日志行。
 * 标题栏与返回由外层 <SubPage> 提供，这里只渲染主体。
 */
export function DebugPanel() {
  const entries = useSyncExternalStore(debugLog.subscribe, debugLog.get);
  const [showPreview, setShowPreview] = useState(false);
  const [copied, setCopied] = useState(false);

  // 一键复制 spider 报错日志（绕开 ADB/鸿蒙无法直接 logcat 的限制）
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
    <div className="debug-body">
      <p className="muted sm">展示引擎每一次请求/响应/耗时，方便自己写音源适配器时调试。</p>
      <p className="muted sm">搜索/首页空白时点「复制报错日志」，把内容发给开发者即可定位问题（无需电脑 ADB）。</p>

      <div className="debug-tools">
        <button className="btn sm" onClick={copySpiderLog}>{copied ? '已复制' : '复制报错日志'}</button>
        <button className="btn sm" onClick={() => setShowPreview((v) => !v)}>{showPreview ? '隐藏响应' : '显示响应'}</button>
        <button className="btn sm" onClick={() => debugLog.clear()}>清空</button>
      </div>

      <div className="set-list debug-list">
        {entries.length === 0 && <div className="empty">暂无请求，去搜索或播放试试。</div>}
        {entries.map((e: DebugEntry) => (
          <div className="dbg-entry" key={e.id}>
            <div className="set-line">
              <span
                className={'val dbg-dot ' + (e.ok ? 'ok' : 'fail')}
                style={{ color: e.ok ? 'var(--ok)' : 'var(--danger)' }}
              >●</span>
              <span className="lbl" style={{ fontSize: 12, fontWeight: 500 }}>{e.method} {e.url}</span>
              <span className="muted sm">
                {e.status ? `HTTP ${e.status} · ` : ''}{e.durationMs}ms
              </span>
            </div>
            <div className="muted sm dbg-ts">{fmtTime(e.ts)}{e.error ? ' · ' + e.error : ''}</div>
            {showPreview && e.preview && <pre className="dbg-preview">{e.preview}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}
