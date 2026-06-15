/**
 * @kaleidorg/mind-qvac — the single home for all @qvac/sdk logic behind
 * @kaleidorg/mind. Hosts (rate mobile, desktop provider, cli) supply @qvac/sdk
 * as a peer dependency; this package owns the orchestration so the logic lives
 * in one place instead of drifting copies per host.
 *
 * This first slice exports the platform-agnostic core (pure text helpers, model
 * configs, completion parsing). The QVAC-calling provider/voice/host wrappers
 * land next, on top of these.
 */
export {
  cleanAssistantVisibleText,
  sanitizeForSupertonic,
} from './text.js';

export {
  LOCAL_LLM_CONFIG,
  LOCAL_LLM_CONFIG_GPU,
  DELEGATE_LLM_CONFIG,
  TTS_SAMPLE_RATE,
  DEFAULT_VOICE_STREAM_PARAMS,
  WHISPER_LANGS,
  normalizeWhisperLang,
} from './config.js';

export {
  finalToTurn,
  type QvacFinalLike,
  type ParsedTurn,
} from './parse.js';

export {
  consumeRun,
  type CompletionEventLike,
  type CompletionRunLike,
  type StreamHandlers,
  type ConsumedTurn,
} from './stream.js';

export {
  createQvacProvider,
  type QvacProviderOptions,
  type QvacTurnInput,
} from './provider.js';

export {
  createQvacVoice,
  type QvacVoice,
  type QvacVoiceOptions,
  type VoiceSession,
  type PcmAudio,
} from './voice.js';

export {
  runVoiceAssistant,
  shouldHandleUtterance,
  DEFAULT_IGNORED_UTTERANCES,
  type VoiceAssistantSession,
  type VoiceAssistantHandlers,
  type VoiceAssistantOptions,
  type VoiceAssistantState,
  type VoiceTranscriptEvent,
} from './assistant.js';

export {
  allowListFirewall,
  denyListFirewall,
  firewallFromKeyList,
  buildDelegateConfig,
  type ProviderFirewall,
  type DelegateConfig,
} from './delegate.js';
