import { describe, it, expect } from 'vitest';
import {
  LOCAL_LLM_CONFIG,
  LOCAL_LLM_CONFIG_GPU,
  DELEGATE_LLM_CONFIG,
  TTS_SAMPLE_RATE,
  normalizeWhisperLang,
} from './config.js';

describe('model configs', () => {
  it('CPU baseline runs on cpu with tools enabled', () => {
    expect(LOCAL_LLM_CONFIG.device).toBe('cpu');
    expect(LOCAL_LLM_CONFIG.tools).toBe(true);
  });

  it('GPU config offloads layers and grows the context', () => {
    expect(LOCAL_LLM_CONFIG_GPU.device).toBe('gpu');
    expect(LOCAL_LLM_CONFIG_GPU.gpu_layers).toBe(99);
    expect(LOCAL_LLM_CONFIG_GPU.ctx_size).toBeGreaterThan(LOCAL_LLM_CONFIG.ctx_size);
  });

  it('delegate config gives the desktop the largest context', () => {
    expect(DELEGATE_LLM_CONFIG.ctx_size).toBe(16384);
    expect(DELEGATE_LLM_CONFIG.device).toBe('gpu');
  });

  it('TTS sample rate matches SUPERTONIC-2 output', () => {
    expect(TTS_SAMPLE_RATE).toBe(44100);
  });
});

describe('normalizeWhisperLang', () => {
  it('extracts a supported 2-letter code from a locale', () => {
    expect(normalizeWhisperLang('it-IT')).toBe('it');
    expect(normalizeWhisperLang('en_US')).toBe('en');
  });

  it('falls back to en for unsupported or missing locales', () => {
    expect(normalizeWhisperLang('xx-YY')).toBe('en');
    expect(normalizeWhisperLang('')).toBe('en');
    expect(normalizeWhisperLang(null)).toBe('en');
    expect(normalizeWhisperLang(undefined)).toBe('en');
  });
});
