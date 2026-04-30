import { GROK_SPEECH_TO_TEXT_MODEL } from '@extension/storage';

export interface ParsedAudioData {
  mimeType: string;
  base64Data: string;
  dataUrl: string;
  format: string;
  byteLength: number;
  fileName: string;
  blob: Blob;
}

type OpenRouterMessageContent =
  | string
  | Array<
      | string
      | {
          type?: string;
          text?: string;
        }
    >;

const MIME_TYPE_TO_EXTENSION: Record<string, string> = {
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

export function parseAudioDataUrl(audioDataUrl: string): ParsedAudioData {
  const match = audioDataUrl.match(/^data:([^;]+);base64,(.+)$/);

  if (!match) {
    throw new Error('Invalid audio payload: expected a data URL');
  }

  const [, mimeType, base64Data] = match;
  const bytes = decodeBase64(base64Data);
  const blob = new Blob([bytes], { type: mimeType });
  const extension = MIME_TYPE_TO_EXTENSION[mimeType] || 'bin';
  const subtype = mimeType.split('/')[1] || extension;
  const format = subtype.includes('mpeg') ? 'mp3' : subtype;

  return {
    mimeType,
    base64Data,
    dataUrl: audioDataUrl,
    format,
    byteLength: bytes.byteLength,
    fileName: `speech-input.${extension}`,
    blob,
  };
}

export function buildOpenRouterTranscriptionPayload(modelName: string, audio: ParsedAudioData) {
  return {
    model: modelName,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Please transcribe this audio file. Return only the transcribed text without any additional formatting or explanations.',
          },
          {
            type: 'input_audio',
            input_audio: {
              data: audio.base64Data,
              format: audio.format,
            },
          },
        ],
      },
    ],
    stream: false,
  };
}

export function buildXaiSpeechToTextFormData(audio: ParsedAudioData): FormData {
  const formData = new FormData();
  formData.append('format', 'true');
  formData.append('language', 'en');
  formData.append('file', audio.blob, audio.fileName);
  return formData;
}

export function extractOpenRouterTranscript(responseJson: Record<string, any>): string {
  const content = responseJson?.choices?.[0]?.message?.content as OpenRouterMessageContent | undefined;

  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map(part => {
        if (typeof part === 'string') {
          return part;
        }

        if (part?.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }

        return '';
      })
      .join(' ')
      .trim();

    if (text) {
      return text;
    }
  }

  throw new Error('OpenRouter did not return a transcript');
}

export function isGrokSpeechToTextModel(modelName: string): boolean {
  return modelName === GROK_SPEECH_TO_TEXT_MODEL;
}
