import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage } from '@langchain/core/messages';
import { createLogger } from '../log';
import {
  GROK_SPEECH_TO_TEXT_MODEL,
  type ProviderConfig,
  ProviderTypeEnum,
  speechToTextModelStore,
} from '@extension/storage';
import {
  buildOpenRouterResponsesAudioPayload,
  buildOpenRouterResponsesFilePayload,
  buildOpenRouterTranscriptionPayload,
  buildXaiSpeechToTextFormData,
  extractOpenRouterResponsesTranscript,
  extractOpenRouterTranscript,
  isGrokSpeechToTextModel,
  parseAudioDataUrl,
  shouldRetryOpenRouterResponsesWithAlternateContent,
  shouldRetryOpenRouterWithResponses,
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

    const chatResponse = await fetch(`${this.provider.baseUrl || 'https://openrouter.ai/api/v1'}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.provider.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/wyddy7/browd',
        'X-Title': 'Browd',
      },
      body: JSON.stringify(buildOpenRouterTranscriptionPayload(this.modelName, audio)),
    });

    if (chatResponse.ok) {
      const responseJson = (await chatResponse.json()) as Record<string, any>;
      return extractOpenRouterTranscript(responseJson);
    }

    const chatErrorText = await chatResponse.text();

    if (!shouldRetryOpenRouterWithResponses(chatResponse.status, chatErrorText)) {
      logger.error('OpenRouter chat transcription failed', chatResponse.status);
      throw new Error(`OpenRouter STT request failed (${chatResponse.status}): ${chatErrorText.slice(0, 1200)}`);
    }

    logger.warning(
      'OpenRouter chat route rejected input_audio, retrying with responses-compatible content',
      this.modelName,
    );

    const responsesAudioResponse = await this.sendOpenRouterResponsesRequest(
      buildOpenRouterResponsesAudioPayload(this.modelName, audio),
    );

    if (responsesAudioResponse.ok) {
      const responseJson = (await responsesAudioResponse.json()) as Record<string, any>;
      return extractOpenRouterResponsesTranscript(responseJson);
    }

    const responsesAudioErrorText = await responsesAudioResponse.text();

    if (!shouldRetryOpenRouterResponsesWithAlternateContent(responsesAudioResponse.status, responsesAudioErrorText)) {
      logger.error('OpenRouter responses audio transcription failed', responsesAudioResponse.status);
      throw new Error(
        `OpenRouter STT request failed (${responsesAudioResponse.status}): ${responsesAudioErrorText.slice(0, 1200)}`,
      );
    }

    logger.warning(
      'OpenRouter responses route rejected input_audio content, retrying with input_file data URL',
      this.modelName,
    );

    const responsesFileResponse = await this.sendOpenRouterResponsesRequest(
      buildOpenRouterResponsesFilePayload(this.modelName, audio),
    );

    if (!responsesFileResponse.ok) {
      const responsesFileErrorText = await responsesFileResponse.text();
      logger.error('OpenRouter responses file transcription failed', responsesFileResponse.status);
      throw new Error(
        `OpenRouter STT request failed (${responsesFileResponse.status}): ${responsesFileErrorText.slice(0, 1200)}`,
      );
    }

    const responseJson = (await responsesFileResponse.json()) as Record<string, any>;
    return extractOpenRouterResponsesTranscript(responseJson);
  }

  private sendOpenRouterResponsesRequest(body: Record<string, unknown>) {
    return fetch(`${this.provider.baseUrl || 'https://openrouter.ai/api/v1'}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.provider.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/wyddy7/browd',
        'X-Title': 'Browd',
      },
      body: JSON.stringify(body),
    });
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
        throw new Error(
          'Speech-to-text is not configured yet. Pick a model in Settings -> Models -> Speech-to-Text Model.',
        );
      }

      const provider = providers[config.provider];
      logger.info('Found provider for speech-to-text:', provider ? 'yes' : 'no', provider?.type);

      if (!provider?.type) {
        throw new Error(
          `Speech-to-text provider "${config.provider}" was not found in saved providers. Re-save that provider in Settings -> Models.`,
        );
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
            throw new Error(
              `Saved STT model "${config.modelName}" is not a valid Grok STT option. Re-select "Grok Speech-to-Text API" in settings.`,
            );
          }
          adapter = new GrokSpeechToTextAdapter(provider);
          break;
        }
        default:
          throw new Error(
            `Provider "${config.provider}" of type "${provider.type}" is not supported for speech-to-text in Browd.`,
          );
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
