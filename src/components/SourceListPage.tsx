import { useState } from 'react';
import { useSources } from '../store';
import { SubPage } from './SubPage';
import { AddSourceModal } from './AddSourceModal';
import { Icon } from './Icon';
import { SourceConfig } from '../engine';

// 「源列表 / 切换站点」全屏子页：卡片式列表（去掉类型行），支持启用 / 置顶 / 编辑 / 删除。
export function SourceListPage({
  mediaType,
  onClose,
  title = '源列表',
}: {
  mediaType: 'video' | 'music';
  onClose: () => void;
  title?: string;
}) {
  const store = useSources(mediaType);
  const [editTarget, setEditTarget] = useState<SourceConfig | null>(null);

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
              <div className="sc-main" onClick={() => store.toggle(s.id)}>
                <div className="sc-name">{s.name}</div>
                <div className="sc-url">{s.baseUrl}</div>
              </div>
              <div className="sc-actions">
                <button
                  className="icon sm"
                  title="置顶"
                  disabled={i === 0}
                  onClick={() => store.move(s.id, -1)}
                >
                  <Icon name="arrow-up" size={16} />
                </button>
                <button className="icon sm" title="编辑" onClick={() => setEditTarget(s)}>
                  <Icon name="sliders" size={16} />
                </button>
                <button className="icon sm danger" title="删除" onClick={() => store.remove(s.id)}>
                  <Icon name="trash" size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editTarget && (
        <AddSourceModal
          initial={{
            name: editTarget.name,
            type: editTarget.type,
            baseUrl: editTarget.baseUrl,
            token: editTarget.token,
            mountPath: editTarget.extra?.mountPath,
          }}
          onClose={() => setEditTarget(null)}
          onSubmit={(form) => {
            store.update(editTarget.id, {
              name: form.name,
              type: form.type,
              baseUrl: form.baseUrl,
              token: form.token,
              extra: form.mountPath ? { mountPath: form.mountPath } : editTarget.extra,
            });
            setEditTarget(null);
          }}
        />
      )}
    </SubPage>
  );
}
