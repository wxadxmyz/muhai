import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';

interface Toast {
  id: number;
  text: string;
  type: 'info' | 'ok' | 'err';
}

const Ctx = createContext<{ push: (text: string, type?: Toast['type']) => void }>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const push = useCallback((text: string, type: Toast['type'] = 'info') => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, text, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  useEffect(() => { registerToast(push); return () => registerToast(() => {}); }, [push]);

  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);

// 全局 toast()：供非 hook 场景（事件回调、异步投屏结果等）直接调用。
// 通过自定义事件派发给 ToastProvider 内的监听器；未挂载 Provider 时静默丢弃。
let pushFn: ((text: string, type?: Toast['type']) => void) | null = null;
export function toast(text: string, type: Toast['type'] = 'info') {
  if (pushFn) pushFn(text, type);
}

// ToastProvider 挂载时注册全局推送函数（供 toast() 使用）。
export function registerToast(fn: (text: string, type?: Toast['type']) => void) {
  pushFn = fn;
}
