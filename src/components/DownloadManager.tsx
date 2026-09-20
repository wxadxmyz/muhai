import { useDownloads, downloadStore } from '../lib/downloads';
import { Icon } from './Icon';

/** 下载任务列表（标题与「清除已完成」由外层子页顶栏提供，此处只渲染内容）。 */
export function DownloadManager() {
  const tasks = useDownloads();
  return (
    <div className="view">
      <p className="muted sm dl-tip">下载进度实时显示；同源或允许跨域(CORS)的源会触发浏览器原生下载。不支持直接下载的源会标记为「失败」。</p>
      <div className="dl-list">
        {tasks.length === 0 && (
          <div className="empty">
            <span className="ic"><Icon name="download" size={48} /></span>
            <div className="big">还没有下载任务</div>
            <div className="sm">在搜索结果或详情页点「下载」即可</div>
          </div>
        )}
        {tasks.map((t) => (
          <div key={t.id} className={'dl-item' + (t.status === 'error' ? ' is-error' : '')}>
            <div className="dl-cover"><Icon name={t.item.mediaType === 'music' ? 'music' : 'play'} size={18} /></div>
            <div className="dl-meta">
              <div className="dl-title">{t.item.title}</div>
              <div className="dl-sub muted sm">
                {t.item.artist || t.item.sourceName} ·{' '}
                {t.status === 'done' ? '已完成' : t.status === 'error' ? '失败：' + (t.error ?? '未知错误') : t.status === 'downloading' ? '下载中…' : '等待中…'}
              </div>
              <div className="dl-bar"><span style={{ width: t.progress + '%' }} /></div>
            </div>
            <div className="dl-pct">{t.status === 'done' ? '完成' : t.progress + '%'}</div>
            <button className="dl-remove" onClick={() => downloadStore.remove(t.id)} aria-label="移除任务">
              <Icon name="x" size={16} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
