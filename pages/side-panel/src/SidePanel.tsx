/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback, useRef } from 'react';
import { FiGithub, FiSettings } from 'react-icons/fi';
import { PiPlusBold } from 'react-icons/pi';
import { GrHistory } from 'react-icons/gr';
import {
  type AppearanceTheme,
  type ProviderConfig,
  type Message,
  Actors,
  chatHistoryStore,
  agentModelStore,
  generalSettingsStore,
  llmProviderStore,
  llmProviderModelNames,
  getSpeechToTextOptions,
  getJudgeOptions,
  getDefaultAgentModelParams,
  AgentNameEnum,
  ProviderTypeEnum,
  speechToTextModelStore,
  judgeModelStore,
  agentTabFocusStore,
  type AgentTabFocusMode,
} from '@extension/storage';
import favoritesStorage, { type FavoritePrompt } from '@extension/storage/lib/prompt/favorites';
import { t } from '@extension/i18n';
import MessageList from './components/MessageList';
import { PlanPinned } from './components/PlanPinned';
import { buildPriorMessagesForAgent } from './utils';
import ChatInput, { type ChatInputContentController } from './components/ChatInput';
import ChatHistoryList from './components/ChatHistoryList';
import BookmarkList from './components/BookmarkList';
import { HITLPrompt } from './components/HITLPrompt';
import { TracePanel, type TraceEntry } from './components/TracePanel';
import { EventType, type AgentEvent, ExecutionState } from './types/event';
import type { HITLRequest, HITLDecision } from '../../../chrome-extension/src/background/agent/hitl/types';
import { HITL_REQUEST_MESSAGE } from '../../../chrome-extension/src/background/agent/hitl/types';
import './SidePanel.css';

type ModelOption = {
  provider: string;
  providerName: string;
  model: string;
};

type QuickAgent = 'planner' | 'navigator';
const LANGUAGE_OVERRIDE_KEY = 'browd-interface-language';

function isOpenAIReasoningModel(modelName: string): boolean {
  let modelNameWithoutProvider = modelName;
  if (modelNameWithoutProvider.startsWith('openai/')) {
    modelNameWithoutProvider = modelNameWithoutProvider.substring(7);
  }
  return (
    modelNameWithoutProvider.startsWith('o') ||
    (modelNameWithoutProvider.startsWith('gpt-5') && !modelNameWithoutProvider.startsWith('gpt-5-chat'))
  );
}

function isAnthropicModel(modelName: string): boolean {
  return modelName.startsWith('claude-');
}

function getProviderModels(providerId: string, config: ProviderConfig): string[] {
  if (config.type === ProviderTypeEnum.AzureOpenAI) {
    return config.azureDeploymentNames || [];
  }

  return config.modelNames || llmProviderModelNames[providerId as keyof typeof llmProviderModelNames] || [];
}

function writeAsciiString(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function encodeAudioBufferAsWav(audioBuffer: AudioBuffer): ArrayBuffer {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = audioBuffer.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  let offset = 0;

  writeAsciiString(view, offset, 'RIFF');
  offset += 4;
  view.setUint32(offset, 36 + dataLength, true);
  offset += 4;
  writeAsciiString(view, offset, 'WAVE');
  offset += 4;
  writeAsciiString(view, offset, 'fmt ');
  offset += 4;
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, numChannels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * blockAlign, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, bytesPerSample * 8, true);
  offset += 2;
  writeAsciiString(view, offset, 'data');
  offset += 4;
  view.setUint32(offset, dataLength, true);
  offset += 4;

  const channels = Array.from({ length: numChannels }, (_, channelIndex) => audioBuffer.getChannelData(channelIndex));

  for (let sampleIndex = 0; sampleIndex < audioBuffer.length; sampleIndex += 1) {
    for (let channelIndex = 0; channelIndex < numChannels; channelIndex += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channelIndex][sampleIndex]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return buffer;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error('Failed to read audio blob'));
    reader.readAsDataURL(blob);
  });
}

async function convertRecordedAudioToWavDataUrl(audioBlob: Blob): Promise<string> {
  const audioContext = new AudioContext();

  try {
    const audioBuffer = await audioContext.decodeAudioData(await audioBlob.arrayBuffer());
    const wavBlob = new Blob([encodeAudioBufferAsWav(audioBuffer)], { type: 'audio/wav' });
    return await blobToDataUrl(wavBlob);
  } finally {
    await audioContext.close();
  }
}

// Declare chrome API types
declare global {
  interface Window {
    chrome: typeof chrome;
  }
}

