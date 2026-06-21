import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_SCHEMA,
  EvidenceRecorder,
  sanitizeEvidenceEvent,
  type EvidenceEvent,
} from './evidence.js';

function memoryRecorder(lines: string[]) {
  return new EvidenceRecorder({
    io: {
      appendLine: async (line) => {
        lines.push(line);
      },
      now: () => new Date('2026-06-20T12:00:00.000Z'),
    },
  });
}

describe('EvidenceRecorder', () => {
  it('writes a completed inference receipt', async () => {
    const lines: string[] = [];
    const event = await memoryRecorder(lines).record({
      event: 'inference',
      runId: 'desktop-demo',
      surface: 'desktop',
      prompt: 'show my balance',
      response: 'You have 42 sats.',
      inference: [{ durationMs: 220, ttftMs: 40, totalTokens: 18, status: 'completed' }],
    });
    expect(event.schema).toBe(EVIDENCE_SCHEMA);
    expect(JSON.parse(lines[0]).inference[0].ttftMs).toBe(40);
  });

  it('records a failed inference without inventing token metrics', async () => {
    const lines: string[] = [];
    await memoryRecorder(lines).record({
      event: 'error',
      runId: 'failed-demo',
      surface: 'test',
      error: { name: 'ModelError', message: 'model failed to load' },
    });
    expect(JSON.parse(lines[0]).error.name).toBe('ModelError');
  });

  it('records tool calls and confirmation decisions', async () => {
    const lines: string[] = [];
    const recorder = memoryRecorder(lines);
    await recorder.record({
      event: 'tool_call',
      runId: 'tools-demo',
      surface: 'mobile',
      tool: { name: 'rln_send_btc', arguments: { amount_sat: 100 } },
    });
    await recorder.record({
      event: 'confirmation',
      runId: 'tools-demo',
      surface: 'mobile',
      confirmation: { tool: 'rln_send_btc', approved: false, reason: 'demo stop' },
    });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).confirmation.approved).toBe(false);
  });

  it('sanitizes payment material in interrupted runs', () => {
    const event: EvidenceEvent = {
      schema: EVIDENCE_SCHEMA,
      event: 'inference',
      ts: '2026-06-20T12:00:00.000Z',
      runId: 'cancelled-demo',
      surface: 'mobile',
      prompt: 'pay lnbc123456789012345678901234567890',
      tool: { name: 'rln_pay_invoice', arguments: { invoice: 'lnbc-secret' } },
      inference: { durationMs: 50, status: 'cancelled' },
    };
    const clean = sanitizeEvidenceEvent(event);
    expect(clean.prompt).toContain('[payment-data-redacted]');
    expect(clean.tool?.arguments?.invoice).toBe('[redacted]');
  });
});
