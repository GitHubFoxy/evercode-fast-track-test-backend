export interface ServiceConfig {
  apiToken: string;
  coinMarketCapApiKey: string;
  port: number;
  databasePath: string;
  priceCurrency: "USD";
  coinMarketCapTimeoutMs: number;
  syncIntervalMs: number;
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

  return {
    apiToken: required(environment, "API_TOKEN"),
    coinMarketCapApiKey: required(environment, "COINMARKETCAP_API_KEY"),
    port: integer(environment, "PORT", 3000, 1, 65535),
    databasePath,
    priceCurrency,
    coinMarketCapTimeoutMs: integer(environment, "CMC_TIMEOUT_MS", 10000, 1, 120000),
    syncIntervalMs: integer(environment, "SYNC_INTERVAL_MS", 60000, 1000, 86400000),
  };
}
