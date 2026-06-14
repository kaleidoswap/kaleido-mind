/**
 * Funnel — the tiered agent loop (T0 fast-path → T2 recipe → T1 agentic).
 *
 * This is the mobile-optimized funnel from the roadmap, lifted out of the
 * hosts so every surface (rate chat + voice, desktop provider, agent) runs
 * the SAME routing:
 *
 *   request
 *     ├─ T0  deterministic fast-path  (no LLM)        balance / address / price
 *     ├─ T2  recipe multi-step        (~1 inference)  "pay bob 3 EUR"
 *     └─ T1  skill-scoped agentic loop                everything else
 *
 * Hosts inject the provider, the tool registry, and a `getSettings` closure
 * read fresh each turn — so user-tunable settings (persona, history length,
 * memory/RAG toggles, disabled skills) never require rebuilding the funnel
 * or dropping host state like an embedded RAG index.
 *
 * Safety is unchanged from the Engine: spend tools are confirmation-gated by
 * the contract; with no `onConfirm` the gate fails closed.
 */

import { Engine } from './engine.js';
import type { ToolRegistry } from './tools/registry.js';
import { FastPath, WALLET_FAST_INTENTS } from './fastpath/fastpath.js';
import type { FastIntent } from './fastpath/fastpath.js';
import { RecipeRegistry, runRecipe } from './recipe/runner.js';
import { paymentsRecipe } from './recipe/payments.js';
import { receiveRecipe } from './recipe/receive.js';
import { assetSendRecipe } from './recipe/asset-send.js';
import type { Recipe } from './recipe/types.js';
import { SkillRegistry } from './skills/registry.js';
import type { Skill } from './skills/types.js';
import type { LLMProvider } from './providers/types.js';
import type { ConfirmDecision, Message, ToolResult } from './types.js';

/** Base system prompt for the wallet assistant. Hosts may override. */
export const DEFAULT_WALLET_SYSTEM = [
  'You are KaleidoSwap, a concise, privacy-first assistant running inside a',
  'non-custodial Bitcoin, Lightning and RGB wallet.',
  '',
  'CORE RULES (these override every skill instruction):',
  "1. If a tool can answer the user's question, CALL IT. Never describe how a",
  "   tool works (\"the pairs are listed using kaleidoswap_get_pairs\") — calling",
  '   the tool IS the answer.',
  '2. Never invent a balance, address, amount, price, quote, fee, pair, or any',
  "   other value. Every number or identifier in your reply MUST come from a tool",
  '   result returned in the CURRENT turn.',
  '3. Never reuse a number, name, or detail from a previous turn unless the user',
  '   is explicitly asking about that earlier result. Each new question gets a',
  '   fresh tool call.',
  '4. If a tool needs a required argument the user did not give (e.g. an amount',
  "   for a quote), ASK for it. Do not invent values. Do not call the tool with",
  '   the required field missing.',
  '5. All BTC amounts are in satoshis. Asset codes are case-insensitive but the',
  '   canonical forms are BTC, USDT, XAUT — do not silently shorten to USD, XAU.',
  '',
  'Keep replies short and friendly. When a tool returns multiple fields, surface',
  "the ones that matter — never collapse a structured result to a single number",
  'when other fields are non-zero or safety-relevant (e.g. pending balances,',
  'fees, slippage).',
].join('\n');

/** Tools that stay available even when a skill narrows the set. */
const AMBIENT_MEMORY = ['remember', 'recall'];
const AMBIENT_RAG = ['search_knowledge'];

const DEFAULT_HISTORY = 8;

/** Per-user agent settings, read fresh each turn via `getSettings`. */
export interface FunnelSettings {
  /** Extra instructions appended to the system prompt. */
  persona?: string;
  /** Most recent history messages to keep in the prompt (default 8). */
  historyLength?: number;
  /** Expose the remember/recall tools (default true). */
  memoryEnabled?: boolean;
  /** Expose the search_knowledge tool (default true). */
  ragEnabled?: boolean;
  /** Skill names the user turned off. */
  disabledSkills?: string[];
}

