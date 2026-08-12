import { ReactNode } from 'react';
import { Icon } from './Icon';

/** 全屏子页面外壳：顶部返回箭头 + 标题，主体可滚动。 */
export function SubPage({
  title,
  onBack,
  children,
  right,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="fullpage">
      <div className="fullpage-head">
        <button className="icon" onClick={onBack} aria-label="返回">
          <Icon name="arrow-left" />
        </button>
        <h3>{title}</h3>
        {right}
      </div>
      <div className="fullpage-body">{children}</div>
    </div>
  );
}
