import { useSources } from '../store';
import { SubPage } from './SubPage';
import { Icon } from './Icon';
import { SourceConfig } from '../engine';

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

  return (
    <SubPage title={title} onBack={onClose}>

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
                  className="action-chip"
                  disabled={i === 0}
                  onClick={() => store.move(s.id, -1)}
                >
                  上移
                </button>
                <button
                  className="action-chip"
                  disabled={i === store.sources.length - 1}
                  onClick={() => store.move(s.id, 1)}
                >
                  下移
                </button>
                <button
                  className="action-chip danger"
                  onClick={() => store.remove(s.id)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </SubPage>
  );
}