export interface FunnelCallbacks {
  history?: Message[];
  /** The live requestId of the agentic run (so a stop button can cancel it). */
  onStart?: (requestId: string) => void;
  onToken?: (token: string, turn: number) => void;
  /** A recipe step is executing (deterministic tier). */
  onStep?: (name: string) => void;
  /** The model requested a tool (agentic tier), before it executes. */
  onToolCall?: (
    call: { name: string; arguments: Record<string, unknown> },
    info: { requiresConfirmation: boolean },
  ) => void;
  /** A tool returned a result (agentic tier). Errors arrive as `{error}`. */
  onToolResult?: (event: {
    name: string;
    arguments: Record<string, unknown>;
    result: unknown;
  }) => void;
  onConfirm?: (call: { name: string; arguments: Record<string, unknown> }) => Promise<ConfirmDecision>;
}

export interface FunnelResult {
  text: string;
  tier: 'fast' | 'recipe' | 'agentic';
  /** Fast tier only: the matched intent + raw tool result (e.g. for a balance card). */
  intent?: string;
  data?: unknown;
  /** Agentic tier only: executed tool calls + reasoning turns. */
  toolCalls?: ToolResult[];
  turns?: number;
}

export interface FunnelOptions {
  provider: LLMProvider;
  /** ALL tool sources merged — wallet, memory, RAG, merchant, L402, … */
  tools: ToolRegistry;
  /** Skills available to the agentic tier (disabled ones filtered per turn). */
  skills?: Skill[];
  /** Recipes for the T2 tier. Default: asset-send, payments, receive. */
  recipes?: Recipe[];
  /** Fast-path intents for the T0 tier. Default: WALLET_FAST_INTENTS. */
  fastIntents?: FastIntent[];
  /** Base system prompt (persona is appended). Default: DEFAULT_WALLET_SYSTEM. */
  system?: string;
  /** Max reasoning↔tool rounds in the agentic tier. Default 5. */
  maxTurns?: number;
  /** User settings, read fresh each turn. */
  getSettings?: () => FunnelSettings;
  /** Render a fast-path tool result as user-facing text. Default: built-in. */
  renderFast?: (intent: string, result: unknown) => string;
  /** Diagnostics sink (tier routing, tool calls). Default: silent. */
  log?: (message: string) => void;
}

function defaultRenderFast(intent: string, r: any): string {
  if (intent === 'balance') {
    const sats = Number(r?.total_sats ?? 0);
    const n = r?.layers?.length ?? 0;
    return `You have ${sats.toLocaleString()} sats${n > 1 ? ` across ${n} layers` : ''}.`;
  }
  if (intent === 'address') {
    return r?.address ? `Here's your receive address:\n\n\`${r.address}\`` : 'No address available right now.';
  }
  return `Bitcoin is $${Number(r?.price_usd ?? 0).toLocaleString()}.`;
}

export class Funnel {
  private readonly provider: LLMProvider;
  private readonly registry: ToolRegistry;
  private readonly engine: Engine;
  private readonly fastPath: FastPath;
  private readonly recipes: RecipeRegistry;
  private readonly allSkills: Skill[];
  private readonly system: string;
  private readonly getSettings: () => FunnelSettings;
  private readonly renderFast: (intent: string, result: unknown) => string;
  private readonly log: (message: string) => void;

  /** Skill registry, rebuilt only when the disabled-skills set changes. */
  private skillsCache: { key: string; reg: SkillRegistry } | null = null;

  constructor(opts: FunnelOptions) {
    this.provider = opts.provider;
    this.registry = opts.tools;
    this.engine = new Engine({
      provider: opts.provider,
      tools: opts.tools,
      defaultMaxTurns: opts.maxTurns ?? 5,
    });
    this.fastPath = new FastPath(opts.fastIntents ?? WALLET_FAST_INTENTS);
    this.recipes = new RecipeRegistry(opts.recipes ?? [assetSendRecipe, paymentsRecipe, receiveRecipe]);
    this.allSkills = opts.skills ?? [];
    this.system = opts.system ?? DEFAULT_WALLET_SYSTEM;
    this.getSettings = opts.getSettings ?? (() => ({}));
    this.renderFast = opts.renderFast ?? defaultRenderFast;
    this.log = opts.log ?? (() => {});
  }

  /** Skills currently enabled (e.g. for a skills sheet). */
  listSkills(): Skill[] {
    return this.skillsFor(this.getSettings().disabledSkills).list();
  }

  private skillsFor(disabled: string[] = []): SkillRegistry {
    const key = [...disabled].sort().join(',');
    if (this.skillsCache?.key !== key) {
      this.skillsCache = {
        key,
        reg: new SkillRegistry(this.allSkills.filter((s) => !disabled.includes(s.name))),
      };
    }
    return this.skillsCache.reg;
  }

