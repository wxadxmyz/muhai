import { useRef, useState } from 'react';
import { useSources } from '../store';
import { SubPage } from './SubPage';
import { fetchFromUrl, parsePasted } from '../lib/sourceFetch';
import { isValidShareCode, decodeSources } from '../lib/sharecode';
import { Icon } from './Icon';

// 「导入 json 源 / 导入 json 音源」全屏子页：配置地址自动抓取 + 本地文件 + 手动粘贴。
// 取代旧版的弹窗式导入。
export function ImportSourcePage({
  mediaType,
  onClose,
  onImported,
}: {
  mediaType: 'video' | 'music';
  onClose: () => void;
  onImported?: () => void;
}) {
  const store = useSources(mediaType);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [paste, setPaste] = useState('');
  const [status, setStatus] = useState<{ type: 'info' | 'ok' | 'err'; msg: string }>({ type: 'info', msg: '' });
  const [loading, setLoading] = useState(false);
  const [links, setLinks] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const doImport = (sources: any[]) => {
    if (!sources.length) {
      setStatus({ type: 'err', msg: '没有可导入的有效源（需包含 type 与 baseUrl/api）' });
      return;
    }
    const text = JSON.stringify(
      sources.map((s) => ({ ...s, name: s.name || name.trim() || s.api || s.baseUrl || '导入源' })),
    );
    const r = store.importSources(text);
    if (r.added > 0) {
      setStatus({ type: 'ok', msg: `已成功导入 ${r.added} 个源` });
      onImported?.();
    } else {
      setStatus({ type: 'err', msg: r.errors.join('；') || '导入失败' });
    }
  };

  const onFetch = async () => {
    if (!url.trim()) {
      setStatus({ type: 'err', msg: '请先填写配置地址' });
      return;
    }
    setLoading(true);
    setStatus({ type: 'info', msg: '正在抓取配置地址…' });
    setLinks([]);
    const res = await fetchFromUrl(url);
    setLoading(false);
    if (res.kind === 'sources') doImport(res.sources);
    else if (res.kind === 'links') {
      setLinks(res.links);
      setStatus({ type: 'info', msg: `识别到 ${res.links.length} 个可能的配置链接，请点选其中一个` });
    } else setStatus({ type: 'err', msg: res.message });
  };

  const onPickLink = async (link: string) => {
    setLoading(true);
    setStatus({ type: 'info', msg: '正在解析所选链接…' });
    const res = await fetchFromUrl(link);
    setLoading(false);
    if (res.kind === 'sources') doImport(res.sources);
    else if (res.kind === 'links') setLinks(res.links);
    else setStatus({ type: 'err', msg: res.message });
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      const r = parsePasted(text);
      if (r.sources.length) doImport(r.sources);
      else setStatus({ type: 'err', msg: r.error || '文件内容无法解析' });
    };
    reader.readAsText(f);
    e.target.value = '';
  };

  const onPasteImport = () => {
    if (isValidShareCode(paste)) {
      try {
        doImport(decodeSources(paste));
      } catch {
        setStatus({ type: 'err', msg: '分享码解析失败' });
      }
      return;
    }
    const r = parsePasted(paste);
    if (r.sources.length) doImport(r.sources);
    else setStatus({ type: 'err', msg: r.error || '无法解析，请检查内容格式' });
  };

  const title = mediaType === 'video' ? '导入 json 源' : '导入 json 音源';

  return (
    <SubPage
      title={title}
      onBack={onClose}
      right={loading ? <span className="muted sm">抓取中…</span> : undefined}
    >
      <div className="import-page">
        <label className="field-label">名称（可选）</label>
        <input
          className="text-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="留空则自动命名"
        />

        <label className="field-label">配置地址（支持 URL 自动抓取解析）</label>
        <div className="url-row">
          <input
            className="text-input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https:// 或 http:// 开头的源配置地址"
          />
          <button className="primary sm" onClick={onFetch} disabled={loading}>
            获取
          </button>
        </div>

        {links.length > 0 && (
          <div className="link-list">
            {links.map((l, i) => (
              <button key={i} className="link-item" onClick={() => onPickLink(l)} disabled={loading}>
                {l}
              </button>
            ))}
          </div>
        )}

        <div className="divider">
          <span>或</span>
        </div>

        <label className="field-label">本地文件</label>
        <button className="file-btn" onClick={() => fileRef.current?.click()}>
          <Icon name="folder" size={18} /> 选择本地 JSON 文件
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json,text/plain"
          style={{ display: 'none' }}
          onChange={onFile}
        />

        <div className="divider">
          <span>或</span>
        </div>

        <label className="field-label">手动粘贴（JSON 数组 / 单个源 / 分享码）</label>
        <textarea
          className="text-area"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder="粘贴源配置 JSON 或 MPS1. 开头的分享码"
          rows={5}
        />
        <button className="primary block" onClick={onPasteImport}>
          解析并导入
        </button>

        {status.msg && <div className={`import-status ${status.type}`}>{status.msg}</div>}
      </div>
    </SubPage>
  );
}
