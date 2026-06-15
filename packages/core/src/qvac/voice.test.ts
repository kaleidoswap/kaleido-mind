import { describe, it, expect, vi } from 'vitest';
import { createQvacVoice } from './voice.js';

describe('createQvacVoice.transcribeAudio', () => {
  it('strips the file:// prefix and passes a plain path to the SDK', async () => {
    const transcribe = vi.fn(async () => 'hello world');
    const voice = createQvacVoice({
      transcribe: transcribe as any,
      textToSpeech: (() => {}) as any,
      getWhisperModelId: () => 'whisper-1',
      getTtsModelId: () => null,
    });
    const text = await voice.transcribeAudio('file:///tmp/clip.wav');
    expect(text).toBe('hello world');
    expect(transcribe).toHaveBeenCalledWith({ modelId: 'whisper-1', audioChunk: '/tmp/clip.wav' });
  });

  it('throws when no Whisper model is loaded', async () => {
    const voice = createQvacVoice({
      transcribe: (() => { throw new Error('nope'); }) as any,
      textToSpeech: (() => {}) as any,
      getWhisperModelId: () => null,
      getTtsModelId: () => null,
    });
    await expect(voice.transcribeAudio('/tmp/clip.wav')).rejects.toThrow(/not loaded/);
  });
});

describe('createQvacVoice.synthesizeSpeech', () => {
  function ttsReturning(pcm: number[]) {
    const calls: any[] = [];
    const fn = (params: any) => {
      calls.push(params);
      return { buffer: Promise.resolve(pcm) };
    };
    return { fn, calls };
  }

  it('returns null when no TTS model is loaded', async () => {
    const voice = createQvacVoice({
      transcribe: (() => {}) as any,
      textToSpeech: (() => { throw new Error('should not run'); }) as any,
      getWhisperModelId: () => null,
      getTtsModelId: () => null,
    });
    expect(await voice.synthesizeSpeech('hi')).toBeNull();
  });

  it('returns null when the text is empty after sanitization', async () => {
    const tts = ttsReturning([1, 2, 3]);
    const voice = createQvacVoice({
      transcribe: (() => {}) as any,
      textToSpeech: tts.fn as any,
      getWhisperModelId: () => null,
      getTtsModelId: () => 'tts-1',
    });
    // Only non-ASCII / markup ⇒ sanitizes to empty ⇒ no synthesis attempted.
    expect(await voice.synthesizeSpeech('✨🎉')).toBeNull();
    expect(tts.calls).toHaveLength(0);
  });

  it('redacts payment strings before synthesis and returns PCM + sample rate', async () => {
    const tts = ttsReturning([10, 20, 30]);
    const voice = createQvacVoice({
      transcribe: (() => {}) as any,
      textToSpeech: tts.fn as any,
      getWhisperModelId: () => null,
      getTtsModelId: () => 'tts-1',
      ttsSampleRate: 22050,
    });
    const out = await voice.synthesizeSpeech('Pay lnbc1' + 'q'.repeat(60) + ' now');
    expect(out).toEqual({ pcm: [10, 20, 30], sampleRate: 22050 });
    expect(tts.calls[0].text).toContain('Lightning invoice');
    expect(tts.calls[0].text).not.toMatch(/lnbc1q/i);
    expect(tts.calls[0]).toMatchObject({ modelId: 'tts-1', inputType: 'text', stream: false });
  });

  it('defaults to the SUPERTONIC 44.1 kHz sample rate', async () => {
    const tts = ttsReturning([1]);
    const voice = createQvacVoice({
      transcribe: (() => {}) as any,
      textToSpeech: tts.fn as any,
      getWhisperModelId: () => null,
      getTtsModelId: () => 'tts-1',
    });
    const out = await voice.synthesizeSpeech('Your balance is five thousand sats');
    expect(out?.sampleRate).toBe(44100);
  });
});

describe('createQvacVoice.openVoiceSession', () => {
  const fakeSession = {
    write() {},
    end() {},
    destroy() {},
    async *[Symbol.asyncIterator]() {},
  };

  it('opens a VAD stream with the whisper model + default params', async () => {
    const calls: any[] = [];
    const transcribeStream = (p: any) => {
      calls.push(p);
      return Promise.resolve(fakeSession);
    };
    const voice = createQvacVoice({
      transcribe: (() => {}) as any,
      textToSpeech: (() => {}) as any,
      transcribeStream: transcribeStream as any,
      getWhisperModelId: () => 'w1',
      getTtsModelId: () => null,
    });
    const session = await voice.openVoiceSession();
    expect(session).toBe(fakeSession);
    expect(calls[0]).toMatchObject({ modelId: 'w1', emitVadEvents: true, endOfTurnSilenceMs: 700 });
  });

  it('merges param overrides over the defaults', async () => {
    const calls: any[] = [];
    const voice = createQvacVoice({
      transcribe: (() => {}) as any,
      textToSpeech: (() => {}) as any,
      transcribeStream: ((p: any) => { calls.push(p); return Promise.resolve(fakeSession); }) as any,
      getWhisperModelId: () => 'w1',
      getTtsModelId: () => null,
    });
    await voice.openVoiceSession({ endOfTurnSilenceMs: 1200 });
    expect(calls[0].endOfTurnSilenceMs).toBe(1200);
    expect(calls[0].emitVadEvents).toBe(true);
  });

  it('throws when transcribeStream was not provided', async () => {
    const voice = createQvacVoice({
      transcribe: (() => {}) as any,
      textToSpeech: (() => {}) as any,
      getWhisperModelId: () => 'w1',
      getTtsModelId: () => null,
    });
    await expect(voice.openVoiceSession()).rejects.toThrow(/transcribeStream not provided/);
  });

  it('throws when no Whisper model is loaded', async () => {
    const voice = createQvacVoice({
      transcribe: (() => {}) as any,
      textToSpeech: (() => {}) as any,
      transcribeStream: (() => Promise.resolve(fakeSession)) as any,
      getWhisperModelId: () => null,
      getTtsModelId: () => null,
    });
    await expect(voice.openVoiceSession()).rejects.toThrow(/not loaded/);
  });
});
