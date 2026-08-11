import { useDownloads, downloadStore } from '../lib/downloads';
import { Icon } from './Icon';

export function DownloadManager({ title = '下载管理' }: { title?: string }) {
  const tasks = useDownloads();
  return (
    <div className="view">
      <div className="page-title-row">
        <h2 className="page-title">{title}</h2>
        <button onClick={() => downloadStore.clearDone()}>清除已完成</button>
      </div>
      <p className="muted sm">下载进度实时显示；同源或允许跨域(CORS)的源会触发浏览器原生下载（Tauri WebView 走系统默认下载位置）。不支持直接下载的源会如实标记为「失败」，不再假装完成。</p>
      <div className="dl-list">
        {tasks.length === 0 && <div className="empty">还没有下载任务。在搜索结果或详情页点「下载」即可。</div>}
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
            <div className="dl-pct">{t.progress}%</div>
            <button className="link danger" onClick={() => downloadStore.remove(t.id)}>移除</button>
          </div>
        ))}
      </div>
    </div>
  );
}
