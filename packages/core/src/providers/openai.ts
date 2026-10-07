/**
 * createOpenAICompatibleProvider — an LLMProvider over any server that speaks
 * the OpenAI Chat Completions API with tool calling: Ollama, llama.cpp
 * `llama-server`, LM Studio, vLLM, `qvac serve`, or a hosted API.
 *
 * No dependencies: it uses `fetch` (pass your own for older runtimes or tests).
 *
 * The Engine keeps history as plain `{ role, content }` messages. Tool calls
 * are written into the assistant's `rawContent` as `<tool_call>{json}</tool_call>`
 * blocks and turned back into `tool_calls` / `tool_call_id` pairs on the next
 * request, so the server always receives a valid tool-calling conversation.
 */
import type { Message, ToolCall } from '../types.js';
import type { InferenceMetrics, LLMProvider, ToolCallError, ToolChoice, TurnInput, TurnOutput } from './types.js';
import { extractTextToolCalls } from '../qvac/parse.js';
import { toolParametersSchema } from '../qvac/tools.js';

export interface OpenAICompatibleOptions {
  /** API root including the version, e.g. `http://localhost:11434/v1`. */
  baseUrl: string;
  /** Model name as the server knows it, e.g. `qwen3.5:4b`. */
  model: string;
  /** Sent as `Authorization: Bearer …` when set. */
  apiKey?: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
  /** Stream tokens (default true). Set false for servers without SSE. */
  stream?: boolean;
  /** Extra JSON merged into every request body (e.g. `{ reasoning_effort: 'low' }`). */
  extraBody?: Record<string, unknown>;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Reasoning deltas (`reasoning_content` / `reasoning`), when the server sends them. */
  onThinking?: (token: string) => void;
  fetch?: typeof fetch;
}

export interface OpenAITurnInput extends TurnInput {
  temperature?: number;
  maxTokens?: number;
}

type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

const TOOL_CALL_BLOCK = /<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi;

/** The assistant frame the Engine stores: visible text plus one block per call. */
export function encodeToolCalls(text: string, calls: ToolCall[]): string {
  const blocks = calls.map((c) => `<tool_call>${JSON.stringify({ name: c.name, arguments: c.arguments })}</tool_call>`);
  return [text.trim(), ...blocks].filter(Boolean).join('\n');
}

/** Engine history → Chat Completions messages, with ids pairing calls and results. */
export function toWireMessages(messages: Message[], system?: string): WireMessage[] {
  const out: WireMessage[] = system ? [{ role: 'system', content: system }] : [];
  let pending: string[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      const calls = extractTextToolCalls(m.content);
      const text = m.content.replace(TOOL_CALL_BLOCK, '').trim();
      pending = calls.map((_, j) => `call_${i}_${j}`);
      out.push(
        calls.length
          ? {
              role: 'assistant',
              content: text || null,
              tool_calls: calls.map((c, j) => ({
                id: pending[j]!,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })),
            }
          : { role: 'assistant', content: m.content },
      );
    } else if (m.role === 'tool') {
      const id = pending.shift();
      // A tool message with no call to answer (e.g. a parse-error note) would
      // be rejected by the server; send it as user context instead.
      out.push(id ? { role: 'tool', content: m.content, tool_call_id: id } : { role: 'user', content: `Tool result: ${m.content}` });
    } else {
      pending = [];
      out.push({ role: m.role as 'system' | 'user', content: m.content });
    }
  });
  return out;
}

function wireToolChoice(choice: ToolChoice | undefined): unknown {
  if (!choice) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  return { type: 'function', function: { name: choice } };
}

