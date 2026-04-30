import { describe, expect, it } from 'vitest';
import { ProviderTypeEnum } from '@extension/storage';
import {
  getSpeechToTextModelsForProvider,
  getSpeechToTextOptions,
  GROK_SPEECH_TO_TEXT_MODEL,
} from '../../../../../packages/storage/lib/settings/speechToText';
import {
  normalizeProviderApiKey,
  normalizeProviderBaseUrl,
} from '../../../../../packages/storage/lib/settings/llmProviders';
import {
  buildOpenRouterResponsesAudioPayload,
  buildOpenRouterResponsesFilePayload,
  buildOpenRouterTranscriptionPayload,
  buildXaiSpeechToTextFormData,
  extractOpenRouterResponsesTranscript,
  extractOpenRouterTranscript,
  parseAudioDataUrl,
  shouldRetryOpenRouterResponsesWithAlternateContent,
  shouldRetryOpenRouterWithResponses,
} from '../speechToTextUtils';

const webmAudioDataUrl = 'data:audio/webm;base64,AAAA';

describe('speech-to-text provider helpers', () => {
  it('returns configured Gemini and OpenRouter models plus Grok sentinel', () => {
    const options = getSpeechToTextOptions({
      gemini: {
        apiKey: 'gem-key',
        type: ProviderTypeEnum.Gemini,
        name: 'Gemini',
        modelNames: ['gemini-2.5-flash'],
      },
      openrouter: {
        apiKey: 'or-key',
        type: ProviderTypeEnum.OpenRouter,
        name: 'OpenRouter',
        modelNames: ['openai/whisper-1'],
      },
      grok: {
        apiKey: 'xai-key',
        type: ProviderTypeEnum.Grok,
        name: 'Grok',
        modelNames: ['grok-4'],
      },
    });

    expect(options).toEqual([
      { provider: 'gemini', providerName: 'Gemini', modelName: 'gemini-2.5-flash' },
      { provider: 'openrouter', providerName: 'OpenRouter', modelName: 'openai/whisper-1' },
      { provider: 'grok', providerName: 'Grok', modelName: GROK_SPEECH_TO_TEXT_MODEL },
    ]);
  });

  it('uses Grok sentinel model and ignores chat model list', () => {
    const models = getSpeechToTextModelsForProvider('grok', {
      apiKey: 'xai-key',
      type: ProviderTypeEnum.Grok,
      modelNames: ['grok-4', 'grok-3-fast'],
    });

    expect(models).toEqual([GROK_SPEECH_TO_TEXT_MODEL]);
  });
});

describe('speech-to-text payload helpers', () => {
  it('parses data URLs into mime-aware audio metadata', () => {
    const parsed = parseAudioDataUrl(webmAudioDataUrl);

    expect(parsed.mimeType).toBe('audio/webm');
    expect(parsed.format).toBe('webm');
    expect(parsed.fileName).toBe('speech-input.webm');
    expect(parsed.byteLength).toBeGreaterThan(0);
  });

  it('builds OpenRouter audio payloads with input_audio content', () => {
    const parsed = parseAudioDataUrl(webmAudioDataUrl);
    const payload = buildOpenRouterTranscriptionPayload('openai/whisper-1', parsed);
    const messageContent = payload.messages[0].content;

    expect(payload.model).toBe('openai/whisper-1');
    expect(Array.isArray(messageContent)).toBe(true);
    expect(messageContent[1]).toEqual({
      type: 'input_audio',
      input_audio: {
        data: parsed.base64Data,
        format: 'webm',
      },
    });
  });

  it('builds OpenRouter responses audio payloads with input_audio content', () => {
    const parsed = parseAudioDataUrl(webmAudioDataUrl);
    const payload = buildOpenRouterResponsesAudioPayload('openai/gpt-4o-transcribe', parsed);
    const messageContent = payload.input[0].content;

    expect(payload.model).toBe('openai/gpt-4o-transcribe');
    expect(payload.input[0].id).toBe('speech-to-text-input');
    expect(Array.isArray(messageContent)).toBe(true);
    expect(messageContent[0]).toEqual({
      type: 'input_text',
      text: 'Please transcribe this audio file. Return only the transcribed text without any additional formatting or explanations.',
    });
    expect(messageContent[1]).toEqual({
      type: 'input_audio',
      input_audio: {
        data: parsed.base64Data,
        format: parsed.format,
      },
    });
  });

  it('builds OpenRouter responses file payloads with data URL content', () => {
    const parsed = parseAudioDataUrl(webmAudioDataUrl);
    const payload = buildOpenRouterResponsesFilePayload('openai/gpt-4o-transcribe', parsed);
    const messageContent = payload.input[0].content;

    expect(payload.model).toBe('openai/gpt-4o-transcribe');
    expect(payload.input[0].id).toBe('speech-to-text-input');
    expect(Array.isArray(messageContent)).toBe(true);
    expect(messageContent[0]).toEqual({
      type: 'input_text',
      text: 'Please transcribe this audio file. Return only the transcribed text without any additional formatting or explanations.',
    });
    expect(messageContent[1]).toEqual({
      type: 'input_file',
      file_data: parsed.dataUrl,
      filename: parsed.fileName,
    });
  });

  it('builds xAI multipart form data with file last', () => {
    const parsed = parseAudioDataUrl(webmAudioDataUrl);
    const formData = buildXaiSpeechToTextFormData(parsed);

    expect(formData.get('format')).toBe('true');
    expect(formData.get('language')).toBe('en');
    expect(formData.get('file')).toBeInstanceOf(File);
  });

  it('extracts transcript text from OpenRouter chat responses', () => {
    const transcript = extractOpenRouterTranscript({
      choices: [
        {
          message: {
            content: [
              {
                type: 'text',
                text: 'hello from audio',
              },
            ],
          },
        },
      ],
    });

    expect(transcript).toBe('hello from audio');
  });

  it('extracts transcript text from OpenRouter responses output', () => {
    const transcript = extractOpenRouterResponsesTranscript({
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'hello from responses audio',
            },
          ],
        },
      ],
    });

    expect(transcript).toBe('hello from responses audio');
  });

  it('retries OpenRouter STT through responses when input_audio is rejected', () => {
    expect(
      shouldRetryOpenRouterWithResponses(
        400,
        `{"error":{"message":"Invalid value: 'input_audio'. Supported values are: 'input_text', 'input_image', 'output_text', 'refusal', 'input_file'"}}`,
      ),
    ).toBe(true);
  });

  it('retries OpenRouter responses with alternate content when content validation fails', () => {
    expect(shouldRetryOpenRouterResponsesWithAlternateContent(400, '{"error":{"message":"Invalid content"}}')).toBe(
      true,
    );
  });
});

describe('provider normalization helpers', () => {
  it('removes zero-width characters from API keys', () => {
    expect(normalizeProviderApiKey('sk-or-v1-\u200babc123')).toBe('sk-or-v1-abc123');
  });

  it('normalizes OpenRouter base URLs to the API root', () => {
    expect(normalizeProviderBaseUrl('https://openrouter.ai/api/v1/chat/completions', ProviderTypeEnum.OpenRouter)).toBe(
      'https://openrouter.ai/api/v1',
    );
  });
});
