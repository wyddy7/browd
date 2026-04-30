import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { FaMicrophone } from 'react-icons/fa';
import { AiOutlineLoading3Quarters } from 'react-icons/ai';
import { FiPaperclip } from 'react-icons/fi';
import { t } from '@extension/i18n';

type QuickAgent = 'planner' | 'navigator';

interface ModelOption {
  provider: string;
  providerName: string;
  model: string;
}

export interface ChatInputContentController {
  setText: (text: string) => void;
  appendText: (text: string) => void;
}

interface ChatInputProps {
  onSendMessage: (text: string, displayText?: string) => void;
  onStopTask: () => void;
  onMicClick?: () => void;
  availableModels?: ModelOption[];
  selectedModels?: Record<QuickAgent, string>;
  activeAgent?: QuickAgent;
  onActiveAgentChange?: (agent: QuickAgent) => void;
  onModelChange?: (agent: QuickAgent, modelValue: string) => void;
  preferredModelMenuDirection?: 'up' | 'down';
  isRecording?: boolean;
  isProcessingSpeech?: boolean;
  disabled: boolean;
  showStopButton: boolean;
  setContent?: (controller: ChatInputContentController) => void;
  isDarkMode?: boolean;
  // Historical session ID - if provided, shows replay button instead of send button
  historicalSessionId?: string | null;
  onReplay?: (sessionId: string) => void;
}

// File attachment interface
interface AttachedFile {
  name: string;
  content: string;
  type: string;
}

