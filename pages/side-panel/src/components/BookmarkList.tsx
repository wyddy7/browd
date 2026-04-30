import { useEffect, useRef, useState } from 'react';
import { FaPen, FaTrash } from 'react-icons/fa';
import { FiPlus } from 'react-icons/fi';
import { t } from '@extension/i18n';

interface Bookmark {
  id: number;
  title: string;
  content: string;
}

const MAX_BOOKMARK_TITLE_LENGTH = 30;
const DEFAULT_TITLE_REWRITES: Record<string, string> = {
  'Explore Browd on GitHub': 'Explore Browd',
  'Extract structured data': 'Extract Info',
  'Create a reusable workflow': 'Create Workflow',
};

function getDisplayTitle(title: string): string {
  return (DEFAULT_TITLE_REWRITES[title] ?? title).slice(0, MAX_BOOKMARK_TITLE_LENGTH);
}

interface BookmarkListProps {
  bookmarks: Bookmark[];
  onBookmarkSelect: (content: string) => void;
  onBookmarkCreate?: (title: string, content: string) => void;
  onBookmarkUpdate?: (id: number, title: string, content: string) => void;
  onBookmarkUpdateTitle?: (id: number, title: string) => void;
  onBookmarkDelete?: (id: number) => void;
  onBookmarkReorder?: (draggedId: number, targetId: number) => void;
  isDarkMode?: boolean;
}

