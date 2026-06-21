/**
 * Risk guardrails — the spend safety from kaleidoagent's SOUL.md ("respect fund
 * safety above all", "dry_run means dry_run", "enforce min_btc_reserve before any
 * outbound") turned into an ENFORCED function instead of prompt text a small model
 * might ignore.
 *
 * The host calls `evaluateSpend` before any autonomous spend (and inside the
 * Funnel's `onConfirm`) to decide: allow silently, require user confirmation, or
 * block outright. Pure function — trivially testable, no I/O.
 *
 * Order of checks is intentional: hard blocks (dry-run, stop-loss, reserve, size,
 * order cap) come first; only a spend that clears all of them is sized against the
 * auto-approve threshold.
 */

export type SpendKind = 'pay' | 'send' | 'swap' | 'channel';

export interface RiskLimits {
  /** When true, NO spend executes — the agent describes what it WOULD do. */
  dryRun: boolean;
  /** Sats that must remain in BTC balance after any outbound. */
  minBtcReserveSat: number;
  /** Hard floor: if BTC balance is at/below this, block all spends. */
  stopLossBtcSat: number;
  /** Max USD value of a single autonomous spend. */
  maxSpendUsd: number;
  /** Spends at/under this USD value auto-approve; above need confirmation. */
  autoApproveUnderUsd: number;
  /** Block new swaps/channels once this many orders are already open. */
  maxOpenOrders?: number;
}

export interface SpendAction {
  kind: SpendKind;
  /** Sats leaving the BTC balance (omit for pure asset sends). */
  amountSat?: number;
  /** USD value of the spend — used for the size + auto-approve gates. */
  amountUsd?: number;
}

export interface RiskContext {
  /** Spendable BTC right now (sats). */
  btcBalanceSat?: number;
  /** Currently open orders (for the order-cap gate). */
  openOrders?: number;
}

export type RiskOutcome = 'allow' | 'confirm' | 'block';

export interface RiskVerdict {
  outcome: RiskOutcome;
  /** True when the host MUST gate on user confirmation before executing. */
  requiresConfirmation: boolean;
  reason: string;
}

/** Sensible defaults — conservative. Hosts override per user settings. */
export const DEFAULT_RISK_LIMITS: RiskLimits = {
  dryRun: true,
  minBtcReserveSat: 50_000,
  stopLossBtcSat: 50_000,
  maxSpendUsd: 50,
  autoApproveUnderUsd: 0, // 0 = always confirm unless the host raises it
  maxOpenOrders: 3,
};

export function evaluateSpend(
  action: SpendAction,
  limits: RiskLimits,
  ctx: RiskContext = {},
): RiskVerdict {
  const block = (reason: string): RiskVerdict => ({
    outcome: 'block',
    requiresConfirmation: false,
    reason,
  });

  // 1. Dry-run: nothing moves, full stop.
  if (limits.dryRun) {
    return block(`dry-run is on — would ${action.kind}, but no funds move`);
  }

  const balance = ctx.btcBalanceSat;

  // 2. Stop-loss: balance already at/below the floor.
  if (balance !== undefined && balance <= limits.stopLossBtcSat) {
    return block(
      `BTC balance ${balance} sat is at/below the stop-loss floor ${limits.stopLossBtcSat} sat`,
    );
  }

  // 3. Reserve: this spend would dip below the reserve.
  if (action.amountSat !== undefined && balance !== undefined) {
    const after = balance - action.amountSat;
    if (after < limits.minBtcReserveSat) {
      return block(
        `would leave ${after} sat, below the ${limits.minBtcReserveSat} sat reserve`,
      );
    }
  }

  // 4. Size cap.
  if (action.amountUsd !== undefined && action.amountUsd > limits.maxSpendUsd) {
    return block(
      `$${action.amountUsd} exceeds the max single spend $${limits.maxSpendUsd}`,
    );
  }

  // 5. Open-order cap (swaps/channels only).
  if (
    (action.kind === 'swap' || action.kind === 'channel') &&
    limits.maxOpenOrders !== undefined &&
    ctx.openOrders !== undefined &&
    ctx.openOrders >= limits.maxOpenOrders
  ) {
    return block(
      `${ctx.openOrders} open orders ≥ cap ${limits.maxOpenOrders} — not opening another`,
    );
  }

  // 6. Cleared all hard gates → size against the auto-approve threshold.
  // An unknown USD value defaults to confirm (safe): never auto-spend blind.
  if (action.amountUsd !== undefined && action.amountUsd <= limits.autoApproveUnderUsd) {
    return {
      outcome: 'allow',
      requiresConfirmation: false,
      reason: `$${action.amountUsd} ≤ auto-approve $${limits.autoApproveUnderUsd}`,
    };
  }

  return {
    outcome: 'confirm',
    requiresConfirmation: true,
    reason:
      action.amountUsd !== undefined
        ? `$${action.amountUsd} above auto-approve $${limits.autoApproveUnderUsd} — needs confirmation`
        : `unknown spend value — needs confirmation`,
  };
}
