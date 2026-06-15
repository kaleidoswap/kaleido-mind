/**
 * Voice runtime ops shared across hosts: one-shot transcription (Whisper) and
 * speech synthesis (SUPERTONIC TTS). Like the provider, the SDK functions are
 * injected (type-only `@qvac/sdk` import, erased at build) so this carries no
 * runtime SDK dependency and is unit-testable with fakes.
 *
 * The host still owns model lifecycle (download, load, local-vs-delegated) and
 * audio I/O (mic capture, playback). It passes the loaded model-id resolvers;
 * this module does the SDK calls + the text gating that must be identical
 * everywhere (payment-string redaction, U+0060 refusal, file:// stripping).
 *
 * The streaming voice-assistant loop (transcribeStream + VAD) builds on top of
 * these in a later pass.
 */
import type * as QvacSdk from '@qvac/sdk';
import { sanitizeForSupertonic } from './text.js';
import { TTS_SAMPLE_RATE, DEFAULT_VOICE_STREAM_PARAMS } from './config.js';
import type { VoiceTranscriptEvent } from './assistant.js';

type TranscribeFn = typeof QvacSdk.transcribe;
type TextToSpeechFn = typeof QvacSdk.textToSpeech;
type TranscribeStreamFn = typeof QvacSdk.transcribeStream;

/** 16-bit PCM samples plus their sample rate, ready for the host to play. */
export interface PcmAudio {
  pcm: number[];
  sampleRate: number;
}

/**
 * A live VAD transcription session: feed mic audio with `write()`, iterate to
 * receive `text`/`vad`/`endOfTurn` events, `end()` when audio stops. Pass it
 * straight to `runVoiceAssistant`.
 */
export interface VoiceSession {
  write(audioChunk: Uint8Array): void;
  end(): void;
  destroy(): void;
  [Symbol.asyncIterator](): AsyncIterator<VoiceTranscriptEvent>;
}

export interface QvacVoiceOptions {
  /** The SDK's `transcribe` (injected). */
  transcribe: TranscribeFn;
  /** The SDK's `textToSpeech` (injected). */
  textToSpeech: TextToSpeechFn;
  /** The SDK's `transcribeStream` (injected) — only needed for `openVoiceSession`. */
  transcribeStream?: TranscribeStreamFn;
  /** Resolve the loaded Whisper model id (null ⇒ not loaded → throws). */
  getWhisperModelId: () => string | null;
  /** Resolve the loaded TTS model id (null ⇒ not loaded → returns null). */
  getTtsModelId: () => string | null;
  /** TTS output sample rate; defaults to SUPERTONIC-2's 44.1 kHz. */
  ttsSampleRate?: number;
}

export interface QvacVoice {
  /** Transcribe an audio file (path or `file://` URI) to text. */
  transcribeAudio(audioUri: string): Promise<string>;
  /**
   * Synthesize speech for `text`. Returns PCM + sample rate, or `null` when TTS
   * is unavailable or the text is empty after sanitization (host falls back to
   * the system voice). Payment strings are redacted so they're never read aloud.
   */
  synthesizeSpeech(text: string): Promise<PcmAudio | null>;
  /**
   * Open a hands-free VAD transcription session (continuous voice). Requires
   * `transcribeStream` to have been provided. Merge in `paramsOverride` to tune
   * the defaults ({@link DEFAULT_VOICE_STREAM_PARAMS}). Feed the returned session
   * to `runVoiceAssistant`.
   */
  openVoiceSession(paramsOverride?: Record<string, unknown>): Promise<VoiceSession>;
}

export function createQvacVoice(options: QvacVoiceOptions): QvacVoice {
  const sampleRate = options.ttsSampleRate ?? TTS_SAMPLE_RATE;

  return {
    async transcribeAudio(audioUri: string): Promise<string> {
      const modelId = options.getWhisperModelId();
      if (!modelId) throw new Error('Whisper model not loaded');
      // The SDK's native file reader wants a plain filesystem path, not a
      // `file://` URI — the URI raises AUDIO_FILE_NOT_FOUND even when present.
      const audioChunk = audioUri.replace('file://', '');
      return await options.transcribe({ modelId, audioChunk } as Parameters<TranscribeFn>[0]);
    },

    async synthesizeSpeech(text: string): Promise<PcmAudio | null> {
      const modelId = options.getTtsModelId();
      if (!modelId) return null;

      const trimmed = sanitizeForSupertonic(text);
      if (!trimmed) return null;
      // Belt-and-suspenders: SUPERTONIC chokes on U+0060; sanitize already
      // strips it, so refuse if any slipped through rather than crash the voice.
      if (Array.from(trimmed).some((ch) => ch.charCodeAt(0) === 0x60)) return null;

      const result = options.textToSpeech({
        modelId,
        text: trimmed,
        inputType: 'text',
        stream: false,
      } as Parameters<TextToSpeechFn>[0]);
      const pcm = await result.buffer;
      return { pcm, sampleRate };
    },

    async openVoiceSession(paramsOverride: Record<string, unknown> = {}): Promise<VoiceSession> {
      if (!options.transcribeStream) {
        throw new Error('transcribeStream not provided — pass it in QvacVoiceOptions for voice sessions');
      }
      const modelId = options.getWhisperModelId();
      if (!modelId) throw new Error('Whisper model not loaded');
      const session = await options.transcribeStream({
        modelId,
        ...DEFAULT_VOICE_STREAM_PARAMS,
        ...paramsOverride,
      } as Parameters<TranscribeStreamFn>[0]);
      return session as unknown as VoiceSession;
    },
  };
}
