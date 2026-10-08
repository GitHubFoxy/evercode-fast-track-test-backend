import { isIsoTimestamp } from './coinmarketcap';

export interface PageQuery { limit: number; offset: number; from?: string; to?: string }

export class InvalidQueryError extends Error {}

type RawQuery = Record<string, unknown>;

export function parsePageQuery(query: RawQuery, history = false): PageQuery {
  const allowed = history ? ['limit', 'offset', 'from', 'to'] : ['limit', 'offset'];
  if (Object.keys(query).some(key => !allowed.includes(key))) throw new InvalidQueryError();
  const integer = (raw: unknown, fallback: number, minimum: number, maximum: number): number => {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new InvalidQueryError();
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new InvalidQueryError();
    return value;
  };
  const date = (raw: unknown): string | undefined => {
    if (raw === undefined) return undefined;
    if (!isIsoTimestamp(raw)) throw new InvalidQueryError();
    return new Date(raw).toISOString();
  };
  const from = date(query.from);
  const to = date(query.to);
  if (from && to && from > to) throw new InvalidQueryError();
  return { limit: integer(query.limit, 50, 1, 100), offset: integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    from, to };
}
