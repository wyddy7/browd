import type { Message } from '@extension/storage';
import { ACTOR_PROFILES } from '../types/message';
import { memo } from 'react';

interface MessageListProps {
  messages: Message[];
  isDarkMode?: boolean;
}

export default memo(function MessageList({ messages }: MessageListProps) {
  return (
    <div className="max-w-full space-y-4">
      {messages.map((message, index) => (
        <MessageBlock
          key={`${message.actor}-${message.timestamp}-${index}`}
          message={message}
          isSameActor={index > 0 ? messages[index - 1].actor === message.actor : false}
        />
      ))}
    </div>
  );
});

interface MessageBlockProps {
  message: Message;
  isSameActor: boolean;
}

function MessageBlock({ message, isSameActor }: MessageBlockProps) {
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
            <ScreenshotThumb base64={message.imageThumbBase64} mime={message.imageThumbMime ?? 'image/jpeg'} />
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
 * T2f-1.5: inline screenshot preview in the chat. Slide-in animation
 * matches the iOS / macOS screenshot capture feel — the image fades up
 * from below while the parent flash overlay (ScreenshotFlash) blinks
 * once. Click → opens the same thumbnail full-size in a new tab via
 * a `data:` URL (no full-resolution payload travels through chat).
 */
function ScreenshotThumb({ base64, mime }: { base64: string; mime: string }) {
  const url = `data:${mime};base64,${base64}`;
  return (
    <button
      type="button"
      onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
      className="browd-screenshot-thumb mt-1 block overflow-hidden rounded-md border border-[var(--browd-border)] bg-[var(--browd-panel-strong)] hover:opacity-90 transition-opacity"
      aria-label="open screenshot in new tab"
      title="open screenshot in new tab">
      <img src={url} alt="agent screenshot" className="block max-h-40 w-auto" />
    </button>
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
