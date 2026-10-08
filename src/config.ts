import { URL } from "node:url";
import type { QuotaFallback } from "./budget";
import { isIsoTimestamp } from "./coinmarketcap";

export interface ServiceConfig {
  apiToken: string;
  coinMarketCapApiKey: string;
  port: number;
  databasePath: string;
  priceCurrency: "USD";
  coinMarketCapTimeoutMs: number;
  syncIntervalMs: number;
  quota: QuotaFallback;
  batchSize: number;
  shutdownTimeoutMs: number;
  coinMarketCapBaseUrl?: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new ConfigurationError(`${name} is required`);
  return value;
}

function integer(
  environment: Record<string, string | undefined>,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name] ?? String(defaultValue);
  if (!/^\d+$/.test(raw)) {
    throw new ConfigurationError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
): ServiceConfig {
  const priceCurrency = environment.PRICE_CURRENCY ?? "USD";
  if (priceCurrency !== "USD") {
    throw new ConfigurationError("PRICE_CURRENCY must be USD");
  }
  const databasePath = required(environment, "DATABASE_PATH");
  if (databasePath === ":memory:") {
    throw new ConfigurationError("DATABASE_PATH must point to a SQLite file on disk");
  }

  const optional = (name: string, minimum = 0) => environment[name] === undefined ? undefined
    : integer(environment, name, 0, minimum, Number.MAX_SAFE_INTEGER);
  const quota: QuotaFallback = { monthlyLimit: optional('CMC_MONTHLY_LIMIT', 1), creditsLeft: optional('CMC_CREDITS_LEFT'),
    resetAt: environment.CMC_RESET_AT, minuteLimit: optional('CMC_RATE_LIMIT_MINUTE', 1),
    requestsLeft: optional('CMC_REQUESTS_LEFT'), keyInfoCredits: optional('CMC_KEY_INFO_CREDITS') };
  // An old bootstrap must not prevent reopening a DB whose official period has advanced.
  if (quota.resetAt !== undefined && !isIsoTimestamp(quota.resetAt))
    throw new ConfigurationError('CMC_RESET_AT must be an ISO timestamp');
  if (quota.monthlyLimit !== undefined && quota.creditsLeft !== undefined && quota.creditsLeft > quota.monthlyLimit
      || quota.minuteLimit !== undefined && quota.requestsLeft !== undefined && quota.requestsLeft > quota.minuteLimit)
    throw new ConfigurationError('Quota remainder must not exceed its limit');
  const coinMarketCapBaseUrl = environment.CMC_BASE_URL;
  if (coinMarketCapBaseUrl !== undefined) {
    let url: URL;
    try { url = new URL(coinMarketCapBaseUrl); } catch { throw new ConfigurationError('CMC_BASE_URL is invalid'); }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      throw new ConfigurationError('CMC_BASE_URL must use HTTPS or local loopback HTTP');
  }
  const apiToken = required(environment, "API_TOKEN");
  const coinMarketCapApiKey = required(environment, "COINMARKETCAP_API_KEY");
  if (apiToken === coinMarketCapApiKey)
    throw new ConfigurationError('API_TOKEN and COINMARKETCAP_API_KEY must differ');
  return {
    quota, coinMarketCapBaseUrl,
    batchSize: integer(environment, 'CMC_BATCH_SIZE', 250, 1, 1000),
    shutdownTimeoutMs: integer(environment, 'SHUTDOWN_TIMEOUT_MS', 10000, 1, 120000),
    apiToken,
    coinMarketCapApiKey,
    port: integer(environment, "PORT", 3000, 1, 65535),
    databasePath,
    priceCurrency,
    coinMarketCapTimeoutMs: integer(environment, "CMC_TIMEOUT_MS", 10000, 1, 120000),
    syncIntervalMs: integer(environment, "SYNC_INTERVAL_MS", 60000, 1000, 86400000),
  };
}
