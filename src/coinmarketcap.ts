import axios, { isAxiosError } from "axios";
import type { ProviderBudget } from "./budget";

export interface UsdQuote {
  cmcId: number;
  name: string;
  symbol: string;
  price: number;
  providerUpdatedAt: string;
}

export type CoinMarketCapFailureKind = "unknown-id" | "timeout" | "provider-error";

export class CoinMarketCapError extends Error {
  /** Parsed provider JSON of an HTTP error response, kept so the budget can read the real credit count. */
  providerBody?: unknown;
  httpStatus?: number;
  retryAfterMs?: number;
  constructor(public readonly kind: CoinMarketCapFailureKind) {
    super(kind);
    this.name = "CoinMarketCapError";
  }
}

export interface CoinMarketCapConfig {
  apiKey: string;
  timeoutMs: number;
  baseUrl?: string;
  budget?: ProviderBudget;
  background?: boolean;
  batchSize?: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isIsoTimestamp(value: unknown): value is string {
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

  const matches = body.data.filter((entry: unknown): entry is Record<string, unknown> => isRecord(entry) && entry.id === cmcId);
  if (matches.length > 1) return invalidResponse();
  const coin = matches[0];
  if (!coin) throw new CoinMarketCapError("unknown-id");
  if (typeof coin.name !== "string" || coin.name.trim() === ""
      || typeof coin.symbol !== "string" || coin.symbol.trim() === ""
      || !isIsoTimestamp(coin.last_updated) || !Array.isArray(coin.quote)) {
    return invalidResponse();
  }

  const usdQuotes = coin.quote.filter((entry: unknown): entry is Record<string, unknown> => isRecord(entry) && entry.symbol === "USD");
  if (usdQuotes.length !== 1) return invalidResponse();
  const quote = usdQuotes[0];
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

async function requestQuotes(config: CoinMarketCapConfig, cmcIds: number[]): Promise<unknown> {
  if (config.budget) return config.budget.call(Math.ceil(cmcIds.length / 250), Boolean(config.background),
    signal => transport(config, `/v3/cryptocurrency/quotes/latest?id=${cmcIds.join(',')}&convert=USD`, signal));
  throw new CoinMarketCapError('provider-error');
}

/** Only a 400 whose provider status message names the "id" parameter proves the ID is unknown. */
function isInvalidIdResponse(status: number, body: unknown): boolean {
  if (status !== 400 || !isRecord(body) || !isRecord(body.status)) return false;
  const message = body.status.error_message;
  return typeof message === "string" && /invalid value for "id"/i.test(message);
}

export async function transport(config: CoinMarketCapConfig, endpoint: string, signal?: AbortSignal): Promise<unknown> {
  const baseUrl = (config.baseUrl ?? "https://pro-api.coinmarketcap.com").replace(/\/$/, "");
  try {
    const response = await axios.get<unknown>(`${baseUrl}${endpoint}`, {
      headers: { "X-CMC_PRO_API_KEY": config.apiKey },
      timeout: config.timeoutMs,
      signal,
      maxRedirects: 0,
    });
    return response.data;
  } catch (error) {
    if (!isAxiosError(error)) throw new CoinMarketCapError("provider-error");
    if (error.response) {
      const failure = new CoinMarketCapError(isInvalidIdResponse(error.response.status, error.response.data) ? 'unknown-id' : 'provider-error');
      failure.providerBody = error.response.data;
      failure.httpStatus = error.response.status;
      const retry: unknown = error.response.headers?.['retry-after'];
      const retryMs = typeof retry === 'string' && /^\d+$/.test(retry) ? Number(retry) * 1000
        : typeof retry === 'string' ? Date.parse(retry) - Date.now() : NaN;
      if (Number.isSafeInteger(retryMs) && retryMs >= 0) failure.retryAfterMs = retryMs;
      throw failure;
    }
    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") throw new CoinMarketCapError("timeout");
    throw new CoinMarketCapError("provider-error");
  }
}

export async function getUsdQuote(config: CoinMarketCapConfig, cmcId: number): Promise<UsdQuote> {
  return parseQuote(await requestQuotes(config, [cmcId]), cmcId);
}

// 250 is a credit tier, not a documented provider maximum.
export async function getUsdQuotes(config: CoinMarketCapConfig, cmcIds: number[]): Promise<UsdQuote[]> {
  const quotes: UsdQuote[] = [];
  const size = config.batchSize ?? 250;
  for (let offset = 0; offset < cmcIds.length; offset += size) {
    const batch = cmcIds.slice(offset, offset + size);
    const body = await requestQuotes(config, batch);
    for (const id of batch) quotes.push(parseQuote(body, id));
  }
  return quotes;
}
