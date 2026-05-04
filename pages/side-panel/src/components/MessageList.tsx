import type { Message } from '@extension/storage';
import { ACTOR_PROFILES } from '../types/message';
import { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

interface MessageListProps {
  messages: Message[];
  isDarkMode?: boolean;
  /** T2f-final-3 — open the in-panel screenshot lightbox. SidePanel hosts the actual modal. */
  onThumbClick?: (url: string) => void;
  /**
   * T2f-clean-finish — index of the first message in the currently-running
   * task's slice. Thinking groups whose first item index >= this value are
   * the LIVE run and start expanded so the user sees progress; older groups
   * are historical and stay collapsed.
   * `null` = no live run (task finished or not started). Used together with
   * `collapseSignal`: every TASK_OK / TASK_FAIL / TASK_CANCEL increments the
   * signal so live thinking groups auto-collapse on completion.
   */
  liveRunStartIdx?: number | null;
  collapseSignal?: number;
}

// T2f-thinking-split: group consecutive 'thinking' messages into a
// single collapsible <details> block so the chat shows one tidy
// "Thinking N steps" affordance instead of a wall of intermediate
// Planner reasoning + Navigator action logs + screenshot thumbnails.
// Final answer / user input / pre-T2f-thinking-split messages render
// outside, full-width, like before.
type Group =
  | { kind: 'thinking'; items: Array<{ msg: Message; index: number }> }
  | { kind: 'plain'; msg: Message; index: number };

function groupMessages(messages: Message[]): Group[] {
  const out: Group[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.phase === 'thinking') {
      const last = out[out.length - 1];
      if (last && last.kind === 'thinking') {
        last.items.push({ msg: m, index: i });
      } else {
        out.push({ kind: 'thinking', items: [{ msg: m, index: i }] });
      }
    } else {
      out.push({ kind: 'plain', msg: m, index: i });
    }
  }
  return out;
}

export default memo(function MessageList({
  messages,
  onThumbClick,
  liveRunStartIdx = null,
  collapseSignal = 0,
}: MessageListProps) {
  const groups = groupMessages(messages);
  return (
    <div className="max-w-full space-y-4">
      {groups.map((g, gi) => {
        if (g.kind === 'thinking') {
          const groupFirstIdx = g.items[0].index;
          const isLive = liveRunStartIdx !== null && groupFirstIdx >= liveRunStartIdx;
          return (
            <ThinkingGroup
              key={`thinking-${gi}-${groupFirstIdx}`}
              items={g.items}
              isLive={isLive}
              collapseSignal={collapseSignal}
              onThumbClick={onThumbClick}
            />
          );
        }
        const prev = g.index > 0 ? messages[g.index - 1] : null;
        const isSameActor = prev?.phase !== 'thinking' && prev?.actor === g.msg.actor;
        return (
          <MessageBlock
            key={`${g.msg.actor}-${g.msg.timestamp}-${g.index}`}
            message={g.msg}
            isSameActor={Boolean(isSameActor)}
            onThumbClick={onThumbClick}
          />
        );
      })}
    </div>
  );
});

/**
 * T2f-clean-finish — collapsible thinking group with live/historical
 * states. Live groups (current run) start expanded so the user can
 * watch progress; on TASK_OK the parent increments `collapseSignal`
 * which triggers an auto-close. Historical groups (previous runs)
 * default closed. User can always toggle manually after the initial
 * mount; the auto-close fires once per signal change.
 */
