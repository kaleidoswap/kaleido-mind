/**
 * RGB tools take an `asset_id` (`rgb:…`), but users say "USDT". Small models
 * either look the id up first (an extra turn, and some stop after it) or pass
 * the ticker. When a send / RGB-invoice call carries a ticker, resolve it here
 * with the same host's `*_list_assets`, so one call does the job on every
 * host (in-app contract or kaleido-mcp).
 */

type Obj = Record<string, unknown>;

const NEEDS_ASSET_ID = /(^|_)(send_asset|create_rgb_invoice)$/;
const ASSET_KEYS = ['asset_id', 'asset'] as const;

function listedAssets(result: unknown): Obj[] {
  let r = result;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      return [];
    }
  }
  if (Array.isArray(r)) return r as Obj[];
  if (!r || typeof r !== 'object') return [];
  const o = r as Obj;
  if (Array.isArray(o.assets)) return o.assets as Obj[];
  return ['nia', 'cfa', 'uda', 'ifa'].flatMap((k) => (Array.isArray(o[k]) ? (o[k] as Obj[]) : []));
}

/**
 * `args` with a ticker in `asset_id` / `asset` replaced by the asset's id, or
 * `args` unchanged (not an RGB call, already an id, no list tool, no single
 * match).
 */
export async function resolveRgbTicker(
  toolName: string,
  args: Record<string, unknown>,
  host: {
    hasTool: (name: string) => Promise<boolean>;
    run: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  },
): Promise<Record<string, unknown>> {
  if (!NEEDS_ASSET_ID.test(toolName)) return args;
  const key = ASSET_KEYS.find((k) => typeof args[k] === 'string');
  const ticker = key ? String(args[key]).trim() : '';
  if (!key || !ticker || ticker.toLowerCase().startsWith('rgb:') || !/^[A-Za-z0-9]{1,12}$/.test(ticker)) return args;

  const listTool = toolName.replace(NEEDS_ASSET_ID, '$1list_assets');
  if (!(await host.hasTool(listTool))) return args;
  const matches = listedAssets(await host.run(listTool, {})).filter(
    (a) => typeof a.ticker === 'string' && a.ticker.toUpperCase() === ticker.toUpperCase() && typeof a.asset_id === 'string',
  );
  return matches.length === 1 ? { ...args, [key]: matches[0]!.asset_id } : args;
}