interface Accumulated {
  content: string;
  calls: Map<number, { id?: string; name: string; args: string }>;
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function absorbDelta(acc: Accumulated, delta: any, onToken?: (t: string) => void, onThinking?: (t: string) => void) {
  if (typeof delta?.content === 'string' && delta.content) {
    acc.content += delta.content;
    onToken?.(delta.content);
  }
  const reasoning = delta?.reasoning_content ?? delta?.reasoning;
  if (typeof reasoning === 'string' && reasoning) onThinking?.(reasoning);
  for (const tc of delta?.tool_calls ?? []) {
    const index = typeof tc.index === 'number' ? tc.index : acc.calls.size;
    const cur = acc.calls.get(index) ?? { name: '', args: '' };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name += tc.function.name;
    if (tc.function?.arguments) {
      cur.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
    }
    acc.calls.set(index, cur);
  }
}

async function readSse(body: ReadableStream<Uint8Array>, onEvent: (data: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data:')) onEvent(line.slice(5).trim());
    }
  }
  const last = buffer.trim();
  if (last.startsWith('data:')) onEvent(last.slice(5).trim());
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): LLMProvider {
  const doFetch = options.fetch ?? globalThis.fetch;
  if (!doFetch) throw new Error('No fetch available; pass options.fetch');
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const inflight = new Map<string, AbortController>();
  let seq = 0;

  return {
    name: 'openai-compatible',

    async runTurn(input: OpenAITurnInput): Promise<TurnOutput> {
      const requestId = `oai-${Date.now().toString(36)}-${++seq}`;
      const controller = new AbortController();
      inflight.set(requestId, controller);
      const onAbort = () => controller.abort();
      input.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.signal?.aborted) controller.abort();

      const stream = options.stream ?? true;
      const temperature = input.temperature ?? options.defaultTemperature;
      const maxTokens = input.maxTokens ?? options.defaultMaxTokens;
      const tools = input.tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description ?? '', parameters: toolParametersSchema(t) },
      }));
      const toolChoice = tools.length ? wireToolChoice(input.toolChoice) : undefined;
      const body = {
        model: options.model,
        messages: toWireMessages(input.messages, input.system),
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        ...(tools.length ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
        ...options.extraBody,
      };

      const startedAt = Date.now();
      let firstTokenAt: number | undefined;
      const mark = (f?: (t: string) => void) => (t: string) => {
        firstTokenAt ??= Date.now();
        f?.(t);
      };
      const acc: Accumulated = { content: '', calls: new Map() };
      let cancelled = false;
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            ...options.headers,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`${options.baseUrl} returned ${res.status}: ${detail.slice(0, 300)}`);
        }
        if (stream && res.body) {
          await readSse(res.body, (data) => {
            if (data === '[DONE]') return;
            let chunk: any;
            try {
              chunk = JSON.parse(data);
            } catch {
              return;
            }
            if (chunk.usage) acc.usage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (!choice) return;
            absorbDelta(acc, choice.delta, mark(input.onToken), mark(options.onThinking));
            if (choice.finish_reason) acc.finishReason = choice.finish_reason;
          });
        } else {
          const json: any = await res.json();
          const choice = json.choices?.[0];
          absorbDelta(acc, { ...choice?.message, tool_calls: choice?.message?.tool_calls?.map((c: any, index: number) => ({ index, ...c })) }, input.onToken, options.onThinking);
          acc.finishReason = choice?.finish_reason;
          acc.usage = json.usage;
        }
      } catch (err) {
        if (!controller.signal.aborted) throw err;
        cancelled = true;
      } finally {
        inflight.delete(requestId);
        input.signal?.removeEventListener('abort', onAbort);
      }

      const toolCalls: ToolCall[] = [];
      const toolErrors: ToolCallError[] = [];
      for (const c of [...acc.calls.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)) {
        if (!c.name) continue;
        try {
          const args = c.args.trim() ? JSON.parse(c.args) : {};
          toolCalls.push({ ...(c.id ? { id: c.id } : {}), name: c.name, arguments: args && typeof args === 'object' ? args : {} });
        } catch {
          toolErrors.push({ code: 'PARSE_ERROR', message: `arguments for ${c.name} are not valid JSON`, raw: c.args });
        }
      }
      // Models that ignore the tools API sometimes write the call as text.
      if (!toolCalls.length && !toolErrors.length) {
        for (const c of extractTextToolCalls(acc.content)) toolCalls.push(c);
      }
      const text = acc.content.replace(TOOL_CALL_BLOCK, '').trim();

      const truncated = acc.finishReason === 'length';
      const inference: InferenceMetrics = {
        requestId,
        durationMs: Date.now() - startedAt,
        status: cancelled ? 'cancelled' : truncated ? 'truncated' : 'completed',
        ...(firstTokenAt !== undefined ? { ttftMs: firstTokenAt - startedAt } : {}),
        ...(acc.usage?.prompt_tokens !== undefined ? { promptTokens: acc.usage.prompt_tokens } : {}),
        ...(acc.usage?.completion_tokens !== undefined ? { completionTokens: acc.usage.completion_tokens } : {}),
        ...(acc.usage?.total_tokens !== undefined ? { totalTokens: acc.usage.total_tokens } : {}),
        ...(acc.finishReason ? { stopReason: acc.finishReason } : {}),
      };

      return {
        text,
        rawContent: encodeToolCalls(text, toolCalls),
        toolCalls,
        ...(toolErrors.length && !toolCalls.length ? { toolErrors } : {}),
        requestId,
        inference,
      };
    },

    async cancel(requestId: string): Promise<void> {
      inflight.get(requestId)?.abort();
    },
  };
}