function ThinkingGroup({
  items,
  isLive,
  collapseSignal,
  onThumbClick,
}: {
  items: Array<{ msg: Message; index: number }>;
  isLive: boolean;
  collapseSignal: number;
  onThumbClick?: (url: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(isLive);
  const lastSignalRef = useRef(collapseSignal);

  // Sync open-state when group transitions from historical→live (rare,
  // happens if a brand new run reuses an existing thinking key).
  useEffect(() => {
    if (isLive) setIsOpen(true);
  }, [isLive]);

  // Auto-collapse on every TASK_OK / TASK_FAIL / TASK_CANCEL — the
  // parent increments collapseSignal. We only act when the signal
  // changes (not on first mount with the same value).
  useEffect(() => {
    if (collapseSignal !== lastSignalRef.current) {
      lastSignalRef.current = collapseSignal;
      setIsOpen(false);
    }
  }, [collapseSignal]);

  const handleToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    setIsOpen(e.currentTarget.open);
  };

  return (
    <details className="browd-thinking-group text-sm" open={isOpen} onToggle={handleToggle}>
      <summary className="browd-thinking-summary flex cursor-pointer select-none items-center gap-2 text-[var(--browd-muted)] hover:text-[var(--browd-text)] transition-colors">
        <span className="browd-thinking-chevron">⌄</span>
        <span>
          Thinking — {items.length} step{items.length === 1 ? '' : 's'}
        </span>
      </summary>
      <div className="browd-thinking-body mt-2 space-y-3 pl-3">
        {items.map((it, idx) => (
          <MessageBlock
            key={`t-${it.msg.actor}-${it.msg.timestamp}-${it.index}`}
            message={it.msg}
            isSameActor={idx > 0 ? items[idx - 1].msg.actor === it.msg.actor : false}
            onThumbClick={onThumbClick}
          />
        ))}
      </div>
    </details>
  );
}

interface MessageBlockProps {
  message: Message;
  isSameActor: boolean;
  onThumbClick?: (url: string) => void;
}

function MessageBlock({ message, isSameActor, onThumbClick }: MessageBlockProps) {
  if (!message.actor) {
    console.error('No actor found');
    return <div />;
  }
  const actor = ACTOR_PROFILES[message.actor as keyof typeof ACTOR_PROFILES];
  const isProgress = message.content === 'Showing progress...';
  const isFinal = message.phase === 'final';

  return (
    <div
      className={`flex max-w-full gap-3 ${
        !isSameActor ? 'mt-4 border-t border-[var(--browd-border)] pt-4 first:mt-0 first:border-t-0 first:pt-0' : ''
      } ${isFinal ? 'browd-final-answer' : ''}`}>
      {!isSameActor && (
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: actor.iconBackground }}>
          <img src={actor.icon} alt={actor.name} className="size-6" />
        </div>
      )}
      {isSameActor && <div className="w-8" />}

      <div className="min-w-0 flex-1">
        {!isSameActor && (
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--browd-text)]">
            <span>{actor.name}</span>
            {isFinal && (
              <span className="browd-final-badge text-[10px] font-medium uppercase tracking-wider opacity-80">
                Answer
              </span>
            )}
          </div>
        )}

        <div className="space-y-0.5">
          {Array.isArray(message.planItems) && message.planItems.length > 0 ? (
            <PlanChecklist items={message.planItems} />
          ) : (
            <div
              className={`browd-markdown break-words leading-6 ${
                isFinal ? 'text-[15px] text-[var(--browd-text)]' : 'text-sm text-[var(--browd-muted)]'
              }`}>
              {isProgress ? (
                <div className="h-1 overflow-hidden rounded bg-[var(--browd-panel-strong)]">
                  <div className="browd-progress h-full animate-progress" />
                </div>
              ) : (
                <ReactMarkdown
                  components={{
                    // Anchors open in a new tab so the agent's chat
                    // doesn't get hijacked when the user clicks.
                    a: ({ href, children, ...props }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                        {children}
                      </a>
                    ),
                    // Inline code stays inline; block code gets a
                    // soft surface so it stands out without a hard
                    // border (matches the Anthropic-style minimalism
                    // we settled on for thinking/trace).
                    code: ({ className, children, ...props }) => {
                      const isBlock = (className ?? '').includes('language-');
                      return isBlock ? (
                        <code className={`browd-code-block ${className ?? ''}`} {...props}>
                          {children}
                        </code>
                      ) : (
                        <code className="browd-code-inline" {...props}>
                          {children}
                        </code>
                      );
                    },
                  }}>
                  {message.content}
                </ReactMarkdown>
              )}
            </div>
          )}
          {message.imageThumbBase64 ? (
            <ScreenshotThumb
              base64={message.imageThumbBase64}
              mime={message.imageThumbMime ?? 'image/jpeg'}
              fullBase64={message.imageFullBase64}
              fullMime={message.imageFullMime}
              onOpen={onThumbClick}
            />
          ) : null}
          {!isProgress && (
            <div className="text-right text-xs text-[var(--browd-faint)]">{formatTimestamp(message.timestamp)}</div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * T2f-replan: live plan checklist. Each item shows a circular
 * indicator (done = filled accent / pending = outlined) and the
 * subgoal text with strikethrough when complete. The list updates
 * in place as the StateGraph replanner emits new snapshots, so the
 * user sees the agent's progress against the original plan
 * instead of a stale text dump.
 */
function PlanChecklist({ items }: { items: { text: string; done: boolean }[] }) {
  return (
    <ul className="browd-plan-checklist mt-1 space-y-1">
      {items.map((it, i) => (
        <li key={i} className={`flex items-start gap-2 text-sm leading-5 ${it.done ? 'opacity-70' : ''}`}>
          <span
            aria-hidden="true"
            className={`mt-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
              it.done
                ? 'border-[var(--browd-accent)] bg-[var(--browd-accent)]'
                : 'border-[var(--browd-border-strong)] bg-transparent'
            }`}>
            {it.done ? <span className="text-[10px] leading-none text-[var(--browd-bg)]">✓</span> : null}
          </span>
          <span className={it.done ? 'text-[var(--browd-muted)] line-through' : 'text-[var(--browd-text)]'}>
            {it.text}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * T2f-1.5 / T2f-final-3 — inline screenshot preview in the chat.
 *
 * - Slide-in entrance matches the iOS / macOS capture feel.
 * - Click opens an in-panel lightbox (window.open(data:URL) is blocked
 *   in modern Chromium, so we render a modal overlay instead).
 * - 2× hover preview floats next to the thumb so the user can read
 *   details without committing to the lightbox. Pure CSS — no JS
 *   listeners, no layout shift on the rest of the chat.
 */
function ScreenshotThumb({
  base64,
  mime,
  fullBase64,
  fullMime,
  onOpen,
}: {
  base64: string;
  mime: string;
  fullBase64?: string;
  fullMime?: string;
  onOpen?: (url: string) => void;
}) {
  const thumbUrl = `data:${mime};base64,${base64}`;
  // T2f-final-fix: prefer full-resolution payload for the lightbox so
  // the user sees a sharp screenshot, not the upscaled 256×144 thumb.
  // Hover preview also uses the full image when available — at 2× the
  // thumb is fine, but free upgrade when the high-res bytes are here.
  const fullUrl = fullBase64 ? `data:${fullMime ?? 'image/jpeg'};base64,${fullBase64}` : thumbUrl;
  return (
    <div className="browd-screenshot-thumb-wrap relative mt-1">
      <button
        type="button"
        onClick={() => onOpen?.(fullUrl)}
        className="browd-screenshot-thumb block overflow-hidden rounded-md border border-[var(--browd-border)] bg-[var(--browd-panel-strong)] hover:opacity-95 transition-opacity"
        aria-label="open screenshot preview"
        title="click to enlarge — hover for quick preview">
        <img src={thumbUrl} alt="agent screenshot" className="block max-h-40 w-auto" />
      </button>
      <div className="browd-screenshot-thumb-hover" aria-hidden="true">
        <img src={fullUrl} alt="" className="block w-full" />
      </div>
    </div>
  );
}

/**
 * Formats a timestamp (in milliseconds) to a readable time string
 * @param timestamp Unix timestamp in milliseconds
 * @returns Formatted time string
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();

  // Check if the message is from today
  const isToday = date.toDateString() === now.toDateString();

  // Check if the message is from yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();

  // Check if the message is from this year
  const isThisYear = date.getFullYear() === now.getFullYear();

  // Format the time (HH:MM)
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (isToday) {
    return timeStr; // Just show the time for today's messages
  }

  if (isYesterday) {
    return `Yesterday, ${timeStr}`;
  }

  if (isThisYear) {
    // Show month and day for this year
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeStr}`;
  }

  // Show full date for older messages
  return `${date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}, ${timeStr}`;
}
