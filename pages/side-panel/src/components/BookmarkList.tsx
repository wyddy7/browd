/* eslint-disable react/prop-types */
import { useEffect, useRef, useState } from 'react';
import { FaCheck, FaPen, FaTimes, FaTrash } from 'react-icons/fa';
import { FiPlus } from 'react-icons/fi';
import { t } from '@extension/i18n';

interface Bookmark {
  id: number;
  title: string;
  content: string;
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
  const inputRef = useRef<HTMLInputElement>(null);

  const handleEditClick = (bookmark: Bookmark) => {
    setEditingId(bookmark.id);
    setEditTitle(bookmark.title);
    setEditContent(bookmark.content);
    setIsCreating(false);
  };

  const handleSaveEdit = (id: number) => {
    const title = editTitle.trim();
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
    const title = draftTitle.trim();
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
        onChange={e => onTitleChange(e.target.value)}
        placeholder={t('chat_bookmarks_titlePlaceholder')}
        className="browd-input mb-2 w-full px-3 py-2 text-sm"
      />
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
        <div>
          <h3 className="text-sm font-medium text-[var(--browd-text)]">{t('chat_bookmarks_header')}</h3>
          <p className="mt-1 text-sm text-[var(--browd-muted)]">{t('chat_bookmarks_description')}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setIsCreating(true);
            setEditingId(null);
          }}
          className="browd-button-ghost inline-flex items-center gap-2 px-2.5 py-1.5 text-sm text-[var(--browd-text)]">
          <FiPlus size={14} />
          {t('chat_bookmarks_new')}
        </button>
      </div>

      {isCreating &&
        renderPromptForm({
          title: draftTitle,
          content: draftContent,
          onTitleChange: setDraftTitle,
          onContentChange: setDraftContent,
          onSave: handleCreate,
          onCancel: handleCancelCreate,
        })}

      <div className="mt-3 flex flex-col gap-2">
        {bookmarks.map(bookmark => (
          <div
            key={bookmark.id}
            draggable={editingId !== bookmark.id}
            onDragStart={e => handleDragStart(e, bookmark.id)}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDrop={e => handleDrop(e, bookmark.id)}
            className="group rounded-[10px] border border-[var(--browd-border)] bg-[var(--browd-panel)] px-3 py-2.5 transition-colors hover:bg-[var(--browd-panel-strong)]">
            {editingId === bookmark.id ? (
              renderPromptForm({
                title: editTitle,
                content: editContent,
                onTitleChange: setEditTitle,
                onContentChange: setEditContent,
                onSave: () => handleSaveEdit(bookmark.id),
                onCancel: handleCancelEdit,
              })
            ) : (
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => onBookmarkSelect(bookmark.content)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      onBookmarkSelect(bookmark.content);
                    }
                  }}
                  className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-medium text-[var(--browd-text)]">{bookmark.title}</div>
                  <div className="mt-1 line-clamp-2 text-sm leading-6 text-[var(--browd-muted)]">
                    {bookmark.content}
                  </div>
                </button>

                <div className="flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      handleEditClick(bookmark);
                    }}
                    className="browd-icon-button p-1.5"
                    aria-label={t('chat_bookmarks_edit')}
                    type="button">
                    <FaPen size={12} />
                  </button>
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      if (onBookmarkDelete) {
                        onBookmarkDelete(bookmark.id);
                      }
                    }}
                    className="browd-icon-button p-1.5 text-[var(--browd-danger)] hover:bg-[var(--browd-danger-soft)] hover:text-[var(--browd-danger-hover)]"
                    aria-label={t('chat_bookmarks_delete')}
                    type="button">
                    <FaTrash size={12} />
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default BookmarkList;
