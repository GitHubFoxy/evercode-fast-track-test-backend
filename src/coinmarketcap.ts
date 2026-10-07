const axios: any = require("axios");

export interface UsdQuote {
  cmcId: number;
  name: string;
  symbol: string;
  price: number;
  providerUpdatedAt: string;
}

export type CoinMarketCapFailureKind = "unknown-id" | "timeout" | "provider-error";

export class CoinMarketCapError extends Error {
  constructor(public readonly kind: CoinMarketCapFailureKind) {
    super(kind);
    this.name = "CoinMarketCapError";
  }
}

export interface CoinMarketCapConfig {
  apiKey: string;
  timeoutMs: number;
  baseUrl?: string;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;

  const [, year, month, day, hour, minute, second, , zoneHour, zoneMinute] = match;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  calendar.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  return calendar.getUTCFullYear() === Number(year)
    && calendar.getUTCMonth() === Number(month) - 1
    && calendar.getUTCDate() === Number(day)
    && Number(hour) <= 23
    && Number(minute) <= 59
    && Number(second) <= 59
    && (!zoneHour || (Number(zoneHour) <= 23 && Number(zoneMinute) <= 59));
}

function invalidResponse(): never {
  throw new CoinMarketCapError("provider-error");
}

function parseQuote(body: unknown, cmcId: number): UsdQuote {
  if (!isRecord(body) || !Array.isArray(body.data) || !isRecord(body.status)
      || body.status.error_code !== 0) {
    return invalidResponse();
  }

  const coin = body.data.find((entry: unknown) => isRecord(entry) && entry.id === cmcId);
  if (!coin) throw new CoinMarketCapError("unknown-id");
  if (typeof coin.name !== "string" || coin.name.trim() === ""
      || typeof coin.symbol !== "string" || coin.symbol.trim() === ""
      || !isIsoTimestamp(coin.last_updated) || !Array.isArray(coin.quote)) {
    return invalidResponse();
  }

  const quote = coin.quote.find((entry: unknown) => isRecord(entry) && entry.symbol === "USD");
  if (!quote || typeof quote.price !== "number" || !Number.isFinite(quote.price) || quote.price < 0
      || !isIsoTimestamp(quote.last_updated)) {
    return invalidResponse();
  }

  return {
    cmcId,
    name: coin.name,
    symbol: coin.symbol,
    price: quote.price,
    providerUpdatedAt: quote.last_updated,
  };
}

export async function getUsdQuote(config: CoinMarketCapConfig, cmcId: number): Promise<UsdQuote> {
  const baseUrl = (config.baseUrl ?? "https://pro-api.coinmarketcap.com").replace(/\/$/, "");
  let response: any;
  try {
    response = await axios.get(
      `${baseUrl}/v3/cryptocurrency/quotes/latest?id=${cmcId}&convert=USD`,
      {
        headers: { "X-CMC_PRO_API_KEY": config.apiKey },
        timeout: config.timeoutMs,
      },
    );
  } catch (error: any) {
    if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") {
      throw new CoinMarketCapError("timeout");
    }
    if (error?.response?.status === 400) {
      throw new CoinMarketCapError("unknown-id");
    }
    throw new CoinMarketCapError("provider-error");
  }
  return parseQuote(response.data, cmcId);
}
