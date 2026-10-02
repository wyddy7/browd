/**
 * Shows the next unseen notice (see `registry.ts`) when its trigger fires.
 *
 * Motion (auto-docs/for-frontend/motion-morph.md): the card grows out of the
 * control it is about and folds back into it. The box springs (`springBox.ts`:
 * position, size, radius), the text is never scaled — it is laid out at its
 * final width from the start and comes in out of a blur once the box is ~60 %
 * open, and goes out the same way before the fold. The control's icon is the
 * continuity anchor: it starts exactly over the control and rides into the
 * card's header (and back). `prefers-reduced-motion`: it just appears / goes.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FaSpider } from 'react-icons/fa';
import { FiX } from 'react-icons/fi';
import { noticesStore } from '@extension/storage';
import { NOTICES, type NoticeDef, type NoticeTrigger } from './registry';
import { type Box, EXPAND, FOLD, SpringBox } from './springBox';

/** A notice is a low, wide bar docked over the composer: two lines of text. */
const EDGE = 12;
const GAP = 8;
const PAD_X = 12;
const PAD_Y = 9;
const ROW = 22;
const ICON = 16;
const RADIUS = 10;

export function NoticeHost({ fire }: { fire: { trigger: NoticeTrigger; at: number } | null }) {
  const [notice, setNotice] = useState<NoticeDef | null>(null);

  useEffect(() => {
    if (!fire || notice) return;
    let cancelled = false;
    void (async () => {
      for (const n of NOTICES) {
        if (n.trigger !== fire.trigger) continue;
        if (await noticesStore.hasSeen(n.id)) continue;
        if (n.when && !(await n.when())) continue;
        if (!cancelled) setNotice(n);
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
    // Each fire is a new chance; a notice on screen stays until it is answered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fire]);

  if (!notice) return null;
  return <NoticeCard key={notice.id} notice={notice} onDone={() => setNotice(null)} />;
}

/** The control the notice is about, as a box; without one, a dot above the composer. */
function anchorBox(anchor?: string): Box {
  const el = anchor ? document.querySelector<HTMLElement>(`[data-notice-anchor="${anchor}"]`) : null;
  const r = el?.getBoundingClientRect();
  if (r && r.width > 0) return { x: r.left, y: r.top, w: r.width, h: r.height, r: 6 };
  return { x: innerWidth / 2 - 4, y: innerHeight - 120, w: 8, h: 8, r: 4 };
}

/** What the bar spans: the composer (`data-notice-dock`); without it, the panel's width. */
function dockBox(dock?: string): Box {
  const el = document.querySelector<HTMLElement>(`[data-notice-dock="${dock ?? 'composer'}"]`);
  const r = el?.getBoundingClientRect();
  if (r && r.width > 0) return { x: r.left, y: r.top, w: r.width, h: r.height, r: RADIUS };
  return { x: EDGE, y: innerHeight - 140, w: innerWidth - 2 * EDGE, h: 0, r: RADIUS };
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function NoticeCard({ notice, onDone }: { notice: NoticeDef; onDone: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spring = useRef<SpringBox | null>(null);
  /** The two ends of the current move: the control and the card. */
  const ends = useRef<{ control: Box; card: Box }>({ control: anchorBox(), card: anchorBox() });
  const leaving = useRef(false);
  // Laid out at its final width from the first frame (the text is never scaled during the morph).
  const [dock] = useState(() => dockBox(notice.dock));
  const width = dock.w;

  useLayoutEffect(() => {
    const boxEl = boxRef.current;
    const content = contentRef.current;
    if (!boxEl || !content) return;
    const control = anchorBox(notice.anchor);
    const h = content.offsetHeight;
    // Docked over the composer, its full width — not a card in a corner.
    const card: Box = { x: dock.x, y: Math.max(EDGE, dock.y - GAP - h), w: width, h, r: RADIUS };
    ends.current = { control, card };
    let textIn = false;

    const paint = (b: Box) => {
      boxEl.style.left = `${b.x}px`;
      boxEl.style.top = `${b.y}px`;
      boxEl.style.width = `${b.w}px`;
      boxEl.style.height = `${b.h}px`;
      boxEl.style.borderRadius = `${b.r}px`;
      // 0 = the box is the control, 1 = it is the card.
      const { control: c0, card: c1 } = ends.current;
      const open = Math.min(1, Math.max(0, (b.h - c0.h) / Math.max(1, c1.h - c0.h)));
      const icon = iconRef.current;
      if (icon) {
        const fromX = (c0.w - ICON) / 2;
        const fromY = (c0.h - ICON) / 2;
        icon.style.left = `${fromX + (PAD_X - fromX) * open}px`;
        icon.style.top = `${fromY + (PAD_Y + (ROW - ICON) / 2 - fromY) * open}px`;
      }
      if (!textIn && !leaving.current && open > 0.6) {
        textIn = true;
        content.animate(
          [
            { opacity: 0, filter: 'blur(6px)' },
            { opacity: 1, filter: 'blur(0px)' },
          ],
          { duration: 220, easing: 'ease-out', fill: 'forwards' },
        );
      }
    };

    if (reducedMotion()) {
      paint(card);
      content.style.opacity = '1';
      return;
    }
    const s = new SpringBox(control, paint);
    spring.current = s;
    paint(control);
    s.to(card, EXPAND);
    return () => s.stop();
  }, [notice, dock, width]);

  const close = async () => {
    if (leaving.current) return;
    leaving.current = true;
    await noticesStore.markSeen(notice.id).catch(() => {});
    const s = spring.current;
    const content = contentRef.current;
    const boxEl = boxRef.current;
    if (!s || !content || !boxEl || reducedMotion()) {
      onDone();
      return;
    }
    // Text out first, then the box folds back into the control (re-read: it may have moved or changed).
    content.animate(
      [
        { opacity: 1, filter: 'blur(0px)' },
        { opacity: 0, filter: 'blur(6px)' },
      ],
      { duration: 120, easing: 'ease-in', fill: 'forwards' },
    );
    await new Promise(r => setTimeout(r, 90));
    const control = anchorBox(notice.anchor);
    ends.current = { control, card: ends.current.card };
    s.to(control, FOLD, () => {
      boxEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: 'forwards' }).onfinish = onDone;
    });
  };

  return (
    <div
      ref={boxRef}
      data-testid="notice"
      data-notice-id={notice.id}
      role="dialog"
      aria-live="polite"
      aria-label={notice.title()}
      className="fixed z-50 overflow-hidden"
      style={{ background: 'hsl(var(--browd-surface-000))', boxShadow: 'var(--browd-shadow-menu)' }}>
      {notice.icon === 'spider' && (
        <div ref={iconRef} className="absolute text-[var(--browd-accent)]" style={{ width: ICON, height: ICON }}>
          <FaSpider className="size-4" />
        </div>
      )}
      <div
        ref={contentRef}
        className="absolute left-0 top-0"
        style={{ width, padding: `${PAD_Y}px ${PAD_X}px`, opacity: 0 }}>
        {/* Line 1: the title; the close button on the right is the only control. */}
        <div className="flex items-center gap-1.5" style={{ height: ROW }}>
          {notice.icon && <span className="shrink-0" style={{ width: ICON + 4 }} />}
          <span className="truncate font-medium text-[var(--browd-text)]" style={{ fontSize: 13 }}>
            {notice.title()}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            data-testid="notice-close"
            onClick={() => void close()}
            aria-label={notice.close()}
            title={notice.close()}
            className="browd-icon-button flex shrink-0 items-center justify-center"
            style={{ width: ROW, height: ROW }}>
            <FiX className="size-3.5" />
          </button>
        </div>
        {/* Line 2: one line of text. */}
        <div
          className="truncate text-[var(--browd-muted)]"
          style={{ fontSize: 'var(--browd-text-small)', lineHeight: '17px', paddingLeft: notice.icon ? ICON + 10 : 0 }}>
          {notice.body()}
        </div>
      </div>
    </div>
  );
}
