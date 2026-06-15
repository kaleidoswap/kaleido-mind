/**
 * Delegation helpers — the provider firewall (who may connect) and the
 * consumer-side delegate config. Pure data builders (no `@qvac/sdk` import) so
 * they stay shared + testable; the host passes the result to
 * `startQVACProvider({ firewall })` / `loadModel({ delegate })`.
 *
 * Security note: a QVAC provider is reachable by anyone who learns its
 * Hyperswarm public key. Advertising with no firewall means any such peer can
 * run inference on your machine. Use {@link allowListFirewall} so a desktop
 * provider serves ONLY its paired phone(s).
 */

/** Firewall for `startQVACProvider` — restrict who may delegate to this provider. */
export interface ProviderFirewall {
  mode: 'allow' | 'deny';
  publicKeys: string[];
}

function normalizeKeys(keys: Iterable<string>): string[] {
  return [...new Set([...keys].map((k) => k.trim()).filter(Boolean))];
}

/**
 * Allow ONLY these consumer public keys to delegate (zero-trust). Pass the
 * paired phone(s)' public keys so no one else can use the desktop brain even if
 * they learn its public key.
 */
export function allowListFirewall(consumerPublicKeys: Iterable<string>): ProviderFirewall {
  return { mode: 'allow', publicKeys: normalizeKeys(consumerPublicKeys) };
}

/** Deny these consumer public keys; everyone else may connect. */
export function denyListFirewall(consumerPublicKeys: Iterable<string>): ProviderFirewall {
  return { mode: 'deny', publicKeys: normalizeKeys(consumerPublicKeys) };
}

/**
 * Parse a comma/space/newline-separated key list (e.g. from an env var or a
 * pairing store) into an allow-list firewall, or `undefined` when none are
 * configured — the caller then advertises openly and should warn.
 */
export function firewallFromKeyList(raw: string | null | undefined): ProviderFirewall | undefined {
  if (!raw) return undefined;
  const keys = raw.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);
  return keys.length ? allowListFirewall(keys) : undefined;
}

/** Consumer-side config for `loadModel({ delegate })`. */
export interface DelegateConfig {
  providerPublicKey: string;
  fallbackToLocal: boolean;
  timeout?: number;
  forceNewConnection?: boolean;
}

/**
 * Build the `delegate` config for a delegated `loadModel`. `fallbackToLocal`
 * defaults to false (the host owns recovery), matching rate's existing
 * LLM/Whisper/TTS delegated loads.
 */
export function buildDelegateConfig(
  providerPublicKey: string,
  opts: { fallbackToLocal?: boolean; timeout?: number; forceNewConnection?: boolean } = {},
): DelegateConfig {
  return {
    providerPublicKey: providerPublicKey.trim(),
    fallbackToLocal: opts.fallbackToLocal ?? false,
    ...(opts.timeout != null ? { timeout: opts.timeout } : {}),
    ...(opts.forceNewConnection != null ? { forceNewConnection: opts.forceNewConnection } : {}),
  };
}
