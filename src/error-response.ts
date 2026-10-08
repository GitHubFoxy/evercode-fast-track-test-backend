import type { Response } from 'express';
import { TrackingChangedError, DuplicateTrackingError } from './database';
import { CoinMarketCapError } from './coinmarketcap';
import { coinMarketCapHttpFailure } from './provider-error';

export function sendError(response: Response, status: number, code: string, message: string): void {
  response.status(status).json({ error: { code, message } });
}

/** Maps domain errors shared by the write routes; returns false for anything unexpected. */
export function sendDomainError(response: Response, error: unknown, unknownIdIsInput: boolean, changedMessage: string): boolean {
  if (error instanceof TrackingChangedError) {
    sendError(response, 409, 'TRACKING_CHANGED', changedMessage);
  } else if (error instanceof DuplicateTrackingError) {
    sendError(response, 409, 'ALREADY_TRACKED', 'Cryptocurrency is already tracked');
  } else if (error instanceof CoinMarketCapError) {
    const failure = coinMarketCapHttpFailure(error.kind, unknownIdIsInput);
    sendError(response, failure.status, failure.code, failure.message);
  } else return false;
  return true;
}
