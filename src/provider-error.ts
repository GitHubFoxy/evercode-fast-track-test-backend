import type { CoinMarketCapFailureKind } from './coinmarketcap';

export interface HttpFailure {
  status: number;
  code: string;
  message: string;
}

export function coinMarketCapHttpFailure(kind: CoinMarketCapFailureKind, unknownIdIsInput = false): HttpFailure {
  if (kind === 'unknown-id' && unknownIdIsInput)
    return { status: 400, code: 'CMC_ID_NOT_FOUND', message: 'CoinMarketCap ID was not found' };
  if (kind === 'timeout')
    return { status: 504, code: 'CMC_TIMEOUT', message: 'CoinMarketCap request timed out' };
  return { status: 502, code: 'CMC_API_ERROR', message: 'CoinMarketCap request failed' };
}
