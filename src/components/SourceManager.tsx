import { useState } from 'react';
import { SourceConfig } from '../engine';
import { useSources } from '../store';
import { AddSourceModal } from './AddSourceModal';
import { encodeSources, decodeSources } from '../lib/sharecode';
import { Icon } from './Icon';

const TYPE_LABEL: Record<string, string> = {
  'music-json': '音乐 API',
  'video-cms': '影视站',
  alist: '云盘',
  tvbox: '影视仓',
  mock: '演示',
};

export function SourceManager({
  store,
  onOpenSettings,
  onOpenDebug,
}: {
  store: ReturnType<typeof useSources>;
  onOpenSettings?: () => void;
  onOpenDebug?: () => void;
}) {
  const { sources, add, remove, toggle, move, importSources, exportSources, test } = store;
  const [showModal, setShowModal] = useState(false);
  const [status, setStatus] = useState<Record<string, 'ok' | 'fail' | 'testing'>>({});
  const [msg, setMsg] = useState('');

  const sorted = [...sources].sort((a, b) => a.priority - b.priority);

  const runTest = async (cfg: SourceConfig) => {
    setStatus((s) => ({ ...s, [cfg.id]: 'testing' }));
    const ok = await test(cfg);
    setStatus((s) => ({ ...s, [cfg.id]: ok ? 'ok' : 'fail' }));
  };

  const doImportJson = () => {
    const text = window.prompt('粘贴音源 JSON 数组：');
    if (!text) return;
    const r = importSources(text);
    setMsg(`已导入 ${r.added} 个，${r.errors.join('；')}`);
  };

  const doImportShare = () => {
    const text = window.prompt('粘贴音源分享码（MPS1. 开头）：');
    if (!text) return;
    try {
      const list = decodeSources(text);
      if (list.length === 0) return setMsg('分享码中无有效音源');
      for (const s of list) store.add({ name: s.name, type: s.type, baseUrl: s.baseUrl, token: s.token, mountPath: s.extra?.mountPath });
      setMsg(`已从分享码导入 ${list.length} 个音源`);
    } catch (e: any) {
      setMsg('分享码解析失败：' + (e?.message ?? ''));
    }
  };

  const doExportShare = () => {
    const code = encodeSources(sources);
    navigator.clipboard?.writeText(code);
    setMsg('分享码已复制到剪贴板，可发给朋友');
  };

  const doExportJson = () => {
    navigator.clipboard?.writeText(exportSources());
    setMsg('音源 JSON 已复制到剪贴板');
  };

  return (
    <div className="view">
      <div className="page-title-row">
        <h2 className="page-title">仓库管理</h2>
        <div className="toolbar">
          <button className="primary" onClick={() => setShowModal(true)}><Icon name="plus" size={16} /> 添加音源</button>
          <button onClick={doImportJson}>导入JSON</button>
          <button onClick={doImportShare}>导入分享码</button>
          <button onClick={doExportShare}>导出分享码</button>
          <button onClick={doExportJson}>导出JSON</button>
          {onOpenDebug && <button onClick={onOpenDebug}><Icon name="bug" size={16} /> 调试</button>}
          {onOpenSettings && <button onClick={onOpenSettings}><Icon name="settings" size={16} /> 设置</button>}
        </div>
      </div>
      <p className="muted sm">自定义 API 源 · 支持音乐 JSON / 影视站(苹果CMS) / 云盘(alist)。拖拽排序决定搜索与播放优先级，连接正常时该行显示对勾。分享码可把音源一键发给朋友。</p>

      <table className="src-table">
        <thead>
          <tr>
            <th style={{ width: 40 }}>#</th>
            <th>名称</th>
            <th>类型</th>
            <th>地址</th>
            <th>连通</th>
            <th>启用</th>
            <th>排序</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((s, i) => (
            <tr key={s.id} className={s.enabled ? '' : 'disabled'}>
              <td>{i + 1}</td>
              <td className="src-name">{s.name}</td>
              <td><span className="badge">{TYPE_LABEL[s.type] ?? s.type}</span></td>
              <td className="url">{s.baseUrl || '—'}</td>
              <td>
                <button className="link" onClick={() => runTest(s)}>
                  {status[s.id] === 'testing' ? '测试中…' : status[s.id] === 'ok' ? <><Icon name="check" size={14} /> 通</> : status[s.id] === 'fail' ? <><Icon name="x-circle" size={14} /> 不通</> : '测试'}
                </button>
              </td>
              <td><input type="checkbox" checked={s.enabled} onChange={() => toggle(s.id)} /></td>
              <td>
                <button className="link" onClick={() => move(s.id, -1)} title="上移"><Icon name="arrow-up" size={16} /></button>
                <button className="link" onClick={() => move(s.id, 1)} title="下移"><Icon name="arrow-down" size={16} /></button>
              </td>
              <td><button className="link danger" onClick={() => remove(s.id)}>删除</button></td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr><td colSpan={8} className="empty">还没有音源，点「+ 添加音源」开始。</td></tr>
          )}
        </tbody>
      </table>

      <div className="hint-line">{msg}</div>

      {showModal && <AddSourceModal onSubmit={(f) => { add(f); setShowModal(false); }} onClose={() => setShowModal(false)} />}
    </div>
  );
}
