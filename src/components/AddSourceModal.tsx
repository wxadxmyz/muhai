import { useState } from 'react';
import { SOURCE_TYPES, SourceType } from '../engine';
import { SourceForm } from '../store';

export function AddSourceModal({
  onSubmit,
  onClose,
  initial,
}: {
  onSubmit: (form: SourceForm) => void;
  onClose: () => void;
  initial?: Partial<SourceForm>;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState<SourceType>(initial?.type ?? 'music-json');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [token, setToken] = useState(initial?.token ?? '');
  const [mountPath, setMountPath] = useState(initial?.mountPath ?? '/');

  const PLACEHOLDER: Record<SourceType, string> = {
    'music-json': 'https://your-music-api.com',
    'video-cms': 'https://your-video-cms.com',
    alist: 'https://your-alist.com',
    mock: '',
  };

  const submit = () => {
    if (!name.trim() || (type !== 'mock' && !baseUrl.trim())) return;
    onSubmit({
      name: name.trim(),
      type,
      baseUrl: baseUrl.trim(),
      token: token.trim() || undefined,
      mountPath: type === 'alist' ? mountPath.trim() || '/' : undefined,
    });
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? '编辑音源' : '添加音源'}</h3>

        <label>名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：我的阿里云盘" />

        <label>类型</label>
        <select value={type} onChange={(e) => setType(e.target.value as SourceType)}>
          {SOURCE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label} — {t.desc}
            </option>
          ))}
        </select>

        {type !== 'mock' && (
          <>
            <label>接口地址 (Base URL)</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={PLACEHOLDER[type]} />
          </>
        )}

        {type === 'alist' && (
          <>
            <label>Token（alist 管理 Token，可选）</label>
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="alist-..." />
            <label>挂载目录</label>
            <input value={mountPath} onChange={(e) => setMountPath(e.target.value)} placeholder="/影视" />
            <p className="muted sm">提示：也可在 alist 网页端用「扫码 / Token」登录各家网盘后，把 Token 填在此处。</p>
          </>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={submit}>保存</button>
        </div>
      </div>
    </div>
  );
}
