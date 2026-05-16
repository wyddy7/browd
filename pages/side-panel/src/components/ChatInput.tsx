import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { FaMicrophone, FaEye, FaEyeSlash } from 'react-icons/fa';
import { AiOutlineLoading3Quarters } from 'react-icons/ai';
import { FiPaperclip } from 'react-icons/fi';
import { t } from '@extension/i18n';
import { chatInputDraftStorage, type PermissionMode } from '@extension/storage';
import { TokenRing } from './TokenRing';
import { PermissionModeSelector } from './PermissionModeSelector';

type QuickAgent = 'planner' | 'navigator';
// T2f-clean-finish-3 — Judge is a service config (used by runtime
// verifier and eval grader), not something the user picks per chat.
// Picker exposes only the roles the user actively switches: agent
// brains + STT mic. Judge lives in Settings → Models.
type QuickModelRole = QuickAgent | 'stt';

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
  availableSpeechToTextModels?: ModelOption[];
  selectedModels?: Record<QuickAgent, string>;
  selectedSpeechToTextModel?: string;
  activeAgent?: QuickAgent;
  onActiveAgentChange?: (agent: QuickAgent) => void;
  onModelChange?: (agent: QuickAgent, modelValue: string) => void;
  onSpeechToTextModelChange?: (modelValue: string) => void;
  /**
   * T2f-tab-iso-2 — agent-tab focus mode. 'background' (default, safe)
   * = agent works in a separate tab, user keeps focus on theirs.
   * 'foreground' = bring agent tab to front on TASK_START so user can
   * watch the agent work. Toggle via the eye button next to the mic.
   */
  agentTabFocusMode?: 'background' | 'foreground';
  onAgentTabFocusToggle?: () => void;
  /**
   * T2s-3 — per-task permission posture. Drives the dropdown in the
   * input toolbar that lets the user switch between Default / Auto /
   * Full approval flows for in-app HITL gates (currently only
   * `take_over_user_tab`). Owned by SidePanel.
   */
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
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
  /**
   * T2f-final-fix-2 — live token usage shown right of the paperclip
   * button. SidePanel owns the cumulative state; ChatInput is purely
   * presentational here. Hover surfaces a tooltip with the full
   * "<used>/<context window>" breakdown.
   */
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    contextWindow: number;
  } | null;
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
  availableSpeechToTextModels = [],
  selectedModels = { planner: '', navigator: '' },
  selectedSpeechToTextModel = '',
  activeAgent = 'navigator',
  onActiveAgentChange,
  onModelChange,
  onSpeechToTextModelChange,
  agentTabFocusMode = 'background',
  onAgentTabFocusToggle,
  permissionMode = 'default',
  onPermissionModeChange,
  preferredModelMenuDirection = 'up',
  isRecording = false,
  isProcessingSpeech = false,
  disabled,
  showStopButton,
  setContent,
  historicalSessionId,
  onReplay,
  tokenUsage,
}: ChatInputProps) {
  const [text, setText] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [composerWidth, setComposerWidth] = useState(0);
  const [modelMenuDirection, setModelMenuDirection] = useState<'up' | 'down'>(preferredModelMenuDirection);
  const [isDraftHydrated, setIsDraftHydrated] = useState(false);
  const [activeModelRole, setActiveModelRole] = useState<QuickModelRole>(activeAgent);
  const isSendButtonDisabled = useMemo(
    () => disabled || (text.trim() === '' && attachedFiles.length === 0),
    [disabled, text, attachedFiles],
  );
  const composerRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const baseTextareaHeightRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuPanelRef = useRef<HTMLDivElement>(null);
  const currentSelectedModel =
    activeModelRole === 'stt' ? selectedSpeechToTextModel : selectedModels[activeModelRole] || '';
  const visibleModels = activeModelRole === 'stt' ? availableSpeechToTextModels : availableModels;
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
  const modelButtonHint = visibleModels.length > 0 ? `${visibleModels.length}` : t('options_models_chooseModel');

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
    let isCancelled = false;

    const loadDraft = async () => {
      try {
        const draftText = await chatInputDraftStorage.getDraft();
        if (!isCancelled && draftText) {
          setText(previousText => (previousText.length > 0 ? previousText : draftText));
        }
      } catch (error) {
        console.error('Failed to load chat input draft:', error);
      } finally {
        if (!isCancelled) {
          setIsDraftHydrated(true);
        }
      }
    };

    loadDraft();

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isModelMenuOpen) {
      setModelMenuDirection(preferredModelMenuDirection);
    }
  }, [isModelMenuOpen, preferredModelMenuDirection]);

  useEffect(() => {
    setActiveModelRole(currentRole => (currentRole === 'stt' ? currentRole : activeAgent));
  }, [activeAgent]);

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
    const measuredBaseHeight =
      baseTextareaHeightRef.current ??
      Math.max(textarea.scrollHeight, textarea.getBoundingClientRect().height || 0, textarea.clientHeight || 0);

    if (baseTextareaHeightRef.current === null && measuredBaseHeight > 0) {
      baseTextareaHeightRef.current = measuredBaseHeight;
    }

    const baseHeight = baseTextareaHeightRef.current ?? measuredBaseHeight;
    const maxExpandedHeight = Math.round(baseHeight * 1.2);
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, baseHeight), maxExpandedHeight);

    textarea.style.height = `${nextHeight}px`;
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

  useEffect(() => {
    if (!isDraftHydrated) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const persistDraft = async () => {
        try {
          if (text.length > 0) {
            await chatInputDraftStorage.setDraft(text);
          } else {
            await chatInputDraftStorage.clearDraft();
          }
        } catch (error) {
          console.error('Failed to save chat input draft:', error);
        }
      };

      void persistDraft();
    }, 400);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [text, isDraftHydrated]);

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
        void chatInputDraftStorage.clearDraft();
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
          className="w-full resize-none overflow-y-auto border-none bg-[var(--browd-bg)] p-3 text-sm leading-6 text-[var(--browd-text)] transition-[height] duration-200 ease-out placeholder:text-[var(--browd-faint)] focus:outline-none disabled:cursor-not-allowed disabled:text-[var(--browd-faint)]"
          placeholder={attachedFiles.length > 0 ? t('chat_input_placeholder_with_files') : t('chat_input_placeholder')}
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

              {/* T2f-final-fix-2: live token-usage ring next to the
                  attachment button. Stays mounted but invisible
                  until the first TASK_USAGE event arrives. */}
              {tokenUsage && (
                <TokenRing
                  used={tokenUsage.input + tokenUsage.output}
                  contextWindow={tokenUsage.contextWindow}
                  cacheRead={tokenUsage.cacheRead}
                  cacheCreation={tokenUsage.cacheCreation}
                  inputTokens={tokenUsage.input}
                />
              )}

              {/* T2s-3 — permission-mode dropdown (default / auto / full).
                  Only rendered when the parent wires the handler — keeps
                  any future "minimal mode" surface free of the pill. */}
              {onPermissionModeChange && (
                <PermissionModeSelector mode={permissionMode} onChange={onPermissionModeChange} disabled={disabled} />
              )}
            </div>

            <div className="flex items-center gap-2">
              {onModelChange && (
                <div ref={modelMenuRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setIsModelMenuOpen(open => !open)}
                    disabled={disabled || (availableModels.length === 0 && availableSpeechToTextModels.length === 0)}
                    aria-haspopup="menu"
                    aria-expanded={isModelMenuOpen}
                    className={`browd-model-trigger inline-flex items-center gap-2 rounded-full bg-[var(--browd-panel-strong)] px-3 py-1.5 text-sm text-[var(--browd-text)] transition-colors hover:bg-[var(--browd-control-hover)] disabled:cursor-not-allowed disabled:opacity-50 ${
                      layoutMode === 'tight'
                        ? 'max-w-[154px]'
                        : layoutMode === 'compact'
                          ? 'max-w-[172px]'
                          : 'max-w-[188px]'
                    }`}>
                    <span className="min-w-0 truncate font-medium text-[var(--browd-text)]">
                      {t('chat_input_models_button')}
                    </span>
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
                        <div className="mb-2 text-sm text-[var(--browd-faint)]">{t('chat_input_models_role')}</div>
                        {/* T2f-clean-finish-3 — single row of three roles the
                            user actively switches in chat: Planner, Navigator,
                            STT. Judge is a service config (Settings → Models)
                            because it's used by runtime verifier / eval grader,
                            not directly during chat. Tooltip explanations live
                            in Settings, not here — keep the picker minimal. */}
                        <div className="flex flex-wrap items-center gap-4">
                          {(['planner', 'navigator', 'stt'] as const).map(role => {
                            const isSelected = role === activeModelRole;
                            const label =
                              role === 'planner'
                                ? t('options_models_agents_planner_name')
                                : role === 'navigator'
                                  ? t('options_models_agents_navigator_name')
                                  : 'STT';
                            return (
                              <button
                                key={role}
                                type="button"
                                onClick={() => {
                                  setActiveModelRole(role);
                                  if (role !== 'stt') {
                                    onActiveAgentChange?.(role as QuickAgent);
                                  }
                                }}
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
                        {t('chat_input_models_model')}
                      </div>
                      <div className="max-h-72 overflow-y-auto">
                        {visibleModels.map(({ provider, providerName, model }) => {
                          const value = `${provider}>${model}`;
                          const isSelected = value === currentSelectedModel;
                          return (
                            <button
                              key={value}
                              type="button"
                              role="menuitemradio"
                              aria-checked={isSelected}
                              onClick={() => {
                                if (activeModelRole === 'stt') {
                                  onSpeechToTextModelChange?.(value);
                                  return;
                                }

                                onModelChange(activeModelRole, value);
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
              {onAgentTabFocusToggle && !historicalSessionId && (
                <button
                  type="button"
                  onClick={onAgentTabFocusToggle}
                  disabled={disabled}
                  aria-label={
                    agentTabFocusMode === 'foreground'
                      ? t('chat_input_tabFocus_foreground_label')
                      : t('chat_input_tabFocus_background_label')
                  }
                  title={
                    agentTabFocusMode === 'foreground'
                      ? t('chat_input_tabFocus_foreground_tip')
                      : t('chat_input_tabFocus_background_tip')
                  }
                  className={`rounded-md p-1.5 transition-colors ${
                    disabled
                      ? 'cursor-not-allowed opacity-50'
                      : agentTabFocusMode === 'foreground'
                        ? 'bg-[var(--browd-accent)]/15 text-[var(--browd-accent)] hover:bg-[var(--browd-accent)]/25'
                        : 'browd-icon-button'
                  }`}>
                  {agentTabFocusMode === 'foreground' ? (
                    <FaEye className="size-4" />
                  ) : (
                    <FaEyeSlash className="size-4" />
                  )}
                </button>
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