const BookmarkList: React.FC<BookmarkListProps> = ({
  bookmarks,
  onBookmarkSelect,
  onBookmarkCreate,
  onBookmarkUpdate,
  onBookmarkUpdateTitle,
  onBookmarkDelete,
  onBookmarkReorder,
}) => {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleEditClick = (bookmark: Bookmark) => {
    setIsEditMode(true);
    setEditingId(bookmark.id);
    setEditTitle(bookmark.title);
    setEditContent(bookmark.content);
    setIsCreating(false);
  };

  const handleSaveEdit = (id: number) => {
    const title = editTitle.trim().slice(0, MAX_BOOKMARK_TITLE_LENGTH);
    const content = editContent.trim();

    if (!title) {
      return;
    }

    if (onBookmarkUpdate && content) {
      onBookmarkUpdate(id, title, content);
    } else if (onBookmarkUpdateTitle) {
      onBookmarkUpdateTitle(id, title);
    }

    setEditingId(null);
    setEditContent('');
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditTitle('');
    setEditContent('');
  };

  const handleCreate = () => {
    const title = draftTitle.trim().slice(0, MAX_BOOKMARK_TITLE_LENGTH);
    const content = draftContent.trim();

    if (!title || !content || !onBookmarkCreate) {
      return;
    }

    onBookmarkCreate(title, content);
    setDraftTitle('');
    setDraftContent('');
    setIsCreating(false);
  };

  const handleCancelCreate = () => {
    setDraftTitle('');
    setDraftContent('');
    setIsCreating(false);
  };

  const handleDragStart = (e: React.DragEvent, id: number) => {
    setDraggedId(id);
    e.dataTransfer.setData('text/plain', id.toString());
    e.currentTarget.classList.add('opacity-25');
  };

  const handleDragEnd = (e: React.DragEvent) => {
    e.currentTarget.classList.remove('opacity-25');
    setDraggedId(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent, targetId: number) => {
    e.preventDefault();
    if (draggedId === null || draggedId === targetId) return;

    if (onBookmarkReorder) {
      onBookmarkReorder(draggedId, targetId);
    }
  };

  useEffect(() => {
    if ((editingId !== null || isCreating) && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editingId, isCreating]);

  const renderPromptForm = ({
    title,
    content,
    onTitleChange,
    onContentChange,
    onSave,
    onCancel,
  }: {
    title: string;
    content: string;
    onTitleChange: (value: string) => void;
    onContentChange: (value: string) => void;
    onSave: () => void;
    onCancel: () => void;
  }) => (
    <div className="rounded-[10px] border border-[var(--browd-border)] bg-[var(--browd-panel)] p-3">
      <input
        ref={inputRef}
        type="text"
        value={title}
        onChange={e => onTitleChange(e.target.value.slice(0, MAX_BOOKMARK_TITLE_LENGTH))}
        maxLength={MAX_BOOKMARK_TITLE_LENGTH}
        placeholder={t('chat_bookmarks_titlePlaceholder')}
        className="browd-input mb-2 w-full px-3 py-2 text-sm"
      />
      <div className="mb-2 text-right text-xs text-[var(--browd-faint)]">
        {title.length}/{MAX_BOOKMARK_TITLE_LENGTH}
      </div>
      <textarea
        value={content}
        onChange={e => onContentChange(e.target.value)}
        placeholder={t('chat_bookmarks_contentPlaceholder')}
        rows={4}
        className="browd-input min-h-[104px] w-full resize-none px-3 py-2 text-sm leading-6"
      />
      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="browd-button-ghost px-3 py-1.5 text-sm">
          {t('chat_bookmarks_cancelEdit')}
        </button>
        <button type="button" onClick={onSave} className="browd-button-primary px-3 py-1.5 text-sm">
          {t('chat_bookmarks_saveEdit')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium text-[var(--browd-text)]">{t('chat_bookmarks_header')}</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setIsCreating(true);
              setIsEditMode(true);
              setEditingId(null);
            }}
            className="browd-button-ghost inline-flex items-center px-2 py-1.5 text-sm text-[var(--browd-text)]"
            aria-label={t('chat_bookmarks_new')}>
            <FiPlus size={14} />
          </button>
          <button
            type="button"
            onClick={() => {
              setIsEditMode(value => !value);
              setIsCreating(false);
              setEditingId(null);
            }}
            aria-label={t('chat_bookmarks_edit')}
            aria-pressed={isEditMode}
            className={`browd-button-ghost inline-flex min-w-[54px] items-center justify-center rounded-full px-3 py-1.5 text-sm transition-all duration-200 ${
              isEditMode ? 'bg-[var(--browd-accent-soft)] text-[var(--browd-text)]' : 'text-[var(--browd-text)]'
            }`}>
            {isEditMode ? 'Done' : 'Edit'}
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {isCreating &&
          renderPromptForm({
            title: draftTitle,
            content: draftContent,
            onTitleChange: setDraftTitle,
            onContentChange: setDraftContent,
            onSave: handleCreate,
            onCancel: handleCancelCreate,
          })}

        {isEditMode ? (
          <div className="browd-quick-start-enter flex flex-col gap-2">
            {bookmarks.map(bookmark => (
              <div key={bookmark.id} className="min-w-0">
                {editingId === bookmark.id ? (
                  <div className="w-full min-w-[260px] max-w-full">
                    {renderPromptForm({
                      title: editTitle,
                      content: editContent,
                      onTitleChange: setEditTitle,
                      onContentChange: setEditContent,
                      onSave: () => handleSaveEdit(bookmark.id),
                      onCancel: handleCancelEdit,
                    })}
                  </div>
                ) : (
                  <div
                    draggable
                    onDragStart={e => handleDragStart(e, bookmark.id)}
                    onDragEnd={handleDragEnd}
                    onDragOver={handleDragOver}
                    onDrop={e => handleDrop(e, bookmark.id)}
                    className="flex items-center gap-3 rounded-[10px] border border-[var(--browd-border)] bg-[var(--browd-panel)] px-3 py-2.5 transition-colors hover:bg-[var(--browd-panel-strong)]">
                    <button
                      type="button"
                      onClick={() => handleEditClick(bookmark)}
                      className="min-w-0 flex-1 truncate text-left text-sm font-medium text-[var(--browd-text)]">
                      {getDisplayTitle(bookmark.title)}
                    </button>
                    <button
                      onClick={() => handleEditClick(bookmark)}
                      className="browd-icon-button rounded-full p-1"
                      aria-label={t('chat_bookmarks_edit')}
                      type="button">
                      <FaPen size={11} />
                    </button>
                    <button
                      onClick={() => {
                        if (onBookmarkDelete) {
                          onBookmarkDelete(bookmark.id);
                        }
                      }}
                      className="browd-icon-button rounded-full p-1 text-[var(--browd-danger)] hover:bg-[var(--browd-danger-soft)] hover:text-[var(--browd-danger-hover)]"
                      aria-label={t('chat_bookmarks_delete')}
                      type="button">
                      <FaTrash size={11} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="browd-quick-start-enter flex flex-col items-center gap-2 min-[430px]:flex-row min-[430px]:flex-wrap min-[430px]:justify-center">
            {bookmarks.map(bookmark => (
              <div key={bookmark.id} className="min-w-0">
                <div className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--browd-border)] bg-[var(--browd-panel)] px-3 py-2 transition-colors hover:bg-[var(--browd-panel-strong)]">
                  <button
                    type="button"
                    onClick={() => onBookmarkSelect(bookmark.content)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        onBookmarkSelect(bookmark.content);
                      }
                    }}
                    className="max-w-[180px] truncate text-sm font-medium text-[var(--browd-text)]">
                    {getDisplayTitle(bookmark.title)}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default BookmarkList;
