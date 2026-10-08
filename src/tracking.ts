import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import {
  getTrackingSnapshot,
  isCmcIdTracked,
  replaceTrackedCryptocurrencyWithQuote,
  deleteTrackedCryptocurrency,
  DuplicateTrackingError,
} from './database';
import type { Database } from './database';
import { getUsdQuote } from './coinmarketcap';
import type { ApplicationConfig } from './app';
import { sendDomainError, sendError } from './error-response';

/** Returns the validated positive `cmcId` of a `{ "cmcId": n }` body, or undefined when the body is invalid. */
export function parseCmcIdBody(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  const cmcId = (body as Record<string, unknown>).cmcId;
  return keys.length === 1 && keys[0] === 'cmcId' && Number.isSafeInteger(cmcId) && (cmcId as number) > 0
    ? cmcId as number : undefined;
}

export function isPositiveIntegerPath(value: string): boolean {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

export function registerTrackingMutations(app: Express, database: Database, config: ApplicationConfig): void {
  const validateTrackingId: RequestHandler = (request, response, next) => {
    if (!isPositiveIntegerPath(request.params.id as string)) {
      sendError(response, 400, 'INVALID_TRACKING_ID', 'Tracking ID must be a positive integer');
      return;
    }
    next();
  };
  app.delete('/api/tracked-cryptocurrencies/:id', validateTrackingId, (request: Request, response: Response) => {
    if (!deleteTrackedCryptocurrency(database, Number(request.params.id))) {
      sendError(response, 404, 'TRACKING_NOT_FOUND', 'Tracking record was not found');
      return;
    }
    response.status(204).end();
  });
  app.put('/api/tracked-cryptocurrencies/:id', validateTrackingId, async (request: Request, response: Response, next: NextFunction) => {
    const cmcId = parseCmcIdBody(request.body);
    if (cmcId === undefined) {
      sendError(response, 400, 'INVALID_CMC_ID', 'A positive integer cmcId is required');
      return;
    }
    try {
      const snapshot = getTrackingSnapshot(database, Number(request.params.id));
      if (!snapshot) {
        sendError(response, 404, 'TRACKING_NOT_FOUND', 'Tracking record was not found');
        return;
      }
      if (snapshot.cmcId !== cmcId && isCmcIdTracked(database, cmcId)) throw new DuplicateTrackingError();
      const quote = await getUsdQuote({
        apiKey: config.coinMarketCapApiKey,
        timeoutMs: config.coinMarketCapTimeoutMs,
        baseUrl: config.coinMarketCapBaseUrl, budget: config.budget, batchSize: config.batchSize,
      }, cmcId);
      response.status(200).json(replaceTrackedCryptocurrencyWithQuote(database, snapshot, quote, new Date((config.clock?.now ?? Date.now)()).toISOString()));
    } catch (error) {
      if (!sendDomainError(response, error, true, 'Tracking record changed while the request was in progress')) next(error);
    }
  });
}
