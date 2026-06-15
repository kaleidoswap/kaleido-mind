import { describe, it, expect, vi } from 'vitest';
import {
  shouldHandleUtterance,
  runVoiceAssistant,
  type VoiceTranscriptEvent,
} from './assistant.js';

const immediateSleep = async () => {};

function sessionOf(events: VoiceTranscriptEvent[]): AsyncIterable<VoiceTranscriptEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

describe('shouldHandleUtterance', () => {
  it('drops utterances shorter than minChars', () => {
    expect(shouldHandleUtterance('hi')).toBe(false);
    expect(shouldHandleUtterance('go!', { minChars: 5 })).toBe(false);
  });

  it('drops known Whisper hallucinations regardless of trailing punctuation/case', () => {
    expect(shouldHandleUtterance('you')).toBe(false);
    expect(shouldHandleUtterance('Thanks.')).toBe(false);
    expect(shouldHandleUtterance('Thank you')).toBe(false);
    expect(shouldHandleUtterance('.')).toBe(false);
  });

  it('keeps a real request', () => {
    expect(shouldHandleUtterance('what is my balance')).toBe(true);
  });

  it('honours a custom ignore list', () => {
    expect(shouldHandleUtterance('computer', { ignoredUtterances: ['computer'] })).toBe(false);
  });
});

describe('runVoiceAssistant', () => {
  it('handles only real utterances and ignores vad/short/hallucination events', async () => {
    const respond = vi.fn(async (t: string) => `reply to ${t}`);
    const speak = vi.fn(async () => {});
    const session = sessionOf([
      { type: 'vad', text: undefined },
      { type: 'text', text: 'you' },                 // hallucination → skipped
      { type: 'text', text: 'what is my balance' },  // handled
      { type: 'endOfTurn' },
    ]);

    await runVoiceAssistant(session, { respond, speak }, { sleep: immediateSleep });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith('what is my balance');
    expect(speak).toHaveBeenCalledWith('reply to what is my balance');
  });

  it('gates the mic around playback and ends un-gated', async () => {
    const gates: boolean[] = [];
    const session = sessionOf([{ type: 'text', text: 'tell me a joke' }]);
    await runVoiceAssistant(
      session,
      {
        respond: async () => 'here is a joke',
        speak: async () => {},
        setMicGated: (g) => gates.push(g),
      },
      { sleep: immediateSleep },
    );
    // gated true before speaking, false after cooldown, false again on loop exit.
    expect(gates).toEqual([true, false, false]);
  });

  it('emits listening → thinking → speaking → listening states', async () => {
    const states: string[] = [];
    const session = sessionOf([{ type: 'text', text: 'what time is it' }]);
    await runVoiceAssistant(
      session,
      { respond: async () => 'noon', speak: async () => {}, onState: (s) => states.push(s) },
      { sleep: immediateSleep },
    );
    expect(states).toEqual(['listening', 'thinking', 'speaking', 'listening']);
  });

  it('does not speak an empty reply', async () => {
    const speak = vi.fn(async () => {});
    const session = sessionOf([{ type: 'text', text: 'a vague mumble here' }]);
    await runVoiceAssistant(
      session,
      { respond: async () => '   ', speak },
      { sleep: immediateSleep },
    );
    expect(speak).not.toHaveBeenCalled();
  });

  it('survives a respond() error and keeps listening', async () => {
    const speak = vi.fn(async () => {});
    const session = sessionOf([
      { type: 'text', text: 'first thing fails' },
      { type: 'text', text: 'second thing works' },
    ]);
    const respond = vi
      .fn<[string], Promise<string>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('ok');
    await runVoiceAssistant(session, { respond, speak }, { sleep: immediateSleep });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith('ok');
  });

  it('stops early when the signal is aborted', async () => {
    const controller = new AbortController();
    const respond = vi.fn(async (t: string) => {
      controller.abort();
      return `reply ${t}`;
    });
    const speak = vi.fn(async () => {});
    const session = sessionOf([
      { type: 'text', text: 'first utterance here' },
      { type: 'text', text: 'second utterance here' },
    ]);
    await runVoiceAssistant(
      session,
      { respond, speak },
      { sleep: immediateSleep, signal: controller.signal },
    );
    // Aborted during the first respond ⇒ never speaks, never handles the second.
    expect(respond).toHaveBeenCalledTimes(1);
    expect(speak).not.toHaveBeenCalled();
  });
});
