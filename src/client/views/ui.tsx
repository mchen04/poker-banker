import { useLayoutEffect, useRef, type ReactNode } from 'react';

export function FitText({ text, className = '', as: Tag = 'span', testId, min = 11, refit }: { text: string; className?: string; as?: 'span' | 'strong' | 'b'; testId?: string; min?: number; refit?: boolean | string }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const fit = () => {
      element.style.fontSize = '';
      element.classList.remove('fit-wrap');
      const available = element.clientWidth;
      if (!available || element.scrollWidth <= available) return;
      let size = Number.parseFloat(getComputedStyle(element).fontSize);
      for (let attempt = 0; attempt < 6 && element.scrollWidth > element.clientWidth && size > min; attempt++) {
        size = Math.max(min, Math.floor(size * element.clientWidth / element.scrollWidth * 10 - 1) / 10);
        element.style.fontSize = `${size}px`;
      }
      if (element.scrollWidth > element.clientWidth) element.classList.add('fit-wrap');
    };
    fit();
    const root = element.closest('li, .player-card, .totals, dl, .report-summary, .sheet, .workspace') ?? element.parentElement;
    let last = -1;
    const observer = typeof ResizeObserver === 'undefined' || !root ? null : new ResizeObserver(entries => { const width = Math.round(entries[0]!.contentRect.width); if (width !== last) { last = width; fit(); } });
    if (root) observer?.observe(root);
    return () => observer?.disconnect();
  }, [text, min, refit]);
  return <Tag ref={ref as never} className={`fit-text ${className}`} data-testid={testId}>{text}</Tag>;
}

function Svg({ children }: { children: ReactNode }) {
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{children}</svg>;
}
export const PlusIcon = () => <Svg><path d="M12 5v14M5 12h14" /></Svg>;
export const MoreIcon = () => <Svg><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></Svg>;
export const ChevronDownIcon = () => <Svg><path d="m6 9 6 6 6-6" /></Svg>;
export const ChevronLeftIcon = () => <Svg><path d="m15 18-6-6 6-6" /></Svg>;
export const ChevronRightIcon = () => <Svg><path d="m9 6 6 6-6 6" /></Svg>;
export const CloseIcon = () => <Svg><path d="M18 6 6 18M6 6l12 12" /></Svg>;
export const TrashIcon = () => <Svg><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></Svg>;

export function TableSkeleton() {
  return <div className="session-board skeleton" aria-busy="true" aria-label="Loading session" data-testid="table-skeleton">
    <div className="session-overview">
      <div className="session-heading"><div className="session-heading-text"><div className="skeleton-line skeleton-title" /><div className="skeleton-line skeleton-meta" /></div><div className="session-heading-actions"><span className="icon-button skeleton-block" /><span className="icon-button skeleton-block" /></div></div>
      <div className="totals skeleton-card">{[0, 1, 2].map(index => <div key={index}><div className="skeleton-line skeleton-label" /><div className="skeleton-line skeleton-amount" /></div>)}<div className="chip-history"><div className="skeleton-line skeleton-small" /></div></div>
    </div>
    <div className="session-table"><div className="section-heading"><div className="skeleton-line skeleton-heading" /></div><div className="players">{[0, 1, 2].map(index => <div className="player-card skeleton-row" key={index}><div className="player-row"><span className="player-name"><span className="skeleton-line skeleton-name" /><span className="skeleton-line skeleton-small" /></span></div></div>)}</div></div>
  </div>;
}
export function RowsSkeleton({ rows = 4 }: { rows?: number }) {
  return <ul className="roster-list skeleton" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, index) => <li key={index}><div className="roster-row"><span className="roster-name"><span className="skeleton-line skeleton-name" /></span><span className="skeleton-line skeleton-amount-small" /></div></li>)}</ul>;
}
