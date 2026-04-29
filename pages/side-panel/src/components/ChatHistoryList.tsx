/* eslint-disable react/prop-types */
import { FaTrash } from 'react-icons/fa';
import { BsBookmark } from 'react-icons/bs';
import { t } from '@extension/i18n';

interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
}

interface ChatHistoryListProps {
  sessions: ChatSession[];
  onSessionSelect: (sessionId: string) => void;
  onSessionDelete: (sessionId: string) => void;
  onSessionBookmark: (sessionId: string) => void;
  visible: boolean;
  isDarkMode?: boolean;
}

const ChatHistoryList: React.FC<ChatHistoryListProps> = ({
  sessions,
  onSessionSelect,
  onSessionDelete,
  onSessionBookmark,
  visible,
}) => {
  if (!visible) return null;

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div className="h-full overflow-y-auto p-4">
      <h2 className="mb-4 text-lg font-semibold text-[var(--browd-text)]">{t('chat_history_title')}</h2>
      {sessions.length === 0 ? (
        <div className="browd-card p-4 text-center text-[var(--browd-muted)]">{t('chat_history_empty')}</div>
      ) : (
        <div className="space-y-2">
          {sessions.map(session => (
            <div
              key={session.id}
              className="browd-card group relative p-3 transition-colors hover:bg-[var(--browd-panel-strong)]">
              <button onClick={() => onSessionSelect(session.id)} className="w-full text-left" type="button">
                <h3 className="text-sm font-medium text-[var(--browd-text)]">{session.title}</h3>
                <p className="mt-1 text-xs text-[var(--browd-faint)]">{formatDate(session.createdAt)}</p>
              </button>

              {/* Bookmark button - top right */}
              {onSessionBookmark && (
                <button
                  onClick={e => {
                    e.stopPropagation();
                    onSessionBookmark(session.id);
                  }}
                  className="browd-icon-button absolute right-2 top-2 p-1 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label={t('chat_history_bookmark')}
                  type="button">
                  <BsBookmark size={14} />
                </button>
              )}

              {/* Delete button - bottom right */}
              <button
                onClick={e => {
                  e.stopPropagation();
                  onSessionDelete(session.id);
                }}
                className="absolute bottom-2 right-2 rounded p-1 text-[var(--browd-danger)] opacity-0 transition-colors transition-opacity hover:bg-[var(--browd-danger-soft)] hover:text-[var(--browd-danger-hover)] group-hover:opacity-100"
                aria-label={t('chat_history_delete')}
                type="button">
                <FaTrash size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ChatHistoryList;
