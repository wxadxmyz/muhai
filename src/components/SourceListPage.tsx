import { useSources } from '../store';
import { SubPage } from './SubPage';
import { Icon } from './Icon';
import { SourceConfig } from '../engine';

// 「源列表 / 切换站点」全屏子页：纵向三行信息卡（名称+开关 / 地址 / 上移·下移·删除·调试）。
export function SourceListPage({
  mediaType,
  onClose,
  title = '仓库管理',
  onAddSource,
}: {
  mediaType: 'video' | 'music';
  onClose: () => void;
  title?: string;
  onAddSource?: () => void;
}) {
  const store = useSources(mediaType);

  return (
    <SubPage title={title} onBack={onClose}>

      {store.sources.length === 0 ? (
        <div className="empty">
          <span className="ic"><Icon name="cast" size={48} /></span>
          <div className="big">还没有添加任何源</div>
          <div className="sm">请在设置中通过「导入 json 源」添加</div>
        </div>
      ) : (
        <div className="source-cards">
          {store.sources.map((s, i) => (
            <div key={s.id} className={`source-card ${s.enabled ? '' : 'off'}`}>
              <div className="sc-row-1">
                <span className="sc-ic"><Icon name="cast" size={22} /></span>
                <div className="sc-head">
                  <div className="sc-name">{s.name}</div>
                  <div className="sc-url">{s.baseUrl}</div>
                </div>
                <button
                  className={`switch ${s.enabled ? 'on' : ''}`}
                  onClick={() => store.toggle(s.id)}
                  title={s.enabled ? '已启用，点击停用' : '已停用，点击启用'}
                  aria-label="启用开关"
                />
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
      {onAddSource && (
        <button className="primary block add-source-btn" onClick={onAddSource}>
          <Icon name="plus" size={18} /> 新增源
        </button>
      )}
    </SubPage>
  );
}