const SidePanel = () => {
  const progressMessage = 'Showing progress...';
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputEnabled, setInputEnabled] = useState(true);
  const [showStopButton, setShowStopButton] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [chatSessions, setChatSessions] = useState<Array<{ id: string; title: string; createdAt: number }>>([]);
  const [isFollowUpMode, setIsFollowUpMode] = useState(false);
  const [isHistoricalSession, setIsHistoricalSession] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [appearanceTheme, setAppearanceTheme] = useState<AppearanceTheme>('light');
  const [favoritePrompts, setFavoritePrompts] = useState<FavoritePrompt[]>([]);
  const [hasConfiguredModels, setHasConfiguredModels] = useState<boolean | null>(null); // null = loading, false = no models, true = has models
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [availableSpeechToTextModels, setAvailableSpeechToTextModels] = useState<ModelOption[]>([]);
  const [availableJudgeModels, setAvailableJudgeModels] = useState<ModelOption[]>([]);
  const [selectedAgentModels, setSelectedAgentModels] = useState<Record<QuickAgent, string>>({
    planner: '',
    navigator: '',
  });
  const [selectedSpeechToTextModel, setSelectedSpeechToTextModel] = useState('');
  const [selectedJudgeModel, setSelectedJudgeModel] = useState('');
  // T2f-tab-iso-2 — agent-tab focus mode. Persisted in storage; live-updated.
  const [agentTabFocusMode, setAgentTabFocusMode] = useState<AgentTabFocusMode>('foreground');
  const [activeQuickAgent, setActiveQuickAgent] = useState<QuickAgent>('navigator');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessingSpeech, setIsProcessingSpeech] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayEnabled, setReplayEnabled] = useState(false);
  const [hitlRequest, setHitlRequest] = useState<HITLRequest | null>(null);
  const [traceEntries, setTraceEntries] = useState<TraceEntry[]>([]);
  // T2f-1.5: bumped each time a screenshot trace event arrives so the
  // flash overlay div re-mounts and replays its CSS animation. Value
  // doesn't otherwise matter — the key is only for animation re-trigger.
  const [screenshotFlashKey, setScreenshotFlashKey] = useState(0);
  // T2f-final-2: cumulative token usage for the current chat session.
  // Reset on new chat / history-load. Each TASK_USAGE event from the
  // agent runtime bumps the running totals.
  const [tokenUsage, setTokenUsage] = useState<{ input: number; output: number; contextWindow: number } | null>(null);
  // T2f-final-3 — single shared screenshot lightbox URL. Both
  // MessageList thumbnails and TracePanel previews open this; window.open
  // with a data: URL is blocked in Chromium so we render in-panel.
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  // T2f-plan-pinned — current plan as a compact pinned checklist
  // above the message list, instead of an inline chat message that
  // scrolls away. Cleared between runs.
  const [currentPlan, setCurrentPlan] = useState<{ text: string; done: boolean }[] | null>(null);
  // T2v — live status strip above TRACE. Holds the agent runtime's
  // most recent "what's happening right now" signal (token streaming,
  // tool call in flight, planner/replanner round). Empty between
  // calls — empty for >5s = stuck. Driven by ExecutionState.TASK_LIVE.
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  useEffect(() => {
    if (!lightboxUrl) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxUrl(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightboxUrl]);
  // T2f-thinking-split / T2f-thinking-live: tracks the start index of
  // the current agent run so TASK_OK / TASK_FAIL can mark the LAST
  // message as 'final'. The intermediate ones are tagged 'thinking'
  // at appendMessage time via currentPhaseRef so the collapsible
  // group renders LIVE, not only after the run finishes.
  const runStartIdxRef = useRef<number | null>(null);
  const currentPhaseRef = useRef<'thinking' | null>(null);
  // T2f-clean-finish — state mirrors of the refs above so MessageList
  // re-renders when a run starts / ends. Refs alone don't trigger
  // re-render. liveRunStartIdx tells thinking-groups whether they are
  // the live run (start expanded). collapseSignal increments on every
  // TASK_OK/FAIL/CANCEL so the live group auto-collapses.
  const [liveRunStartIdx, setLiveRunStartIdx] = useState<number | null>(null);
  const [collapseSignal, setCollapseSignal] = useState(0);
  const sessionIdRef = useRef<string | null>(null);
  const isReplayingRef = useRef<boolean>(false);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputContentControllerRef = useRef<ChatInputContentController | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);
  const brandLogoSrc = chrome.runtime.getURL(appearanceTheme === 'dark' ? 'browd-logo-dark.svg' : 'browd-logo.svg');

  // Check for dark mode preference
  useEffect(() => {
    const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    setIsDarkMode(darkModeMediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsDarkMode(e.matches);
    };

    darkModeMediaQuery.addEventListener('change', handleChange);
    return () => darkModeMediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Check if models are configured
  const checkModelConfiguration = useCallback(async () => {
    try {
      const configuredAgents = await agentModelStore.getConfiguredAgents();

      // Check if at least one agent (preferably Navigator) is configured
      const hasAtLeastOneModel = configuredAgents.length > 0;
      setHasConfiguredModels(hasAtLeastOneModel);
    } catch (error) {
      console.error('Error checking model configuration:', error);
      setHasConfiguredModels(false);
    }
  }, []);

  // Load general settings to check if replay is enabled
  const loadGeneralSettings = useCallback(async () => {
    try {
      const settings = await generalSettingsStore.getSettings();
      setReplayEnabled(settings.replayHistoricalTasks);
      setAppearanceTheme(settings.appearanceTheme);
      window.localStorage.setItem(LANGUAGE_OVERRIDE_KEY, settings.interfaceLanguage);
    } catch (error) {
      console.error('Error loading general settings:', error);
      setReplayEnabled(false);
      setAppearanceTheme('light');
    }
  }, []);

  const loadAvailableModels = useCallback(async () => {
    try {
      const providers = await llmProviderStore.getAllProviders();
      const models: ModelOption[] = [];

      for (const [providerId, config] of Object.entries(providers)) {
        const providerModels = getProviderModels(providerId, config);
        for (const model of providerModels) {
          models.push({
            provider: providerId,
            providerName: config.name || providerId,
            model,
          });
        }
      }

      setAvailableModels(models);

      const speechToTextOptions = getSpeechToTextOptions(providers).map(option => ({
        provider: option.provider,
        providerName: option.providerName,
        model: option.modelName,
      }));

      const openRouterProviders = Object.entries(providers).filter(
        ([, config]) => config.type === ProviderTypeEnum.OpenRouter,
      );

      if (openRouterProviders.length > 0) {
        try {
          const response = await fetch('https://openrouter.ai/api/v1/models');
          if (!response.ok) {
            throw new Error(`OpenRouter models request failed: ${response.status}`);
          }

          const payload = (await response.json()) as {
            data?: Array<{ id?: string; architecture?: { input_modalities?: string[] } }>;
          };

          const remoteAudioModels = (payload.data || [])
            .filter(model => (model.architecture?.input_modalities || []).includes('audio'))
            .map(model => model.id)
            .filter((modelId): modelId is string => Boolean(modelId))
            .filter(modelId => {
              const normalizedModelId = modelId.toLowerCase();
              return !normalizedModelId.includes('whisper') && !normalizedModelId.includes('transcribe');
            })
            .sort((left, right) => left.localeCompare(right));

          const mergedOptions = new Map(
            speechToTextOptions.map(option => [`${option.provider}>${option.model}`, option] as const),
          );

          for (const [providerId, config] of openRouterProviders) {
            const providerName = config.name || providerId;
            for (const model of remoteAudioModels) {
              mergedOptions.set(`${providerId}>${model}`, {
                provider: providerId,
                providerName,
                model,
              });
            }
          }

          setAvailableSpeechToTextModels(
            Array.from(mergedOptions.values()).sort((left, right) =>
              `${left.providerName}>${left.model}`.localeCompare(`${right.providerName}>${right.model}`),
            ),
          );
          return;
        } catch (openRouterError) {
          console.error('Error loading OpenRouter speech-to-text models:', openRouterError);
        }
      }

      setAvailableSpeechToTextModels(speechToTextOptions);
      // T3-judge — judge options share the same shape as planner/navigator
      // available models. Keep separate list so user can pick a cheap
      // grader independent of agent runtime models.
      const judgeOptions = getJudgeOptions(providers).map(option => ({
        provider: option.provider,
        providerName: option.providerName,
        model: option.modelName,
      }));
      setAvailableJudgeModels(judgeOptions);
    } catch (error) {
      console.error('Error loading available models:', error);
      setAvailableModels([]);
      setAvailableSpeechToTextModels([]);
      setAvailableJudgeModels([]);
    }
  }, []);

  const loadAgentModels = useCallback(async () => {
    try {
      const plannerConfig = await agentModelStore.getAgentModel(AgentNameEnum.Planner);
      const navigatorConfig = await agentModelStore.getAgentModel(AgentNameEnum.Navigator);
      const speechToTextConfig = await speechToTextModelStore.getSpeechToTextModel();
      const judgeConfig = await judgeModelStore.getJudgeModel();
      const tabFocusMode = await agentTabFocusStore.getMode();
      setSelectedAgentModels({
        planner: plannerConfig ? `${plannerConfig.provider}>${plannerConfig.modelName}` : '',
        navigator: navigatorConfig ? `${navigatorConfig.provider}>${navigatorConfig.modelName}` : '',
      });
      setSelectedSpeechToTextModel(
        speechToTextConfig ? `${speechToTextConfig.provider}>${speechToTextConfig.modelName}` : '',
      );
      setSelectedJudgeModel(judgeConfig ? `${judgeConfig.provider}>${judgeConfig.modelName}` : '');
      setAgentTabFocusMode(tabFocusMode);
    } catch (error) {
      console.error('Error loading agent models:', error);
      setSelectedAgentModels({ planner: '', navigator: '' });
      setSelectedSpeechToTextModel('');
      setSelectedJudgeModel('');
      setAgentTabFocusMode('foreground');
    }
  }, []);

  // Check model configuration on mount
  useEffect(() => {
    checkModelConfiguration();
    loadGeneralSettings();
    loadAvailableModels();
    loadAgentModels();
  }, [checkModelConfiguration, loadGeneralSettings, loadAvailableModels, loadAgentModels]);

  // Re-check model configuration when the side panel becomes visible again
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        // Panel became visible, re-check configuration and settings
        checkModelConfiguration();
        loadGeneralSettings();
        loadAvailableModels();
        loadAgentModels();
      }
    };

    const handleFocus = () => {
      // Panel gained focus, re-check configuration and settings
      checkModelConfiguration();
      loadGeneralSettings();
      loadAvailableModels();
      loadAgentModels();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [checkModelConfiguration, loadGeneralSettings, loadAvailableModels, loadAgentModels]);

  const handleAgentModelChange = useCallback(
    async (agent: QuickAgent, modelValue: string) => {
      setSelectedAgentModels(prev => ({
        ...prev,
        [agent]: modelValue,
      }));

      try {
        const storageAgent = agent === 'planner' ? AgentNameEnum.Planner : AgentNameEnum.Navigator;

        if (!modelValue) {
          await agentModelStore.resetAgentModel(storageAgent);
          await checkModelConfiguration();
          return;
        }

        const [provider, modelName] = modelValue.split('>');
        if (!provider || !modelName) return;

        const existingConfig = await agentModelStore.getAgentModel(storageAgent);
        const newParameters = getDefaultAgentModelParams(provider, storageAgent);
        const parametersToSave = isAnthropicModel(modelName)
          ? { temperature: newParameters.temperature }
          : newParameters;

        await agentModelStore.setAgentModel(storageAgent, {
          provider,
          modelName,
          systemPrompt: existingConfig?.systemPrompt,
          parameters: parametersToSave,
          reasoningEffort:
            isOpenAIReasoningModel(modelName) && storageAgent === AgentNameEnum.Navigator ? 'minimal' : undefined,
        });

        await checkModelConfiguration();
      } catch (error) {
        console.error(`Error saving ${agent} model:`, error);
      }
    },
    [checkModelConfiguration],
  );

  const handleSpeechToTextModelChange = useCallback(async (modelValue: string) => {
    setSelectedSpeechToTextModel(modelValue);

    try {
      if (!modelValue) {
        await speechToTextModelStore.resetSpeechToTextModel();
        return;
      }

      const [provider, modelName] = modelValue.split('>');
      if (!provider || !modelName) {
        return;
      }

      await speechToTextModelStore.setSpeechToTextModel({
        provider,
        modelName,
      });
    } catch (error) {
      console.error('Error saving speech-to-text model:', error);
    }
  }, []);

  // T2f-tab-iso-2 — toggle agent-tab focus. Persists to storage; the
  // background SW reads it on next openAgentTab() (i.e. next TASK_START).
  const handleAgentTabFocusToggle = useCallback(() => {
    setAgentTabFocusMode(prev => {
      const next: AgentTabFocusMode = prev === 'foreground' ? 'background' : 'foreground';
      void agentTabFocusStore.setMode(next);
      return next;
    });
  }, []);

  // T3-judge — handler mirrors STT. Persists eval grader choice.
  const handleJudgeModelChange = useCallback(async (modelValue: string) => {
    setSelectedJudgeModel(modelValue);
    try {
      if (!modelValue) {
        await judgeModelStore.resetJudgeModel();
        return;
      }
      const [provider, modelName] = modelValue.split('>');
      if (!provider || !modelName) return;
      await judgeModelStore.setJudgeModel({ provider, modelName });
    } catch (error) {
      console.error('Error saving judge model:', error);
    }
  }, []);

  useEffect(() => {
    sessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    isReplayingRef.current = isReplaying;
  }, [isReplaying]);

  const appendMessage = useCallback((newMessage: Message, sessionId?: string | null) => {
    // Don't save progress messages
    const isProgressMessage = newMessage.content === progressMessage;

    // T2f-thinking-live: tag agent-emitted messages as 'thinking'
    // immediately while a run is in flight (currentPhaseRef set on
    // TASK_START, cleared on TASK_OK/FAIL/CANCEL). User-input
    // messages stay phase-undefined so they render outside the
    // collapsible group. Already-tagged messages (e.g. final
    // override) are kept as is.
    let staged = newMessage;
    if (!staged.phase && staged.actor !== Actors.USER && !isProgressMessage && currentPhaseRef.current === 'thinking') {
      staged = { ...staged, phase: 'thinking' };
    }

    setMessages(prev => {
      const filteredMessages = prev.filter((msg, idx) => !(msg.content === progressMessage && idx === prev.length - 1));
      return [...filteredMessages, staged];
    });

    // Use provided sessionId if available, otherwise fall back to sessionIdRef.current
    const effectiveSessionId = sessionId !== undefined ? sessionId : sessionIdRef.current;

    console.log('sessionId', effectiveSessionId);

    // Save message to storage if we have a session and it's not a progress message
    if (effectiveSessionId && !isProgressMessage) {
      // Persist the original message (without phase) — phase is a
      // runtime UI concern only.
      chatHistoryStore
        .addMessage(effectiveSessionId, newMessage)
        .catch(err => console.error('Failed to save message to history:', err));
    }
  }, []);

  const handleTaskState = useCallback(
    (event: AgentEvent) => {
      const { actor, state, timestamp, data } = event;
      const content = data?.details;
      let skip = true;
      let displayProgress = false;

      switch (actor) {
        case Actors.SYSTEM:
          switch (state) {
            case ExecutionState.TASK_START:
              // Reset historical session flag and trace when a new task starts
              setIsHistoricalSession(false);
              setTraceEntries([]);
              setLiveStatus(null);
              // T2f-thinking-live: open the live thinking phase so
              // every appendMessage during this run gets phase
              // 'thinking' immediately (collapsible visible while
              // the agent is still working).
              setMessages(prev => {
                runStartIdxRef.current = prev.length;
                setLiveRunStartIdx(prev.length);
                return prev;
              });
              currentPhaseRef.current = 'thinking';
              break;
            case ExecutionState.TASK_OK:
              setIsFollowUpMode(true);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              // T2f-thinking-live: thinking is already tagged
              // live; here we only need to lift the LAST run message
              // out of the collapsible (it's the final answer).
              currentPhaseRef.current = null;
              // T2f-clean-finish — clear ref UNCONDITIONALLY so it
              // can never drift from state (liveRunStartIdx). Edge
              // case: TASK_OK with empty run (start >= prev.length)
              // used to leave the ref pointing at an old slice.
              {
                const startedAt = runStartIdxRef.current;
                runStartIdxRef.current = null;
                setMessages(prev => {
                  if (startedAt === null || startedAt >= prev.length) return prev;
                  return prev.map((m, i) => {
                    if (i < startedAt) return m;
                    if (i === prev.length - 1) return { ...m, phase: 'final' as const };
                    return m;
                  });
                });
              }
              setLiveRunStartIdx(null);
              setCollapseSignal(s => s + 1);
              setLiveStatus(null);
              break;
            case ExecutionState.TASK_FAIL:
              setIsFollowUpMode(true);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              skip = false;
              currentPhaseRef.current = null;
              // T2f-clean-finish — clear ref unconditionally (see TASK_OK).
              {
                const startedAt = runStartIdxRef.current;
                runStartIdxRef.current = null;
                setMessages(prev => {
                  if (startedAt === null || startedAt >= prev.length) return prev;
                  return prev.map((m, i) => {
                    if (i < startedAt) return m;
                    if (i === prev.length - 1) return { ...m, phase: 'final' as const };
                    return m;
                  });
                });
              }
              setLiveRunStartIdx(null);
              setCollapseSignal(s => s + 1);
              setLiveStatus(null);
              break;
            case ExecutionState.TASK_CANCEL:
              setIsFollowUpMode(false);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              skip = false;
              currentPhaseRef.current = null;
              // On cancel everything in the slice stays 'thinking'
              // (no final answer was produced). runStartIdxRef
              // already null because thinking is set live; we just
              // close the run.
              runStartIdxRef.current = null;
              setLiveRunStartIdx(null);
              setCollapseSignal(s => s + 1);
              setLiveStatus(null);
              break;
            case ExecutionState.TASK_PAUSE:
              break;
            case ExecutionState.TASK_RESUME:
              break;
            case ExecutionState.TASK_LIVE: {
              // T2v — token-level live indicator. `details` is a JSON
              // `LiveEvent` from streamBridge. Render a compact status
              // string in the strip above TRACE; empty string clears it.
              try {
                const ev = JSON.parse(content ?? '{}') as {
                  kind: string;
                  model?: string;
                  tokensSoFar?: number;
                  ratePerSec?: number;
                  name?: string;
                  argsPreview?: string;
                  ok?: boolean;
                  ms?: number;
                  state?: 'start' | 'end';
                };
                if (ev.kind === 'llm_streaming') {
                  const tk = ev.tokensSoFar ?? 0;
                  const rate = ev.ratePerSec ?? 0;
                  setLiveStatus(`${ev.model ?? 'model'} · ${tk} tokens · ${rate} t/s`);
                } else if (ev.kind === 'tool_start') {
                  const args = ev.argsPreview ? ` ${ev.argsPreview}` : '';
                  setLiveStatus(`running: ${ev.name ?? 'tool'}${args}`);
                } else if (ev.kind === 'tool_end') {
                  setLiveStatus(null);
                } else if (ev.kind === 'node' && ev.state === 'start') {
                  setLiveStatus(`${ev.name}…`);
                } else if (ev.kind === 'idle') {
                  setLiveStatus(null);
                }
              } catch {
                // ignore malformed payloads — strip just stays as-is
              }
              return;
            }
            case ExecutionState.TASK_USAGE: {
              // T2f-final-2 / T2f-final-fix: parse cumulative token
              // totals for this invoke and add them to the session
              // running total. Logged so a DevTools open on the side
              // panel makes it obvious whether the event is reaching
              // the UI (vs. dropped silently by the provider).
              try {
                const parsed = JSON.parse(content ?? '{}') as {
                  inputTokens?: number;
                  outputTokens?: number;
                  contextWindow?: number;
                };
                const cw = parsed.contextWindow ?? 100_000;
                console.log('[Browd] TASK_USAGE', parsed);
                setTokenUsage(prev => ({
                  input: (prev?.input ?? 0) + (parsed.inputTokens ?? 0),
                  output: (prev?.output ?? 0) + (parsed.outputTokens ?? 0),
                  contextWindow: cw,
                }));
              } catch (err) {
                console.warn('[Browd] TASK_USAGE parse failed', err, content);
              }
              return;
            }
            default:
              console.error('Invalid task state', state);
              return;
          }
          break;
        case Actors.USER:
          break;
        case Actors.PLANNER:
          switch (state) {
            case ExecutionState.STEP_START:
              displayProgress = true;
              break;
            case ExecutionState.STEP_OK:
              // T2f-replan: planner / replanner can emit a JSON
              // checklist payload as content. Side-panel renders
              // it as a checkbox list (MessageList ScreenshotThumb
              // analogue). The same actor+state is reused for the
              // final user-facing answer too — distinguish by JSON
              // shape.
              if (typeof content === 'string' && content.trim().startsWith('{"type":"plan"')) {
                try {
                  const parsed = JSON.parse(content) as {
                    type: string;
                    items?: { text: string; done: boolean }[];
                  };
                  if (parsed.type === 'plan' && Array.isArray(parsed.items)) {
                    // T2f-plan-pinned: render checklist as a pinned
                    // affordance above the chat instead of an inline
                    // message. Updates in place as planner /
                    // replanner re-emit.
                    setCurrentPlan(parsed.items);
                    return;
                  }
                } catch {
                  // fall through to normal handling
                }
              }
              skip = false;
              break;
            case ExecutionState.STEP_FAIL:
              skip = false;
              break;
            case ExecutionState.STEP_CANCEL:
              break;
            default:
              console.error('Invalid step state', state);
              return;
          }
          break;
        case Actors.NAVIGATOR:
          switch (state) {
            case ExecutionState.STEP_START:
              displayProgress = true;
              break;
            case ExecutionState.STEP_OK:
              displayProgress = false;
              break;
            case ExecutionState.STEP_FAIL:
              skip = false;
              displayProgress = false;
              break;
            case ExecutionState.STEP_CANCEL:
              displayProgress = false;
              break;
            case ExecutionState.ACT_START:
              if (content !== 'cache_content') {
                // skip to display caching content
                skip = false;
              }
              break;
            case ExecutionState.ACT_OK:
              skip = !isReplayingRef.current;
              break;
            case ExecutionState.ACT_FAIL:
              skip = false;
              break;
            case ExecutionState.STEP_TRACE: {
              const raw = content ?? '';
              // Try structured payload first (new T0 path). Falls back to
              // the legacy "✓ tool: reason" string format if not JSON.
              if (raw.startsWith('{')) {
                try {
                  const parsed = JSON.parse(raw) as { structured?: unknown };
                  if (parsed.structured && typeof parsed.structured === 'object') {
                    const structured = parsed.structured as TraceEntry & {
                      tool?: string;
                      imageThumbBase64?: string;
                      imageThumbMime?: string;
                      imageFullBase64?: string;
                      imageFullMime?: string;
                    };
                    setTraceEntries(prev => [...prev.slice(-19), structured as TraceEntry]);
                    // T2f-1.5: when the screenshot tool fires, also drop
                    // an inline preview into the chat (Navigator actor)
                    // and bump the flash-overlay key so the iOS-style
                    // capture animation replays. This message is
                    // ephemeral — we deliberately do NOT pass a
                    // sessionId so chatHistoryStore is not touched
                    // (the bytes shouldn't bloat the persistent log).
                    if (structured.tool === 'screenshot' && structured.imageThumbBase64) {
                      // T2f-final-fix-3 diag: log payload sizes so we
                      // can confirm the full-resolution JPEG actually
                      // travelled through the runtime port (Chromium
                      // caps individual messages around 64 MB).
                      console.log(
                        '[Browd] screenshot trace',
                        'thumb=',
                        structured.imageThumbBase64?.length ?? 0,
                        'full=',
                        structured.imageFullBase64?.length ?? 0,
                      );
                      setScreenshotFlashKey(k => k + 1);
                      setMessages(prev => [
                        ...prev.filter(m => !(m.content === progressMessage && m === prev[prev.length - 1])),
                        {
                          actor: Actors.NAVIGATOR,
                          content: 'Captured screenshot',
                          timestamp: Date.now(),
                          imageThumbBase64: structured.imageThumbBase64,
                          imageThumbMime: structured.imageThumbMime,
                          imageFullBase64: structured.imageFullBase64,
                          imageFullMime: structured.imageFullMime,
                          // T2f-thinking-live: tag screenshot
                          // entries the same way appendMessage does
                          // so they fold into the live group too.
                          phase: currentPhaseRef.current === 'thinking' ? 'thinking' : undefined,
                        },
                      ]);
                    }
                    return;
                  }
                } catch {
                  // fall through to legacy parse
                }
              }
              const icon = raw.startsWith('✓') ? ('✓' as const) : raw.startsWith('✗') ? ('✗' as const) : ('→' as const);
              const label = raw.replace(/^[✓✗→]\s*/, '');
              setTraceEntries(prev => [...prev.slice(-19), { icon, label }]);
              return;
            }
            default:
              console.error('Invalid action', state);
              return;
          }
          break;
        case Actors.VALIDATOR:
          // Handle legacy validator events from historical messages
          switch (state) {
            case ExecutionState.STEP_START:
              displayProgress = true;
              break;
            case ExecutionState.STEP_OK:
              skip = false;
              break;
            case ExecutionState.STEP_FAIL:
              skip = false;
              break;
            default:
              console.error('Invalid validation', state);
              return;
          }
          break;
        default:
          console.error('Unknown actor', actor);
          return;
      }

      if (!skip) {
        appendMessage({
          actor,
          content: content || '',
          timestamp: timestamp,
        });
      }

      if (displayProgress) {
        appendMessage({
          actor,
          content: progressMessage,
          timestamp: timestamp,
        });
      }
    },
    [appendMessage],
  );

  // Stop heartbeat and close connection
  const stopConnection = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (portRef.current) {
      portRef.current.disconnect();
      portRef.current = null;
    }
  }, []);

  // Setup connection management
  const setupConnection = useCallback(() => {
    // Only setup if no existing connection
    if (portRef.current) {
      return;
    }

    try {
      portRef.current = chrome.runtime.connect({ name: 'side-panel-connection' });

      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      portRef.current.onMessage.addListener((message: any) => {
        // Add type checking for message
        if (message && message.type === EventType.EXECUTION) {
          handleTaskState(message);
        } else if (message && message.type === 'error') {
          // Handle error messages from service worker
          appendMessage({
            actor: Actors.SYSTEM,
            content: message.error || t('errors_unknown'),
            timestamp: Date.now(),
          });
          setInputEnabled(true);
          setShowStopButton(false);
        } else if (message && message.type === 'speech_to_text_result') {
          // Handle speech-to-text result
          if (message.text && inputContentControllerRef.current) {
            inputContentControllerRef.current.appendText(message.text);
          }
          setIsProcessingSpeech(false);
        } else if (message && message.type === 'speech_to_text_error') {
          // Handle speech-to-text error
          appendMessage({
            actor: Actors.SYSTEM,
            content: message.error || t('chat_stt_recognitionFailed'),
            timestamp: Date.now(),
          });
          setIsProcessingSpeech(false);
        } else if (message && message.type === 'heartbeat_ack') {
          console.log('Heartbeat acknowledged');
        } else if (message && message.type === HITL_REQUEST_MESSAGE) {
          setHitlRequest(message.payload as HITLRequest);
        }
      });

      portRef.current.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        console.log('Connection disconnected', error ? `Error: ${error.message}` : '');
        portRef.current = null;
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }
        setInputEnabled(true);
        setShowStopButton(false);
      });

      // Setup heartbeat interval
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }

      heartbeatIntervalRef.current = window.setInterval(() => {
        if (portRef.current?.name === 'side-panel-connection') {
          try {
            portRef.current.postMessage({ type: 'heartbeat' });
          } catch (error) {
            console.error('Heartbeat failed:', error);
            stopConnection(); // Stop connection if heartbeat fails
          }
        } else {
          stopConnection(); // Stop if port is invalid
        }
      }, 25000);
    } catch (error) {
      console.error('Failed to establish connection:', error);
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('errors_conn_serviceWorker'),
        timestamp: Date.now(),
      });
      // Clear any references since connection failed
      portRef.current = null;
    }
  }, [handleTaskState, appendMessage, stopConnection]);

  // Add safety check for message sending
  const sendMessage = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    (message: any) => {
      if (portRef.current?.name !== 'side-panel-connection') {
        throw new Error('No valid connection available');
      }
      try {
        portRef.current.postMessage(message);
      } catch (error) {
        console.error('Failed to send message:', error);
        stopConnection(); // Stop connection when message sending fails
        throw error;
      }
    },
    [stopConnection],
  );

  const submitHITLDecision = useCallback(
    (id: string, decision: HITLDecision) => {
      try {
        sendMessage({ type: 'hitl_decision', id, decision });
      } catch (e) {
        console.error('Failed to submit HITL decision', e);
      }
      setHitlRequest(null);
    },
    [sendMessage],
  );

  // Handle replay command
  const handleReplay = async (historySessionId: string): Promise<void> => {
    try {
      // Check if replay is enabled in settings
      if (!replayEnabled) {
        appendMessage({
          actor: Actors.SYSTEM,
          content: t('chat_replay_disabled'),
          timestamp: Date.now(),
        });
        return;
      }

      // Check if history exists using loadAgentStepHistory
      const historyData = await chatHistoryStore.loadAgentStepHistory(historySessionId);
      if (!historyData) {
        appendMessage({
          actor: Actors.SYSTEM,
          content: t('chat_replay_noHistory', historySessionId.substring(0, 20)),
          timestamp: Date.now(),
        });
        return;
      }

      // Get current tab ID
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) {
        throw new Error('No active tab found');
      }

      // Clear messages if we're in a historical session
      if (isHistoricalSession) {
        setMessages([]);
      }

      // Create a new chat session for this replay task
      const newSession = await chatHistoryStore.createSession(`Replay of ${historySessionId.substring(0, 20)}...`);
      console.log('newSession for replay', newSession);

      // Store the new session ID in both state and ref
      const newTaskId = newSession.id;
      setCurrentSessionId(newTaskId);
      sessionIdRef.current = newTaskId;

      // Send replay command to background
      setInputEnabled(false);
      setShowStopButton(true);

      // Reset follow-up mode and historical session flags
      setIsFollowUpMode(false);
      setIsHistoricalSession(false);

      const userMessage = {
        actor: Actors.USER,
        content: `/replay ${historySessionId}`,
        timestamp: Date.now(),
      };

      // Add the user message to the new session
      appendMessage(userMessage, sessionIdRef.current);

      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // Send replay command to background with the task from history
      portRef.current?.postMessage({
        type: 'replay',
        taskId: newTaskId,
        tabId: tabId,
        historySessionId: historySessionId,
        task: historyData.task, // Add the task from history
      });

      appendMessage({
        actor: Actors.SYSTEM,
        content: t('chat_replay_starting', historyData.task),
        timestamp: Date.now(),
      });
      setIsReplaying(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('chat_replay_failed', errorMessage),
        timestamp: Date.now(),
      });
    }
  };

  // Handle chat commands that start with /
  const handleCommand = async (command: string): Promise<boolean> => {
    try {
      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // Handle different commands
      if (command === '/state') {
        portRef.current?.postMessage({
          type: 'state',
        });
        return true;
      }

      if (command === '/nohighlight') {
        portRef.current?.postMessage({
          type: 'nohighlight',
        });
        return true;
      }

      if (command.startsWith('/replay ')) {
        // Parse replay command: /replay <historySessionId>
        // Handle multiple spaces by filtering out empty strings
        const parts = command.split(' ').filter(part => part.trim() !== '');
        if (parts.length !== 2) {
          appendMessage({
            actor: Actors.SYSTEM,
            content: t('chat_replay_invalidArgs'),
            timestamp: Date.now(),
          });
          return true;
        }

        const historySessionId = parts[1];
        await handleReplay(historySessionId);
        return true;
      }

      // Unsupported command
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('errors_cmd_unknown', command),
        timestamp: Date.now(),
      });
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Command error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      return true;
    }
  };

  const handleSendMessage = async (text: string, displayText?: string) => {
    console.log('handleSendMessage', text);

    // Trim the input text first
    const trimmedText = text.trim();

    if (!trimmedText) return;

    // Check if the input is a command (starts with /)
    if (trimmedText.startsWith('/')) {
      // Process command and return if it was handled
      const wasHandled = await handleCommand(trimmedText);
      if (wasHandled) return;
    }

    // Block sending messages in historical sessions
    if (isHistoricalSession) {
      console.log('Cannot send messages in historical sessions');
      return;
    }

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) {
        throw new Error('No active tab found');
      }

      setInputEnabled(false);
      setShowStopButton(true);

      // Create a new chat session for this task if not in follow-up mode
      if (!isFollowUpMode) {
        // Use display text for session title if available, otherwise use full text
        const titleText = displayText || text;
        const newSession = await chatHistoryStore.createSession(
          titleText.substring(0, 50) + (titleText.length > 50 ? '...' : ''),
        );
        console.log('newSession', newSession);

        // Store the session ID in both state and ref
        const sessionId = newSession.id;
        setCurrentSessionId(sessionId);
        sessionIdRef.current = sessionId;
      }

      const userMessage = {
        actor: Actors.USER,
        content: displayText || text, // Use display text for chat UI, full text for background service
        timestamp: Date.now(),
      };

      // Pass the sessionId directly to appendMessage
      appendMessage(userMessage, sessionIdRef.current);

      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // T2h: ship the prior chat turns so the unified agent has
      // cross-task memory. We re-read from chatHistoryStore (rather
      // than the in-memory `messages` state) because that is the
      // persistent source of truth and includes the userMessage we
      // just appended above. Drop the trailing USER turn — it is the
      // task we are sending right now.
      const priorMessages = await buildPriorMessagesForAgent(sessionIdRef.current);

      // Send message using the utility function
      if (isFollowUpMode) {
        // Send as follow-up task
        await sendMessage({
          type: 'follow_up_task',
          task: text,
          taskId: sessionIdRef.current,
          tabId,
          priorMessages,
        });
        console.log('follow_up_task sent', text, tabId, sessionIdRef.current, priorMessages.length);
      } else {
        // Send as new task
        await sendMessage({
          type: 'new_task',
          task: text,
          taskId: sessionIdRef.current,
          tabId,
          priorMessages,
        });
        console.log('new_task sent', text, tabId, sessionIdRef.current, priorMessages.length);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      setInputEnabled(true);
      setShowStopButton(false);
      stopConnection();
    }
  };

  const handleStopTask = async () => {
    try {
      portRef.current?.postMessage({
        type: 'cancel_task',
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('cancel_task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
    }
    setInputEnabled(true);
    setShowStopButton(false);
  };

  const handleNewChat = () => {
    // Clear messages and start a new chat
    setMessages([]);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    setInputEnabled(true);
    setShowStopButton(false);
    setIsFollowUpMode(false);
    setIsHistoricalSession(false);
    setTokenUsage(null);
    setTraceEntries([]);
    setCurrentPlan(null);
    setLiveStatus(null);

    // Disconnect any existing connection
    stopConnection();
  };

  const loadChatSessions = useCallback(async () => {
    try {
      const sessions = await chatHistoryStore.getSessionsMetadata();
      setChatSessions(sessions.sort((a, b) => b.createdAt - a.createdAt));
    } catch (error) {
      console.error('Failed to load chat sessions:', error);
    }
  }, []);

  const handleLoadHistory = async () => {
    await loadChatSessions();
    setShowHistory(true);
  };

  const handleBackToChat = (reset = false) => {
    setShowHistory(false);
    if (reset) {
      setCurrentSessionId(null);
      setMessages([]);
      setIsFollowUpMode(false);
      setIsHistoricalSession(false);
    }
  };

  const handleSessionSelect = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);
      if (fullSession && fullSession.messages.length > 0) {
        setCurrentSessionId(fullSession.id);
        setMessages(fullSession.messages);
        setIsFollowUpMode(false);
        setIsHistoricalSession(true); // Mark this as a historical session
        console.log('history session selected', sessionId);
      }
      setShowHistory(false);
    } catch (error) {
      console.error('Failed to load session:', error);
    }
  };

  const handleSessionDelete = async (sessionId: string) => {
    try {
      await chatHistoryStore.deleteSession(sessionId);
      await loadChatSessions();
      if (sessionId === currentSessionId) {
        setMessages([]);
        setCurrentSessionId(null);
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const handleSessionBookmark = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);

      if (fullSession && fullSession.messages.length > 0) {
        // Get the session title
        const sessionTitle = fullSession.title;
        // Get the first 8 words of the title
        const title = sessionTitle.split(' ').slice(0, 8).join(' ');

        // Get the first message content (the task)
        const taskContent = fullSession.messages[0]?.content || '';

        // Add to favorites storage
        await favoritesStorage.addPrompt(title, taskContent);

        // Update favorites in the UI
        const prompts = await favoritesStorage.getAllPrompts();
        setFavoritePrompts(prompts);

        // Return to chat view after pinning
        handleBackToChat(true);
      }
    } catch (error) {
      console.error('Failed to pin session to favorites:', error);
    }
  };

  const handleBookmarkSelect = (content: string) => {
    if (inputContentControllerRef.current) {
      inputContentControllerRef.current.setText(content);
    }
  };

  const handleBookmarkUpdateTitle = async (id: number, title: string) => {
    try {
      await favoritesStorage.updatePromptTitle(id, title);

      // Update favorites in the UI
      const prompts = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(prompts);
    } catch (error) {
      console.error('Failed to update favorite prompt title:', error);
    }
  };

  const handleBookmarkCreate = async (title: string, content: string) => {
    try {
      await favoritesStorage.addPrompt(title, content);
      const prompts = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(prompts);
    } catch (error) {
      console.error('Failed to create favorite prompt:', error);
    }
  };

  const handleBookmarkUpdate = async (id: number, title: string, content: string) => {
    try {
      await favoritesStorage.updatePrompt(id, title, content);
      const prompts = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(prompts);
    } catch (error) {
      console.error('Failed to update favorite prompt:', error);
    }
  };

  const handleBookmarkDelete = async (id: number) => {
    try {
      await favoritesStorage.removePrompt(id);

      // Update favorites in the UI
      const prompts = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(prompts);
    } catch (error) {
      console.error('Failed to delete favorite prompt:', error);
    }
  };

  const handleBookmarkReorder = async (draggedId: number, targetId: number) => {
    try {
      // Directly pass IDs to storage function - it now handles the reordering logic
      await favoritesStorage.reorderPrompts(draggedId, targetId);

      // Fetch the updated list from storage to get the new IDs and reflect the authoritative order
      const updatedPromptsFromStorage = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(updatedPromptsFromStorage);
    } catch (error) {
      console.error('Failed to reorder favorite prompts:', error);
    }
  };

  // Load favorite prompts from storage
  useEffect(() => {
    const loadFavorites = async () => {
      try {
        const prompts = await favoritesStorage.getAllPrompts();
        setFavoritePrompts(prompts);
      } catch (error) {
        console.error('Failed to load favorite prompts:', error);
      }
    };

    loadFavorites();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Stop recording if active
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      // Clear recording timer
      if (recordingTimerRef.current) {
        clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      stopConnection();
    };
  }, [stopConnection]);

  // Scroll to bottom when new messages arrive
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleMicClick = async () => {
    if (isRecording) {
      // Stop recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      // Clear the timer
      if (recordingTimerRef.current) {
        clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      setIsRecording(false);
      return;
    }

    const openMicrophonePermissionFallback = () => {
      const permissionUrl = chrome.runtime.getURL('permission/index.html');

      chrome.windows.create(
        {
          url: permissionUrl,
          type: 'popup',
          width: 500,
          height: 560,
        },
        createdWindow => {
          if (!createdWindow?.id) {
            return;
          }

          chrome.windows.onRemoved.addListener(function onWindowClose(windowId) {
            if (windowId !== createdWindow.id) {
              return;
            }

            chrome.windows.onRemoved.removeListener(onWindowClose);
            window.setTimeout(async () => {
              try {
                const permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });
                if (permissionStatus.state === 'granted') {
                  handleMicClick();
                }
              } catch (error) {
                console.error('Failed to check microphone permission after fallback:', error);
              }
            }, 500);
          });
        },
      );
    };

    try {
      // Request microphone access directly from the side panel. The browser
      // shows its native permission prompt when permission is still undecided.
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        if (error instanceof Error && error.name === 'NotAllowedError') {
          openMicrophonePermissionFallback();
          return;
        }

        throw error;
      }

      // Clear previous audio chunks
      audioChunksRef.current = [];

      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      // Handle data available event
      mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      // Handle stop event
      mediaRecorder.onstop = async () => {
        // Stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop());

        if (audioChunksRef.current.length > 0) {
          const recordedMimeType = mediaRecorder.mimeType || audioChunksRef.current[0]?.type || 'audio/webm';
          const audioBlob = new Blob(audioChunksRef.current, { type: recordedMimeType });

          try {
            const wavAudio = await convertRecordedAudioToWavDataUrl(audioBlob);

            // Setup connection if not exists
            if (!portRef.current) {
              setupConnection();
            }

            // Send audio to backend for speech-to-text conversion
            setIsProcessingSpeech(true);
            portRef.current?.postMessage({
              type: 'speech_to_text',
              audio: wavAudio,
            });
          } catch (error) {
            console.error('Failed to prepare audio for speech-to-text:', error);
            appendMessage({
              actor: Actors.SYSTEM,
              content: t('chat_stt_processingFailed'),
              timestamp: Date.now(),
            });
            setIsRecording(false);
            setIsProcessingSpeech(false);
          }
        }
      };

      // Set up 2-minute duration limit
      const maxDuration = 2 * 60 * 1000;
      recordingTimerRef.current = window.setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
        setIsRecording(false);
        setIsProcessingSpeech(true);
        recordingTimerRef.current = null;
      }, maxDuration);

      // Start recording
      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      console.error('Error accessing microphone:', error);

      let errorMessage = t('chat_stt_microphone_accessFailed');
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          errorMessage += t('chat_stt_microphone_grantPermission');
        } else if (error.name === 'NotFoundError') {
          errorMessage += t('chat_stt_microphone_notFound');
        } else {
          errorMessage += error.message;
        }
      }

      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      setIsRecording(false);
    }
  };

  return (
    <div data-browd-theme={appearanceTheme} data-browd-mode={isDarkMode ? 'dark' : 'light'}>
      <div className="browd-shell flex h-screen flex-col overflow-hidden rounded-[var(--browd-radius-md)] border border-[var(--browd-border)] text-[var(--browd-text)]">
        <header className="header relative">
          <div className="header-logo">
            {showHistory ? (
              <button
                type="button"
                onClick={() => handleBackToChat(false)}
                className="browd-button-ghost cursor-pointer px-2 py-1 text-sm"
                aria-label={t('nav_back_a11y')}>
                {t('nav_back')}
              </button>
            ) : (
              <img src={brandLogoSrc} alt="Browd logo" className="size-7" />
            )}
          </div>
          <div className="header-icons">
            {!showHistory && (
              <>
                <button
                  type="button"
                  onClick={handleNewChat}
                  onKeyDown={e => e.key === 'Enter' && handleNewChat()}
                  className="browd-icon-button cursor-pointer p-1.5"
                  aria-label={t('nav_newChat_a11y')}
                  tabIndex={0}>
                  <PiPlusBold size={20} />
                </button>
                <button
                  type="button"
                  onClick={handleLoadHistory}
                  onKeyDown={e => e.key === 'Enter' && handleLoadHistory()}
                  className="browd-icon-button cursor-pointer p-1.5"
                  aria-label={t('nav_loadHistory_a11y')}
                  tabIndex={0}>
                  <GrHistory size={20} />
                </button>
              </>
            )}
            <a
              href="https://github.com/wyddy7/browd"
              target="_blank"
              rel="noopener noreferrer"
              className="browd-icon-button p-1.5">
              <FiGithub size={20} />
            </a>
            <button
              type="button"
              onClick={() => chrome.runtime.openOptionsPage()}
              onKeyDown={e => e.key === 'Enter' && chrome.runtime.openOptionsPage()}
              className="browd-icon-button cursor-pointer p-1.5"
              aria-label={t('nav_settings_a11y')}
              tabIndex={0}>
              <FiSettings size={20} />
            </button>
          </div>
        </header>
        {showHistory ? (
          <div className="flex-1 overflow-hidden">
            <ChatHistoryList
              sessions={chatSessions}
              onSessionSelect={handleSessionSelect}
              onSessionDelete={handleSessionDelete}
              onSessionBookmark={handleSessionBookmark}
              visible={true}
              isDarkMode={isDarkMode}
            />
          </div>
        ) : (
          <>
            {/* Show loading state while checking model configuration */}
            {hasConfiguredModels === null && (
              <div className="flex flex-1 items-center justify-center p-8 text-[var(--browd-muted)]">
                <div className="text-center">
                  <div className="mx-auto mb-4 size-8 animate-spin rounded-full border-2 border-[var(--browd-accent)] border-t-transparent"></div>
                  <p>{t('status_checkingConfig')}</p>
                </div>
              </div>
            )}

            {/* Show setup message when no models are configured */}
            {hasConfiguredModels === false && (
              <div className="flex flex-1 items-center justify-center p-8 text-[var(--browd-muted)]">
                <div className="browd-card max-w-md p-6 text-center">
                  <img src={brandLogoSrc} alt="Browd logo" className="mx-auto mb-4 size-16" />
                  <h3 className="mb-2 text-lg font-semibold text-[var(--browd-text)]">{t('welcome_title')}</h3>
                  <p className="mb-4">{t('welcome_instruction')}</p>
                  <button
                    onClick={() => chrome.runtime.openOptionsPage()}
                    className="browd-button-primary my-4 px-4 py-2 text-sm font-medium">
                    {t('welcome_openSettings')}
                  </button>
                  <div className="mt-4 text-sm opacity-75">
                    <a
                      href="https://github.com/wyddy7/browd#local-setup"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--browd-accent)] hover:text-[var(--browd-accent-hover)]">
                      {t('welcome_quickStart')}
                    </a>
                    <span className="mx-2">•</span>
                    <a
                      href="https://github.com/wyddy7/browd"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--browd-accent)] hover:text-[var(--browd-accent-hover)]">
                      {t('welcome_joinCommunity')}
                    </a>
                  </div>
                </div>
              </div>
            )}

            {/* Show normal chat interface when models are configured */}
            {hasConfiguredModels === true && (
              <>
                {messages.length === 0 && (
                  <>
                    <div className="mb-2 border-t border-[var(--browd-border)] p-2">
                      <ChatInput
                        onSendMessage={handleSendMessage}
                        onStopTask={handleStopTask}
                        onMicClick={handleMicClick}
                        availableModels={availableModels}
                        availableSpeechToTextModels={availableSpeechToTextModels}
                        selectedModels={selectedAgentModels}
                        selectedSpeechToTextModel={selectedSpeechToTextModel}
                        activeAgent={activeQuickAgent}
                        onActiveAgentChange={setActiveQuickAgent}
                        onModelChange={handleAgentModelChange}
                        onSpeechToTextModelChange={handleSpeechToTextModelChange}
                        agentTabFocusMode={agentTabFocusMode}
                        onAgentTabFocusToggle={handleAgentTabFocusToggle}
                        preferredModelMenuDirection="down"
                        isRecording={isRecording}
                        isProcessingSpeech={isProcessingSpeech}
                        disabled={!inputEnabled || isHistoricalSession}
                        showStopButton={showStopButton}
                        setContent={controller => {
                          inputContentControllerRef.current = controller;
                        }}
                        isDarkMode={isDarkMode}
                        historicalSessionId={isHistoricalSession && replayEnabled ? currentSessionId : null}
                        onReplay={handleReplay}
                        tokenUsage={tokenUsage}
                      />
                    </div>
                    <div className="flex-1 overflow-y-auto bg-[var(--browd-bg)]/35">
                      <BookmarkList
                        bookmarks={favoritePrompts}
                        onBookmarkSelect={handleBookmarkSelect}
                        onBookmarkCreate={handleBookmarkCreate}
                        onBookmarkUpdate={handleBookmarkUpdate}
                        onBookmarkUpdateTitle={handleBookmarkUpdateTitle}
                        onBookmarkDelete={handleBookmarkDelete}
                        onBookmarkReorder={handleBookmarkReorder}
                        isDarkMode={isDarkMode}
                      />
                    </div>
                  </>
                )}
                {currentPlan && currentPlan.length > 0 && (
                  <div className="browd-plan-pinned border-b border-[var(--browd-border)] bg-[var(--browd-surface)]/85 px-3 py-2 backdrop-blur">
                    <PlanPinned items={currentPlan} />
                  </div>
                )}
                {messages.length > 0 && (
                  <div className="scrollbar-gutter-stable relative flex-1 overflow-x-hidden overflow-y-scroll bg-[var(--browd-bg)]/60 p-3 scroll-smooth">
                    <MessageList
                      messages={messages}
                      isDarkMode={isDarkMode}
                      onThumbClick={setLightboxUrl}
                      liveRunStartIdx={liveRunStartIdx}
                      collapseSignal={collapseSignal}
                    />
                    <div ref={messagesEndRef} />
                    {screenshotFlashKey > 0 && (
                      <div
                        key={screenshotFlashKey}
                        className="browd-screenshot-flash"
                        aria-hidden="true"
                        onAnimationEnd={undefined}
                      />
                    )}
                  </div>
                )}
                {messages.length > 0 && (
                  <div className="border-t border-[var(--browd-border)] bg-[var(--browd-surface)]/80 p-2 backdrop-blur">
                    {/* T2v — live status strip. 24px tall, single-line,
                        empty between calls. Empty for >5s = stuck. */}
                    <div className="browd-live-strip mb-1 flex h-6 items-center px-1 text-xs text-[var(--browd-muted)]">
                      {liveStatus ? (
                        <span className="truncate" title={liveStatus}>
                          {liveStatus}
                        </span>
                      ) : (
                        <span className="opacity-30">·</span>
                      )}
                    </div>
                    <TracePanel
                      entries={traceEntries}
                      onThumbClick={setLightboxUrl}
                      onExport={() => {
                        // T2f-final-fix-7: strip the image payloads
                        // before copying so the JSON the user pastes
                        // into a debug ticket is small (a 30-step
                        // session would otherwise be ~3 MB of base64).
                        const dump = JSON.stringify(
                          traceEntries.map(e => {
                            if (e && typeof e === 'object' && 'tool' in e) {
                              const {
                                imageThumbBase64: _t,
                                imageFullBase64: _f,
                                imageThumbMime: _tm,
                                imageFullMime: _fm,
                                ...rest
                              } = e as unknown as Record<string, unknown>;
                              return rest;
                            }
                            return e;
                          }),
                          null,
                          2,
                        );
                        navigator.clipboard.writeText(dump).catch(() => {
                          /* clipboard may be unavailable; silently ignore */
                        });
                      }}
                    />
                    {hitlRequest && <HITLPrompt request={hitlRequest} onDecision={submitHITLDecision} />}
                    <ChatInput
                      onSendMessage={handleSendMessage}
                      onStopTask={handleStopTask}
                      onMicClick={handleMicClick}
                      availableModels={availableModels}
                      availableSpeechToTextModels={availableSpeechToTextModels}
                      selectedModels={selectedAgentModels}
                      selectedSpeechToTextModel={selectedSpeechToTextModel}
                      activeAgent={activeQuickAgent}
                      onActiveAgentChange={setActiveQuickAgent}
                      onModelChange={handleAgentModelChange}
                      onSpeechToTextModelChange={handleSpeechToTextModelChange}
                      agentTabFocusMode={agentTabFocusMode}
                      onAgentTabFocusToggle={handleAgentTabFocusToggle}
                      preferredModelMenuDirection="up"
                      isRecording={isRecording}
                      isProcessingSpeech={isProcessingSpeech}
                      disabled={!inputEnabled || isHistoricalSession}
                      showStopButton={showStopButton}
                      setContent={controller => {
                        inputContentControllerRef.current = controller;
                      }}
                      isDarkMode={isDarkMode}
                      historicalSessionId={isHistoricalSession && replayEnabled ? currentSessionId : null}
                      onReplay={handleReplay}
                      tokenUsage={tokenUsage}
                    />
                  </div>
                )}
              </>
            )}
          </>
        )}
        {lightboxUrl ? (
          <div
            className="browd-screenshot-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="screenshot preview"
            onClick={() => setLightboxUrl(null)}>
            <img src={lightboxUrl} alt="agent screenshot full" className="browd-screenshot-lightbox-img" />
            <button
              type="button"
              className="browd-screenshot-lightbox-close"
              onClick={e => {
                e.stopPropagation();
                setLightboxUrl(null);
              }}
              aria-label="close preview">
              ×
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default SidePanel;