  async runTurn(text: string, cbs: FunnelCallbacks = {}): Promise<FunnelResult> {
    const settings = this.getSettings();

    // ── T0: deterministic fast-path (no LLM) ──
    // Only fires when the host's registry actually implements the intent's
    // tool — a partial tool surface (e.g. desktop without the core aggregate
    // helpers) falls through to the agentic tier instead of erroring.
    const fast = this.fastPath.select(text);
    if (fast && (await this.registry.getDef(fast.tool))) {
      this.log(`tier=fast-path → ${fast.tool}`);
      const r = await this.registry.execute(fast.tool, fast.args);
      return { text: this.renderFast(fast.intent.name, r), tier: 'fast', intent: fast.intent.name, data: r };
    }

    // ── T2: recipe multi-step — fires only when the recipe is confident given
    // its extracted slots (payments need a recipient; receive always fires),
    // and the registry implements the recipe's final action.
    const recipe = this.recipes.select(text);
    const slots = recipe?.extract?.(text) ?? null;
    const fires =
      !!recipe &&
      !!slots &&
      (recipe.confident ? recipe.confident(slots) : Object.keys(slots).length > 0) &&
      !!(await this.registry.getDef(recipe.final.tool));
    if (recipe && fires) {
      this.log(`tier=recipe:${recipe.name} slots=${JSON.stringify(slots)}`);
      const res = await runRecipe(recipe, text, {
        provider: this.provider,
        tools: this.registry,
        onConfirm: cbs.onConfirm,
        onStep: (name) => {
          this.log(`step ${name}`);
          cbs.onStep?.(name);
        },
      });
      return { text: res.text, tier: 'recipe' };
    }

    // ── T1: skill-scoped agentic loop ──
    const skills = this.skillsFor(settings.disabledSkills);
    const skill = skills.select(text);
    const base = settings.persona ? `${this.system}\n\n## Your persona\n${settings.persona}` : this.system;
    const { system, allowedTools } = skills.compose(base, skill);

    // Ambient tools stay available even when a skill narrows the set — gated
    // by the user's memory/knowledge toggles (default on).
    const memoryOn = settings.memoryEnabled !== false;
    const ragOn = settings.ragEnabled !== false;
    const ambient = [...(memoryOn ? AMBIENT_MEMORY : []), ...(ragOn ? AMBIENT_RAG : [])];
    const disabledAmbient = [...(memoryOn ? [] : AMBIENT_MEMORY), ...(ragOn ? [] : AMBIENT_RAG)];
    let scoped: string[] | undefined;
    if (allowedTools) {
      scoped = [...new Set([...allowedTools, ...ambient])];
    } else if (disabledAmbient.length) {
      // No skill matched but a toggle is off: expose everything except the
      // disabled ambient tools (the sources stay mounted — no rebuild).
      const all = (await this.registry.listTools()).map((t) => t.name);
      scoped = all.filter((n) => !disabledAmbient.includes(n));
    }

    // Trim history so the prompt (system + skill + tools + history) stays
    // within the small on-device model's context window.
    const keep = settings.historyLength ?? DEFAULT_HISTORY;
    const history = (cbs.history ?? []).slice(-keep);
    const messages: Message[] = [
      { role: 'system', content: system },
      ...history,
      { role: 'user', content: text },
    ];

    this.log(`tier=agentic skill=${skill?.name ?? 'none'} tools=[${(scoped ?? ['all']).join(',')}]`);
    const res = await this.engine.runAgentic(messages, {
      allowedTools: scoped,
      onStart: (requestId) => cbs.onStart?.(requestId),
      onToken: cbs.onToken,
      onToolCall: (call) => {
        this.log(`tool ${call.name} ${JSON.stringify(call.arguments)}`);
        // getDef is async; fire-and-forget so the loop is never blocked on UI.
        void this.registry
          .getDef(call.name)
          .then((def) => cbs.onToolCall?.(call, { requiresConfirmation: !!def?.requiresConfirmation }))
          .catch(() => cbs.onToolCall?.(call, { requiresConfirmation: false }));
      },
      onToolResult: cbs.onToolResult,
      onConfirm: cbs.onConfirm,
    });
    return { text: res.text ?? '', tier: 'agentic', toolCalls: res.toolCalls, turns: res.turns };
  }
}
