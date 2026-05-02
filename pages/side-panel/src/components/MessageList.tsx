import type { Message } from '@extension/storage';
import { ACTOR_PROFILES } from '../types/message';
import { memo } from 'react';

interface MessageListProps {
  messages: Message[];
  isDarkMode?: boolean;
  /** T2f-final-3 — open the in-panel screenshot lightbox. SidePanel hosts the actual modal. */
  onThumbClick?: (url: string) => void;
}

export default memo(function MessageList({ messages, onThumbClick }: MessageListProps) {
  return (
    <div className="max-w-full space-y-4">
      {messages.map((message, index) => (
        <MessageBlock
          key={`${message.actor}-${message.timestamp}-${index}`}
          message={message}
          isSameActor={index > 0 ? messages[index - 1].actor === message.actor : false}
          onThumbClick={onThumbClick}
        />
      ))}
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
          <div className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--browd-muted)]">
            {isProgress ? (
              <div className="h-1 overflow-hidden rounded bg-[var(--browd-panel-strong)]">
                <div className="browd-progress h-full animate-progress" />
              </div>
            ) : (
              message.content
            )}
          </div>
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