export default function ChatInput({
  onSendMessage,
  onStopTask,
  onMicClick,
  availableModels = [],
  selectedModels = { planner: '', navigator: '' },
  activeAgent = 'navigator',
  onActiveAgentChange,
  onModelChange,
  preferredModelMenuDirection = 'up',
  isRecording = false,
  isProcessingSpeech = false,
  disabled,
  showStopButton,
  setContent,
  historicalSessionId,
  onReplay,
}: ChatInputProps) {
  const [text, setText] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [composerWidth, setComposerWidth] = useState(0);
  const [modelMenuDirection, setModelMenuDirection] = useState<'up' | 'down'>(preferredModelMenuDirection);
  const isSendButtonDisabled = useMemo(
    () => disabled || (text.trim() === '' && attachedFiles.length === 0),
    [disabled, text, attachedFiles],
  );
  const composerRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuPanelRef = useRef<HTMLDivElement>(null);
  const currentSelectedModel = selectedModels[activeAgent] || '';
  const layoutMode = useMemo(() => {
    if (composerWidth > 0 && composerWidth < 320) return 'tight';
    if (composerWidth > 0 && composerWidth < 430) return 'compact';
    return 'comfortable';
  }, [composerWidth]);
  const menuWidth = useMemo(() => {
    if (composerWidth <= 0) return 288;
    if (layoutMode === 'tight') return Math.max(220, Math.min(composerWidth - 24, 320));
    if (layoutMode === 'compact') return Math.max(240, Math.min(composerWidth - 40, 320));
    return 288;
  }, [composerWidth, layoutMode]);
  const modelButtonHint =
    availableModels.length > 0
      ? `${availableModels.length} model${availableModels.length === 1 ? '' : 's'}`
      : t('options_models_chooseModel');

  useEffect(() => {
    const node = composerRef.current;
    if (!node) return;

    const updateWidth = () => {
      setComposerWidth(node.getBoundingClientRect().width);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    window.addEventListener('resize', updateWidth);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateWidth);
    };
  }, []);

  useEffect(() => {
    if (!isModelMenuOpen) {
      setModelMenuDirection(preferredModelMenuDirection);
    }
  }, [isModelMenuOpen, preferredModelMenuDirection]);

  useEffect(() => {
    if (!isModelMenuOpen) return;

    const updateMenuDirection = () => {
      const triggerRect = modelMenuRef.current?.getBoundingClientRect();
      const menuHeight = modelMenuPanelRef.current?.offsetHeight ?? 0;

      if (!triggerRect || menuHeight === 0) {
        setModelMenuDirection(preferredModelMenuDirection);
        return;
      }

      const spacing = 12;
      const spaceAbove = triggerRect.top;
      const spaceBelow = window.innerHeight - triggerRect.bottom;
      const fitsAbove = spaceAbove >= menuHeight + spacing;
      const fitsBelow = spaceBelow >= menuHeight + spacing;

      if (preferredModelMenuDirection === 'down') {
        if (fitsBelow) {
          setModelMenuDirection('down');
        } else if (fitsAbove) {
          setModelMenuDirection('up');
        } else {
          setModelMenuDirection(spaceBelow >= spaceAbove ? 'down' : 'up');
        }
        return;
      }

      if (fitsAbove) {
        setModelMenuDirection('up');
      } else if (fitsBelow) {
        setModelMenuDirection('down');
      } else {
        setModelMenuDirection(spaceAbove >= spaceBelow ? 'up' : 'down');
      }
    };

    const handlePointerDown = (event: MouseEvent) => {
      if (!modelMenuRef.current?.contains(event.target as Node)) {
        setIsModelMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsModelMenuOpen(false);
      }
    };

    updateMenuDirection();
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updateMenuDirection);
    window.addEventListener('scroll', updateMenuDirection, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updateMenuDirection);
      window.removeEventListener('scroll', updateMenuDirection, true);
    };
  }, [isModelMenuOpen, preferredModelMenuDirection]);

  // Handle text changes and resize textarea
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
  };

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 100)}px`;
  }, []);

  // Expose a method to set content from outside
  useEffect(() => {
    if (setContent) {
      setContent({
        setText: (nextText: string) => {
          setText(nextText);
        },
        appendText: (nextText: string) => {
          const normalizedText = nextText.trim();
          if (!normalizedText) {
            return;
          }

          setText(previousText =>
            previousText.trim() ? `${previousText.replace(/\s+$/, '')} ${normalizedText}` : normalizedText,
          );
        },
      });
    }
  }, [setContent]);

  useEffect(() => {
    resizeTextarea();
  }, [text, resizeTextarea]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedText = text.trim();

      if (trimmedText || attachedFiles.length > 0) {
        let messageContent = trimmedText;
        let displayContent = trimmedText;

        // Security: Clearly separate user input from file content
        // The background service will sanitize file content using guardrails
        if (attachedFiles.length > 0) {
          const fileContents = attachedFiles
            .map(file => {
              // Tag file content for background service to identify and sanitize
              return `\n\n<nano_file_content type="file" name="${file.name}">\n${file.content}\n</nano_file_content>`;
            })
            .join('\n');

          // Combine user message with tagged file content (for background service)
          messageContent = trimmedText
            ? `${trimmedText}\n\n<nano_attached_files>${fileContents}</nano_attached_files>`
            : `<nano_attached_files>${fileContents}</nano_attached_files>`;

          // Create display version with only filenames (for UI)
          const fileList = attachedFiles.map(file => `📎 ${file.name}`).join('\n');
          displayContent = trimmedText ? `${trimmedText}\n\n${fileList}` : fileList;
        }

        onSendMessage(messageContent, displayContent);
        setText('');
        setAttachedFiles([]);
      }
    },
    [text, attachedFiles, onSendMessage],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSubmit(e);
      }
    },
    [handleSubmit],
  );

  const handleReplay = useCallback(() => {
    if (historicalSessionId && onReplay) {
      onReplay(historicalSessionId);
    }
  }, [historicalSessionId, onReplay]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newFiles: AttachedFile[] = [];
    const allowedTypes = ['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.xml', '.yaml', '.yml'];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileExt = '.' + file.name.split('.').pop()?.toLowerCase();

      // Check if file type is allowed
      if (!allowedTypes.includes(fileExt)) {
        console.warn(`File type ${fileExt} not supported. Only text-based files are allowed.`);
        continue;
      }

      // Check file size (limit to 1MB)
      if (file.size > 1024 * 1024) {
        console.warn(`File ${file.name} is too large. Maximum size is 1MB.`);
        continue;
      }

      try {
        const content = await file.text();
        newFiles.push({
          name: file.name,
          content,
          type: file.type || 'text/plain',
        });
      } catch (error) {
        console.error(`Error reading file ${file.name}:`, error);
      }
    }

    if (newFiles.length > 0) {
      setAttachedFiles(prev => [...prev, ...newFiles]);
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleRemoveFile = useCallback((index: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  return (
    <form
      ref={composerRef}
      onSubmit={handleSubmit}
      className={`browd-input overflow-visible transition-colors ${disabled ? 'cursor-not-allowed opacity-80' : ''}`}
      aria-label={t('chat_input_form')}>
      <div className="flex flex-col">
        {/* File attachments display */}
        {attachedFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 border-b border-[var(--browd-border)] bg-[var(--browd-panel)] p-2">
            {attachedFiles.map((file, index) => (
              <div
                key={index}
                className="flex items-center gap-1 rounded-md bg-[var(--browd-panel-strong)] px-2 py-1 text-xs text-[var(--browd-muted)]">
                <span className="text-xs">📎</span>
                <span className="max-w-[150px] truncate">{file.name}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveFile(index)}
                  className="browd-button-ghost ml-1 px-1 transition-colors"
                  aria-label={`Remove ${file.name}`}>
                  <span className="text-xs">✕</span>
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          aria-disabled={disabled}
          rows={5}
          className="w-full resize-none border-none bg-[var(--browd-bg)] p-3 text-sm leading-6 text-[var(--browd-text)] placeholder:text-[var(--browd-faint)] focus:outline-none disabled:cursor-not-allowed disabled:text-[var(--browd-faint)]"
          placeholder={attachedFiles.length > 0 ? 'Add a message (optional)...' : t('chat_input_placeholder')}
          aria-label={t('chat_input_editor')}
        />

        <div
          className={`border-t border-[var(--browd-border)] bg-[var(--browd-surface)] px-3 py-2 ${
            layoutMode === 'tight' ? 'space-y-2' : ''
          }`}>
          <div
            className={`flex ${layoutMode === 'tight' ? 'items-center justify-between gap-2' : 'items-center justify-between'}`}>
            <div className="flex gap-2 text-[var(--browd-muted)]">
              {/* File attachment button */}
              <button
                type="button"
                onClick={handleFileSelect}
                disabled={disabled}
                aria-label="Attach files"
                title="Attach text files (txt, md, json, csv, etc.)"
                className="browd-icon-button p-1.5 disabled:cursor-not-allowed disabled:opacity-50">
                <FiPaperclip className="size-4" />
              </button>

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".txt,.md,.markdown,.json,.csv,.log,.xml,.yaml,.yml"
                onChange={handleFileChange}
                className="hidden"
                aria-hidden="true"
              />
            </div>

            <div className="flex items-center gap-2">
              {onModelChange && (
                <div ref={modelMenuRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setIsModelMenuOpen(open => !open)}
                    disabled={disabled || availableModels.length === 0}
                    aria-haspopup="menu"
                    aria-expanded={isModelMenuOpen}
                    className={`browd-model-trigger inline-flex items-center gap-2 rounded-full bg-[var(--browd-panel-strong)] px-3 py-1.5 text-sm text-[var(--browd-text)] transition-colors hover:bg-[var(--browd-control-hover)] disabled:cursor-not-allowed disabled:opacity-50 ${
                      layoutMode === 'tight'
                        ? 'max-w-[154px]'
                        : layoutMode === 'compact'
                          ? 'max-w-[172px]'
                          : 'max-w-[188px]'
                    }`}>
                    <span className="min-w-0 truncate font-medium text-[var(--browd-text)]">Models</span>
                    <span className="shrink-0 text-[11px] text-[var(--browd-faint)]">{modelButtonHint}</span>
                    <span
                      className={`shrink-0 text-xs text-[var(--browd-faint)] transition-transform duration-200 ${
                        isModelMenuOpen ? 'rotate-180' : ''
                      }`}>
                      v
                    </span>
                  </button>

                  {isModelMenuOpen && (
                    <div
                      ref={modelMenuPanelRef}
                      role="menu"
                      className={`browd-model-menu absolute right-0 z-50 w-72 overflow-hidden rounded-xl border border-[var(--browd-border)] bg-[var(--browd-panel)] py-2 text-sm text-[var(--browd-text)] shadow-[var(--browd-shadow-menu)] ${
                        modelMenuDirection === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'
                      } ${modelMenuDirection === 'up' ? 'origin-bottom-right' : 'origin-top-right'}`}
                      style={{ width: `${menuWidth}px` }}>
                      <div className="px-4 pb-2 pt-1">
                        <div className="mb-2 text-sm text-[var(--browd-faint)]">Role</div>
                        <div className="flex gap-4">
                          {(['planner', 'navigator'] as QuickAgent[]).map(agent => {
                            const isSelected = agent === activeAgent;
                            const label = agent === 'planner' ? 'Planner' : 'Navigator';
                            return (
                              <button
                                key={agent}
                                type="button"
                                onClick={() => onActiveAgentChange?.(agent)}
                                className={`text-sm transition-colors ${
                                  isSelected
                                    ? 'font-medium text-[var(--browd-text)]'
                                    : 'text-[var(--browd-muted)] hover:text-[var(--browd-text)]'
                                }`}>
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="border-t border-[var(--browd-border)] px-4 pb-2 pt-3 text-sm text-[var(--browd-faint)]">
                        Model
                      </div>
                      <div className="max-h-72 overflow-y-auto">
                        {availableModels.map(({ provider, providerName, model }) => {
                          const value = `${provider}>${model}`;
                          const isSelected = value === currentSelectedModel;
                          return (
                            <button
                              key={value}
                              type="button"
                              role="menuitemradio"
                              aria-checked={isSelected}
                              onClick={() => {
                                onModelChange(activeAgent, value);
                              }}
                              className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors ${
                                isSelected
                                  ? 'bg-[var(--browd-panel-strong)] text-[var(--browd-text)]'
                                  : 'text-[var(--browd-muted)] hover:bg-[var(--browd-control-hover)] hover:text-[var(--browd-text)]'
                              }`}>
                              <span className="min-w-0">
                                <span className="block truncate text-[var(--browd-text)]">
                                  {model
                                    .replace(/^gpt-/i, 'GPT-')
                                    .replace(/^claude-/i, 'Claude ')
                                    .replace(/^gemini-/i, 'Gemini ')
                                    .replace(/-/g, ' ')
                                    .replace(/\s+/g, ' ')
                                    .trim()}
                                </span>
                                <span className="block truncate text-xs text-[var(--browd-faint)]">{providerName}</span>
                              </span>
                              <span className={`shrink-0 text-lg ${isSelected ? 'opacity-100' : 'opacity-0'}`}>✓</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {onMicClick && !historicalSessionId && (
                <button
                  type="button"
                  onClick={onMicClick}
                  disabled={disabled || isProcessingSpeech}
                  aria-label={
                    isProcessingSpeech
                      ? t('chat_stt_processing')
                      : isRecording
                        ? t('chat_stt_recording_stop')
                        : t('chat_stt_input_start')
                  }
                  className={`rounded-md p-1.5 transition-colors ${
                    disabled || isProcessingSpeech
                      ? 'cursor-not-allowed opacity-50'
                      : isRecording
                        ? 'bg-[var(--browd-danger)] text-white hover:bg-[var(--browd-danger-hover)]'
                        : 'browd-icon-button'
                  }`}>
                  {isProcessingSpeech ? (
                    <AiOutlineLoading3Quarters className="size-4 animate-spin" />
                  ) : (
                    <FaMicrophone className={`size-4 ${isRecording ? 'animate-pulse' : ''}`} />
                  )}
                </button>
              )}

              {showStopButton ? (
                <button
                  type="button"
                  onClick={onStopTask}
                  className="rounded-md bg-[var(--browd-danger)] px-3 py-1 text-white transition-colors hover:bg-[var(--browd-danger-hover)]">
                  {t('chat_buttons_stop')}
                </button>
              ) : historicalSessionId ? (
                <button
                  type="button"
                  onClick={handleReplay}
                  disabled={!historicalSessionId}
                  aria-disabled={!historicalSessionId}
                  className={`browd-button-primary px-3 py-1 text-sm font-medium ${!historicalSessionId ? 'cursor-not-allowed opacity-50' : ''}`}>
                  {t('chat_buttons_replay')}
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={isSendButtonDisabled}
                  aria-disabled={isSendButtonDisabled}
                  className={`browd-button-primary px-3 py-1 text-sm font-medium ${isSendButtonDisabled ? 'cursor-not-allowed opacity-50' : ''}`}>
                  {t('chat_buttons_send')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
