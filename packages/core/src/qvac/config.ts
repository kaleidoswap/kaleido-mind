/**
 * QVAC model-load configs and constants, shared across every host. These are
 * plain data (no SDK import) so they stay portable and testable; callers merge
 * in SDK-specific bits like `verbosity: VERBOSITY.ERROR` at load time.
 */

/**
 * CPU baseline for the local llamacpp model. Used as the GPU fallback and as the
 * base the GPU attempt overrides (device + gpu_layers).
 */
export const LOCAL_LLM_CONFIG = {
  device: 'cpu',
  gpu_layers: 0,
  ctx_size: 2048,
  tools: true,
} as const;

/**
 * GPU (Metal on iPhone) offload — far faster than CPU when llamacpp can init the
 * Metal context in the worklet. Fall back to {@link LOCAL_LLM_CONFIG} if the GPU
 * load throws. ctx 4096 fits the agentic prompt (system + tools + skills + a
 * little history); 2048 overflowed immediately ("prompt exceeds context").
 */
export const LOCAL_LLM_CONFIG_GPU = {
  ...LOCAL_LLM_CONFIG,
  device: 'gpu',
  gpu_layers: 99, // offload all layers; llamacpp clamps to the model's count
  ctx_size: 4096,
} as const;

/**
 * Delegated to a desktop provider — it has the RAM to run a big context, so give
 * the agentic prompt plenty of room (Qwen3-600M supports up to 32k). 2048
 * overflowed with the system prompt + tool/skill definitions alone.
 */
export const DELEGATE_LLM_CONFIG = {
  ...LOCAL_LLM_CONFIG_GPU,
  ctx_size: 16384,
} as const;

/** SUPERTONIC-2 TTS output sample rate (Hz). Used to build the WAV for playback. */
export const TTS_SAMPLE_RATE = 44100;

/**
 * Default params for a hands-free `transcribeStream()` voice session (Whisper).
 * `emitVadEvents` turns the session into a conversation stream (text + vad +
 * endOfTurn events); `endOfTurnSilenceMs` is how long a pause must last before
 * an utterance is committed — conservative so it doesn't cut speakers off mid
 * sentence or trigger on TTS reverb. Hosts merge in `modelId` + spread these.
 */
export const DEFAULT_VOICE_STREAM_PARAMS = {
  emitVadEvents: true,
  endOfTurnSilenceMs: 700,
} as const;

/**
 * Whisper languages we request directly from the device locale. whisper.cpp
 * supports more, but the QVAC handler rejects "auto"/detect_language for these
 * tiny models, so we pass a concrete code (and fall back to 'en').
 */
export const WHISPER_LANGS: ReadonlySet<string> = new Set([
  'en', 'it', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'pl', 'uk', 'tr', 'ar',
  'zh', 'ja', 'ko', 'hi', 'id', 'sv', 'no', 'da', 'fi', 'cs', 'ro', 'el',
  'he', 'th', 'vi', 'hu', 'ca',
]);

/**
 * Best-effort 2-letter Whisper language code from an OS locale string
 * (e.g. "it-IT" → "it"), restricted to codes Whisper handles well. Falls back to
 * 'en'. Pure: the host reads the locale (NativeModules etc.) and passes it here.
 */
export function normalizeWhisperLang(locale: string | null | undefined): string {
  if (!locale) return 'en';
  const code = String(locale).split(/[-_]/)[0]?.toLowerCase() ?? 'en';
  return WHISPER_LANGS.has(code) ? code : 'en';
}
