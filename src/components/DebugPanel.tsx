import { showAlert } from '../lib/dialog';
import { useState } from 'react';
import { useSyncExternalStore } from 'react';
import { debugLog, DebugEntry } from '../lib/debug';
import { getAllSpiderRaw } from '../engine/adapters/js';
import { buildMediaReport, clearMediaProbe, markMedia } from '../lib/mediaProbe';

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
  const [mediaCopied, setMediaCopied] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);

  // V3.6.8：复制「媒体链路诊断报告」。
  // 与上面的引擎日志互补——引擎日志只看得到搜索/详情，播放器的问题出在 Rust 侧代理，
  // 这份报告把「前端观察到的事件 + 代理侧的真实请求记录 + 累计计数」合在一起。
  const copyMediaReport = async () => {
    setMediaBusy(true);
    try {
      const text = await buildMediaReport();
      try {
        await navigator.clipboard.writeText(text);
        setMediaCopied(true);
        setTimeout(() => setMediaCopied(false), 1500);
      } catch {
        showAlert(text); // 剪贴板不可用（部分 WebView）→ 弹窗展示，用户长按复制
      }
    } finally {
      setMediaBusy(false);
    }
  };

  const clearMedia = async () => {
    await clearMediaProbe();
    markMedia('info', '已清空', '媒体链路记录已清空，复现一次后再复制报告');
  };

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
      showAlert(text);
    }
  };

  return (
    <div className="debug-body">
      <p className="muted sm">展示引擎每一次请求/响应/耗时，方便自己写影视源适配器时调试。</p>
      <p className="muted sm">搜索/首页空白时点「复制报错日志」，把内容发给开发者即可定位问题（无需电脑 ADB）。</p>

      <div className="debug-tools">
        <button className="btn sm" onClick={copySpiderLog}>{copied ? '已复制' : '复制报错日志'}</button>
        <button className="btn sm" onClick={() => setShowPreview((v) => !v)}>{showPreview ? '隐藏响应' : '显示响应'}</button>
        <button className="btn sm" onClick={() => debugLog.clear()}>清空</button>
      </div>

      {/* V3.6.8：播放链路诊断。播放器转圈/解码错误时点这里，把整份报告复制给开发者。 */}
      <div className="set-line" style={{ padding: '10px 0 4px', borderBottom: 'none' }}>
        <div>
          <div className="lbl">播放链路诊断</div>
          <div className="desc">
            点「复制诊断报告」，把「前端事件 + 本地代理真实请求记录 + 累计计数」一起复制出来。
            排查播放转圈 / 解码错误必用（先点「清空」，复现一次，再复制）。
          </div>
        </div>
      </div>
      <div className="debug-tools">
        <button className="btn sm" disabled={mediaBusy} onClick={copyMediaReport}>
          {mediaBusy ? '生成中…' : mediaCopied ? '已复制' : '复制诊断报告'}
        </button>
        <button className="btn sm" onClick={clearMedia}>清空链路记录</button>
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
