import type { Message } from '@extension/storage';
import { ACTOR_PROFILES } from '../types/message';
import { memo } from 'react';

interface MessageListProps {
  messages: Message[];
  isDarkMode?: boolean;
  /** T2f-final-3 — open the in-panel screenshot lightbox. SidePanel hosts the actual modal. */
  onThumbClick?: (url: string) => void;
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

export default memo(function MessageList({ messages, onThumbClick }: MessageListProps) {
  const groups = groupMessages(messages);
  return (
    <div className="max-w-full space-y-4">
      {groups.map((g, gi) => {
        if (g.kind === 'thinking') {
          // We rebuild a "previous-actor" flag inside the collapsed
          // group so the avatar grouping still feels right when
          // expanded.
          return (
            <details
              key={`thinking-${gi}-${g.items[0].index}`}
              className="browd-thinking-group rounded-md border border-[var(--browd-border)] bg-[var(--browd-panel)]/60 px-3 py-2 text-sm">
              <summary className="cursor-pointer select-none list-none text-[var(--browd-muted)] hover:text-[var(--browd-text)] transition-colors">
                <span className="mr-2">⌄</span>
                Thinking — {g.items.length} step{g.items.length === 1 ? '' : 's'}
              </summary>
              <div className="mt-2 space-y-3 opacity-95">
                {g.items.map((it, idx) => (
                  <MessageBlock
                    key={`t-${it.msg.actor}-${it.msg.timestamp}-${it.index}`}
                    message={it.msg}
                    isSameActor={idx > 0 ? g.items[idx - 1].msg.actor === it.msg.actor : false}
                    onThumbClick={onThumbClick}
                  />
                ))}
              </div>
            </details>
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

  return (
    <div
      className={`flex max-w-full gap-3 ${
        !isSameActor ? 'mt-4 border-t border-[var(--browd-border)] pt-4 first:mt-0 first:border-t-0 first:pt-0' : ''
      }`}>
      {!isSameActor && (
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: actor.iconBackground }}>
          <img src={actor.icon} alt={actor.name} className="size-6" />
        </div>
      )}
      {isSameActor && <div className="w-8" />}

      <div className="min-w-0 flex-1">
        {!isSameActor && <div className="mb-1 text-sm font-semibold text-[var(--browd-text)]">{actor.name}</div>}

        <div className="space-y-0.5">
          {Array.isArray(message.planItems) && message.planItems.length > 0 ? (
            <PlanChecklist items={message.planItems} />
          ) : (
            <div className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--browd-muted)]">
              {isProgress ? (
                <div className="h-1 overflow-hidden rounded bg-[var(--browd-panel-strong)]">
                  <div className="browd-progress h-full animate-progress" />
                </div>
              ) : (
                message.content
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
