import { useState } from 'react';
import { useSources } from '../store';
import { SubPage } from './SubPage';
import { Icon } from './Icon';
import { SourceConfig } from '../engine';
import { fetchFromUrl } from '../lib/sourceFetch';

// 「源列表 / 切换站点」全屏子页：纵向三行信息卡（名称+开关 / 地址 / 上移·下移·删除·调试）。
export function SourceListPage({
  mediaType,
  onClose,
  title = '仓库管理',
}: {
  mediaType: 'video' | 'music';
  onClose: () => void;
  title?: string;
}) {
  const store = useSources(mediaType);
  const [debugMsg, setDebugMsg] = useState<{ type: 'info' | 'ok' | 'err'; msg: string } | null>(null);

  const runDebug = async (s: SourceConfig) => {
    setDebugMsg({ type: 'info', msg: `正在检测「${s.name}」连通性…` });
    const res = await fetchFromUrl(s.baseUrl);
    if (res.kind === 'sources') setDebugMsg({ type: 'ok', msg: `「${s.name}」连通，识别到 ${res.sources.length} 个源` });
    else if (res.kind === 'links') setDebugMsg({ type: 'ok', msg: `「${s.name}」连通，识别到 ${res.links.length} 个链接` });
    else setDebugMsg({ type: 'err', msg: `「${s.name}」检测失败：${res.message}` });
  };

  return (
    <SubPage title={title} onBack={onClose}>
      {debugMsg && <div className={`import-status ${debugMsg.type}`}>{debugMsg.msg}</div>}

      {store.sources.length === 0 ? (
        <div className="empty-hint">
          <Icon name="list" size={40} />
          <p>还没有添加任何源</p>
          <span className="muted sm">请在设置中通过「导入 json 源」添加</span>
        </div>
      ) : (
        <div className="source-cards">
          {store.sources.map((s, i) => (
            <div key={s.id} className={`source-card ${s.enabled ? '' : 'off'}`}>
              <div className="sc-row-1">
                <div className="sc-name">{s.name}</div>
                <button
                  className={`switch ${s.enabled ? 'on' : ''}`}
                  onClick={() => store.toggle(s.id)}
                  title={s.enabled ? '已启用，点击停用' : '已停用，点击启用'}
                  aria-label="启用开关"
                />
              </div>
              <div className="sc-row-2">
                <span className="sc-url">{s.baseUrl}</span>
              </div>
              <div className="sc-row-3">
                <button
                  className="icon sm"
                  disabled={i === 0}
                  onClick={() => store.move(s.id, -1)}
                  title="上移"
                >
                  <Icon name="arrow-up" size={16} />
                </button>
                <button
                  className="icon sm"
                  disabled={i === store.sources.length - 1}
                  onClick={() => store.move(s.id, 1)}
                  title="下移"
                >
                  <Icon name="arrow-down" size={16} />
                </button>
                <button
                  className="icon sm danger"
                  onClick={() => store.remove(s.id)}
                  title="删除"
                >
                  <Icon name="trash" size={16} />
                </button>
                <button
                  className="icon sm"
                  onClick={() => runDebug(s)}
                  title="调试（检测连通性）"
                >
                  <Icon name="bug" size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </SubPage>
  );
}
