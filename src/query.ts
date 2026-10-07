export interface PageQuery { limit: number; offset: number; from?: string; to?: string }

export class InvalidQueryError extends Error {}

export function parsePageQuery(query: any, history = false): PageQuery {
  if (Object.keys(query).some(key => !(history ? ['limit', 'offset', 'from', 'to'] : ['limit', 'offset']).includes(key))) throw new InvalidQueryError();
  const integer = (raw: any, fallback: number, minimum: number, maximum: number): number => {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw new InvalidQueryError();
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new InvalidQueryError();
    return value;
  };
  const date = (raw: any): string | undefined => {
    if (raw === undefined) return undefined;
    if (!require('./coinmarketcap').isIsoTimestamp(raw)) throw new InvalidQueryError();
    return new Date(raw).toISOString();
  };
  const from = date(query.from);
  const to = date(query.to);
  if (from && to && from > to) throw new InvalidQueryError();
  return { limit: integer(query.limit, 50, 1, 100), offset: integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    from, to };
}
