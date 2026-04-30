import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage } from '@langchain/core/messages';
import { createLogger } from '../log';
import {
  GROK_SPEECH_TO_TEXT_MODEL,
  type ProviderConfig,
  ProviderTypeEnum,
  speechToTextModelStore,
} from '@extension/storage';
import { t } from '@extension/i18n';
import {
  buildOpenRouterTranscriptionPayload,
  buildXaiSpeechToTextFormData,
  extractOpenRouterTranscript,
  isGrokSpeechToTextModel,
  parseAudioDataUrl,
} from './speechToTextUtils';

const logger = createLogger('SpeechToText');

interface SpeechToTextAdapter {
  transcribe(audioDataUrl: string): Promise<string>;
}

class GeminiSpeechToTextAdapter implements SpeechToTextAdapter {
  private llm: ChatGoogleGenerativeAI;

  constructor(llm: ChatGoogleGenerativeAI) {
    this.llm = llm;
  }

  async transcribe(audioDataUrl: string): Promise<string> {
    const audio = parseAudioDataUrl(audioDataUrl);
    logger.info('Starting Gemini audio transcription...', audio.mimeType, audio.byteLength);

    const transcriptionMessage = new HumanMessage({
      content: [
        {
          type: 'text',
          text: 'Transcribe this audio. Return only the transcribed text without any additional formatting or explanations.',
        },
        {
          type: 'media',
          data: audio.base64Data,
          mimeType: audio.mimeType,
        },
      ],
    });

    const transcriptionResponse = await this.llm.invoke([transcriptionMessage]);
    const transcribedText = transcriptionResponse.content.toString().trim();

    if (!transcribedText) {
      throw new Error('Gemini returned an empty transcript');
    }

    return transcribedText;
  }
}

class OpenRouterSpeechToTextAdapter implements SpeechToTextAdapter {
  private provider: ProviderConfig;
  private modelName: string;

  constructor(provider: ProviderConfig, modelName: string) {
    this.provider = provider;
    this.modelName = modelName;
  }

  async transcribe(audioDataUrl: string): Promise<string> {
    const audio = parseAudioDataUrl(audioDataUrl);
    logger.info('Starting OpenRouter audio transcription...', this.modelName, audio.mimeType, audio.byteLength);

    const response = await fetch(`${this.provider.baseUrl || 'https://openrouter.ai/api/v1'}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.provider.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/wyddy7/browd',
        'X-Title': 'Browd',
      },
      body: JSON.stringify(buildOpenRouterTranscriptionPayload(this.modelName, audio)),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('OpenRouter transcription failed', response.status);
      throw new Error(`OpenRouter STT request failed (${response.status}): ${errorText.slice(0, 300)}`);
    }

    const responseJson = (await response.json()) as Record<string, any>;
    return extractOpenRouterTranscript(responseJson);
  }
}

class GrokSpeechToTextAdapter implements SpeechToTextAdapter {
  private provider: ProviderConfig;

  constructor(provider: ProviderConfig) {
    this.provider = provider;
  }

  async transcribe(audioDataUrl: string): Promise<string> {
    const audio = parseAudioDataUrl(audioDataUrl);
    logger.info('Starting Grok audio transcription...', GROK_SPEECH_TO_TEXT_MODEL, audio.mimeType, audio.byteLength);

    const response = await fetch(`${this.provider.baseUrl || 'https://api.x.ai'}/v1/stt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.provider.apiKey}`,
      },
      body: buildXaiSpeechToTextFormData(audio),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Grok transcription failed', response.status);
      throw new Error(`Grok STT request failed (${response.status}): ${errorText.slice(0, 300)}`);
    }

    const responseJson = (await response.json()) as { text?: string };
    const transcript = responseJson.text?.trim();

    if (!transcript) {
      throw new Error('Grok STT returned an empty transcript');
    }

    return transcript;
  }
}

export class SpeechToTextService {
  private adapter: SpeechToTextAdapter;

  private constructor(adapter: SpeechToTextAdapter) {
    this.adapter = adapter;
  }

  static async create(providers: Record<string, ProviderConfig>): Promise<SpeechToTextService> {
    try {
      const config = await speechToTextModelStore.getSpeechToTextModel();

      if (!config?.provider || !config?.modelName) {
        throw new Error(t('chat_stt_model_notFound'));
      }

      const provider = providers[config.provider];
      logger.info('Found provider for speech-to-text:', provider ? 'yes' : 'no', provider?.type);

      if (!provider?.type) {
        throw new Error(t('chat_stt_model_notFound'));
      }

      let adapter: SpeechToTextAdapter;

      switch (provider.type) {
        case ProviderTypeEnum.Gemini: {
          const llm = new ChatGoogleGenerativeAI({
            model: config.modelName,
            apiKey: provider.apiKey,
            temperature: 0.1,
            topP: 0.8,
          });
          adapter = new GeminiSpeechToTextAdapter(llm);
          break;
        }
        case ProviderTypeEnum.OpenRouter: {
          adapter = new OpenRouterSpeechToTextAdapter(provider, config.modelName);
          break;
        }
        case ProviderTypeEnum.Grok: {
          if (!isGrokSpeechToTextModel(config.modelName)) {
            throw new Error(t('chat_stt_model_notFound'));
          }
          adapter = new GrokSpeechToTextAdapter(provider);
          break;
        }
        default:
          throw new Error(t('chat_stt_model_notFound'));
      }

      logger.info(`Speech-to-text service created with provider/model: ${provider.type} ${config.modelName}`);
      return new SpeechToTextService(adapter);
    } catch (error) {
      logger.error('Failed to create speech-to-text service:', error);
      throw error;
    }
  }

  async transcribeAudio(audioDataUrl: string): Promise<string> {
    try {
      const transcribedText = await this.adapter.transcribe(audioDataUrl);
      logger.info('Audio transcription completed');
      return transcribedText;
    } catch (error) {
      logger.error('Failed to transcribe audio:', error);
      throw new Error(`Speech transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
