/**
 * Small stats helpers so eval numbers are reported honestly — a pass-rate
 * without an interval is noise dressed as signal, especially at our sample sizes.
 *
 * We use the Wilson score interval for a binomial proportion (well-behaved at
 * small n and near 0/100%, unlike the naive normal approximation), and a
 * two-proportion z-test to say whether two cells actually differ.
 */

export interface CI {
  /** Point estimate, percent (0-100). */
  pct: number;
  /** Lower / upper bound, percent. */
  lo: number;
  hi: number;
  n: number;
}

const Z95 = 1.959963985;

/** Wilson 95% confidence interval for `passes` successes out of `n` trials. */
export function wilson(passes: number, n: number, z = Z95): CI {
  if (n <= 0) return { pct: 0, lo: 0, hi: 0, n: 0 };
  const p = passes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lo = (centre - margin) / denom;
  const hi = (centre + margin) / denom;
  return { pct: Math.round(p * 1000) / 10, lo: Math.round(lo * 1000) / 10, hi: Math.round(hi * 1000) / 10, n };
}

/** Compact label, e.g. "79% (66–88)". */
export function ciLabel(ci: CI): string {
  return `${Math.round(ci.pct)}% (${Math.round(ci.lo)}–${Math.round(ci.hi)})`;
}

/**
 * Two-proportion z-test p-value (two-sided). Returns the probability the two
 * pass-rates differ by chance; < 0.05 is the usual "significant" threshold.
 */
export function twoProportionP(a: { pass: number; n: number }, b: { pass: number; n: number }): number {
  if (a.n === 0 || b.n === 0) return 1;
  const p1 = a.pass / a.n;
  const p2 = b.pass / b.n;
  const pPool = (a.pass + b.pass) / (a.n + b.n);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / a.n + 1 / b.n));
  if (se === 0) return 1;
  const z = Math.abs(p1 - p2) / se;
  return 2 * (1 - normalCdf(z));
}

/** Whether the difference between two cells is significant at the given alpha. */
export function differ(a: { pass: number; n: number }, b: { pass: number; n: number }, alpha = 0.05): boolean {
  return twoProportionP(a, b) < alpha;
}

function normalCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26 approximation of erf.
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
