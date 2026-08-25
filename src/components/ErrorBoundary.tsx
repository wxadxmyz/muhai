import { Component, ReactNode } from 'react';
import { debugLog } from '../lib/debug';

interface Props {
  children: ReactNode;
  /** 区域名，用于报错时定位（如 "搜索页" / "直播页"） */
  name?: string;
  fallback?: (err: Error, reset: () => void) => ReactNode;
}
interface State {
  error: Error | null;
}

// 局部错误边界：隔离单个区域的渲染异常，避免一个组件崩溃拖垮整页白屏。
// v2.5.5 修复：此前 SearchView 缺 useRef 导入导致整页白屏且调试面板无法弹出，
// 加边界后单区域崩溃只显示该区域的错误提示，其余 UI（含调试面板）仍可正常使用。
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // 同时打到 console，方便通过 WebView console / logcat 抓取真实报错
    console.error(`[ErrorBoundary${this.props.name ? ':' + this.props.name : ''}]`, error, info);
    // 写入调试日志：即使该区域白屏点不到调试按钮，也能从主页调试面板看到具体崩溃原因
    debugLog.record({
      method: 'RENDER',
      url: `[${this.props.name || '页面'}] 渲染崩溃`,
      ok: false,
      durationMs: 0,
      error: (error?.message || String(error)) + (info ? ' · ' + String((info as any)?.componentStack || info) : ''),
    });
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div
        style={{
          margin: '16px',
          padding: '18px',
          borderRadius: '14px',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
          {this.props.name || '页面'}加载出错
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6, margin: '0 0 12px', wordBreak: 'break-all' }}>
          {error.message}
        </p>
        <button
          onClick={this.reset}
          style={{
            padding: '9px 18px',
            borderRadius: '18px',
            border: '1px solid var(--accent)',
            background: 'var(--accent)',
            color: '#fff',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          重试
        </button>
      </div>
    );
  }
}
