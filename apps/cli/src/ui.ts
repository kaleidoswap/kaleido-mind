/** Tiny zero-dep ANSI UI kit — colors, banner, boxes, tables, progress bars. */

const ESC = '\x1b[';
const wrap = (code: string) => (s: string) => `${ESC}${code}m${s}${ESC}0m`;

export const c = {
  reset: `${ESC}0m`,
  bold: wrap('1'),
  dim: wrap('2'),
  italic: wrap('3'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
  violet: wrap('38;5;141'),
  pink: wrap('38;5;213'),
  teal: wrap('38;5;43'),
};

/** Visible length (ignores ANSI escapes) — for alignment. */
export function vlen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - vlen(s)));
}

export function bytes(n: number): string {
  if (!n) return '—';
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

/** The KaleidoMind banner — a kaleidoscopic brain. */
export function banner(): string {
  const g = [c.violet, c.pink, c.cyan, c.teal];
  const art = [
    '   ◢◤◢◤◢◤   ',
    '  ◢ ▟▙ ▟▙ ◣  ',
    ' ◢◤ ▜▛ ▜▛ ◥◣ ',
    '  ◥◣    ◢◤  ',
    '   ◥◤◥◤◥◤   ',
  ].map((l, i) => g[i % g.length]!(l));
  const title = `${c.bold(c.violet('KALEIDO'))}${c.bold(c.pink('MIND'))}`;
  return (
    `\n${art[0]}\n${art[1]}   ${title}\n${art[2]}   ${c.dim('sovereign AI for sovereign money')}\n${art[3]}\n${art[4]}\n`
  );
}

/** A rounded unicode box around lines, with an optional title. */
export function box(lines: string[], title?: string, color = c.violet): string {
  const width = Math.max(...lines.map(vlen), title ? vlen(title) + 2 : 0, 20);
  const top = title
    ? `${color('╭─')} ${c.bold(title)} ${color('─'.repeat(Math.max(0, width - vlen(title) - 3)) + '╮')}`
    : color('╭' + '─'.repeat(width + 2) + '╮');
  const bottom = color('╰' + '─'.repeat(width + 2) + '╯');
  const body = lines.map((l) => `${color('│')} ${pad(l, width)} ${color('│')}`).join('\n');
  return `${top}\n${body}\n${bottom}`;
}

/** Aligned table (no header rule). rows: string[][] (cells may be colored). */
export function table(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => vlen(r[i] ?? ''))));
  return rows
    .map((r) => r.map((cell, i) => pad(cell ?? '', widths[i]!)).join('  ').trimEnd())
    .join('\n');
}

/** A progress bar string, e.g. ███████░░░ 70%. */
export function bar(pct: number, width = 24): string {
  const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width);
  return `${c.violet('█'.repeat(filled))}${c.gray('░'.repeat(width - filled))} ${String(pct).padStart(3)}%`;
}

export const dot = (on: boolean) => (on ? c.green('●') : c.gray('○'));

/** Overwrite the current terminal line (for live progress). */
export function rewriteLine(s: string): void {
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[K${s}`);
}
