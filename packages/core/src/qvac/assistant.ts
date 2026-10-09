/**
 * Hands-free voice-assistant loop — the transcribe → reason → speak cycle that
 * QVAC's `transcribeStream()` makes possible, lifted into shared code so mobile
 * and desktop run the same orchestration.
 *
 * The host owns the I/O: it opens the SDK session (`transcribeStream` with
 * `DEFAULT_VOICE_STREAM_PARAMS`), feeds mic audio via `session.write()`, and
 * supplies `respond` (LLM/funnel turn → reply text) + `speak` (synth + play).
 * This loop does the parts that must be identical everywhere: filter Whisper's
 * silence hallucinations, and gate the mic during playback so the assistant
 * never transcribes its own voice (QVAC's reference uses a mic-gate, not
 * barge-in — we mirror that).
 */

/** A transcript event from a `transcribeStream` conversation session. */
export interface VoiceTranscriptEvent {
  type: string;
  /** Present on `text` events — a committed utterance. */
  text?: string;
}

/** The host's transcription session (the SDK's conversation session fits). */
export type VoiceAssistantSession = AsyncIterable<VoiceTranscriptEvent>;

export type VoiceAssistantState = 'listening' | 'thinking' | 'speaking';

/** Timing starts when a committed transcript arrives; excludes STT and cooldown. */
export interface VoiceTurnMetrics {
  status: 'completed' | 'response_error' | 'playback_error' | 'empty_reply' | 'aborted';
  reasonMs: number;
  playbackMs: number;
  totalMs: number;
}

export interface VoiceAssistantHandlers {
  /** Produce an assistant reply for a user utterance (wraps the LLM/funnel). */
  respond: (transcript: string) => Promise<string>;
  /** Speak the reply: synth + playback. Resolves when playback finishes. */
  speak: (text: string) => Promise<void>;
  /**
   * Gate mic capture so the assistant doesn't hear itself. The host should drop
   * (not buffer) audio while gated. Called `true` before speaking, `false` after
   * the post-playback cooldown.
   */
  setMicGated?: (gated: boolean) => void;
  /** A user utterance passed the filter and is about to be handled. */
  onUserText?: (text: string) => void;
  /** The assistant's reply, before it is spoken. */
  onReply?: (text: string) => void;
  /** Optional metrics only: no transcript/audio/error text. Observer failures are isolated. */
  onTurnMetrics?: (metrics: VoiceTurnMetrics) => void | Promise<void>;
  /** UI state transitions. */
  onState?: (state: VoiceAssistantState) => void;
}

export interface VoiceAssistantOptions {
  /** Minimum utterance length to handle (drops "you", ".", etc.). Default 3. */
  minChars?: number;
  /** Utterances to ignore (case-insensitive, trailing punctuation stripped). */
  ignoredUtterances?: Iterable<string>;
  /** Pause after playback so speaker reverb settles before listening. Default 300ms. */
  postPlaybackCooldownMs?: number;
  /** Injected for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds, injectable for tests. */
  now?: () => number;
  /** Stop the loop early. */
  signal?: AbortSignal;
}

/**
 * Whisper frequently hallucinates these from silence — drop them so the
 * assistant doesn't answer phantom turns. (QVAC docs cite "you", ".", "Thanks.")
 */
export const DEFAULT_IGNORED_UTTERANCES: readonly string[] = [
  'you', 'thank you', 'thanks', 'bye', 'okay', '.',
];

/**
 * Should this utterance be handled? False for too-short text or a known Whisper
 * hallucination. Pure + exported so it's directly testable.
 */
export function shouldHandleUtterance(
  text: string,
  options: { minChars?: number; ignoredUtterances?: Iterable<string> } = {},
): boolean {
  const trimmed = text.trim();
  if (trimmed.length < (options.minChars ?? 3)) return false;
  const norm = trimmed.toLowerCase().replace(/[.!?,]+$/, '').trim();
  if (!norm) return false;
  const ignored = new Set(
    [...(options.ignoredUtterances ?? DEFAULT_IGNORED_UTTERANCES)].map((s) => s.toLowerCase()),
  );
  return !ignored.has(norm);
}

/**
 * Run the hands-free loop until the session ends or `signal` aborts. Only `text`
 * events drive a turn; `vad`/`segment`/`endOfTurn` events are ignored here (the
 * host can read them off the session separately for UI). Always leaves the mic
 * un-gated on exit.
 */
export async function runVoiceAssistant(
  session: VoiceAssistantSession,
  handlers: VoiceAssistantHandlers,
  options: VoiceAssistantOptions = {},
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cooldown = options.postPlaybackCooldownMs ?? 300;
  let speaking = false;
  const now = options.now ?? (() => performance.now());
  const report = async (metrics: VoiceTurnMetrics) => {
    try { await handlers.onTurnMetrics?.(metrics); } catch { /* telemetry must not break voice */ }
  };

  handlers.onState?.('listening');
  try {
    for await (const event of session) {
      if (options.signal?.aborted) break;
      if (event.type !== 'text' || typeof event.text !== 'string') continue;
      // Defensive: ignore anything heard mid-playback (host also gates the mic).
      if (speaking) continue;

      const transcript = event.text.trim();
      if (!shouldHandleUtterance(transcript, options)) continue;

      handlers.onUserText?.(transcript);
      handlers.onState?.('thinking');

      const started = now();
      let reply: string;
      try {
        reply = await handlers.respond(transcript);
      } catch {
        await report({ status: 'response_error', reasonMs: now() - started, playbackMs: 0, totalMs: now() - started });
        handlers.onState?.('listening');
        continue;
      }
      const reasonMs = now() - started;
      if (options.signal?.aborted) {
        await report({ status: 'aborted', reasonMs, playbackMs: 0, totalMs: now() - started });
        break;
      }
      if (!reply || !reply.trim()) {
        await report({ status: 'empty_reply', reasonMs, playbackMs: 0, totalMs: now() - started });
        handlers.onState?.('listening');
        continue;
      }

      handlers.onReply?.(reply);
      speaking = true;
      handlers.setMicGated?.(true);
      handlers.onState?.('speaking');
      const playbackStarted = now();
      let status: VoiceTurnMetrics['status'] = 'completed';
      try {
        await handlers.speak(reply);
      } catch {
        status = 'playback_error';
      } finally {
        const metrics = { status, reasonMs, playbackMs: now() - playbackStarted, totalMs: now() - started };
        await sleep(cooldown);
        speaking = false;
        handlers.setMicGated?.(false);
        handlers.onState?.('listening');
        await report(metrics);
      }
    }
  } finally {
    // Never leave the mic gated if the loop exits mid-turn.
    handlers.setMicGated?.(false);
  }
}
