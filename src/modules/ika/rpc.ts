/**
 * @module ika/rpc
 *
 * RPC endpoint resolution and priority ranking for the Sui JSON-RPC
 * connections used by the IKA client.
 *
 * Separated from the client lifecycle module because endpoint selection
 * is a pure-data concern — it reads configuration, deduplicates, and
 * ranks.  It has no side effects and no dependency on SDK imports.
 *
 * Rationale (Open/Closed Principle):
 *   Adding a new RPC provider or changing priority rules requires
 *   editing only this file, not the client initialisation logic.
 */

import { env } from "../../config/env";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TESTNET_DEFAULTS: readonly string[] = [
  "https://fullnode.testnet.sui.io:443",
  "https://sui-testnet.publicnode.com",
] as const;

const MAINNET_DEFAULTS: readonly string[] = [
  "https://fullnode.mainnet.sui.io:443",
] as const;

const DEFAULTS_BY_NETWORK: Readonly<Record<"testnet" | "mainnet", readonly string[]>> = {
  testnet: TESTNET_DEFAULTS,
  mainnet: MAINNET_DEFAULTS,
};

// ---------------------------------------------------------------------------
// Priority ranking
// ---------------------------------------------------------------------------

/**
 * Assign a numeric priority to a URL.  Lower numbers = tried first.
 *
 *   0 — the user-configured primary RPC
 *   1 — Mysten official fullnode (most reliable in benchmarks)
 *   2 — publicnode.com community RPC
 *   3 — everything else (user-supplied fallback list)
 */
function priorityOf(url: string): number {
  if (url === env.IKA_SUI_RPC_URL) {
    return 0;
  }

  if (
    (env.IKA_NETWORK === "testnet" && url.includes("fullnode.testnet.sui.io")) ||
    (env.IKA_NETWORK === "mainnet" && url.includes("fullnode.mainnet.sui.io"))
  ) {
    return 1;
  }

  if (url.includes("publicnode.com")) {
    return 2;
  }

  return 3;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a deduplicated, priority-sorted list of RPC endpoint URLs to try
 * when initialising the IKA client.
 *
 * Sources (merged in order):
 *   1. Hard-coded defaults for the current network
 *   2. `IKA_SUI_RPC_URL` (primary)
 *   3. `IKA_SUI_RPC_URLS` (comma-separated fallback list)
 */
export function getRpcCandidates(): string[] {
  const raw = [
    ...DEFAULTS_BY_NETWORK[env.IKA_NETWORK],
    env.IKA_SUI_RPC_URL,
    ...(env.IKA_SUI_RPC_URLS ?? []),
  ];

  const seen = new Set<string>();
  const deduped = raw.filter((entry) => {
    if (seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });

  return [...deduped].sort((a, b) => priorityOf(a) - priorityOf(b));
}
