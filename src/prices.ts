import type { Express, NextFunction, Request, Response } from 'express';
import { getTrackingSnapshot, listTrackedCryptocurrencies, saveTrackedQuotes } from './database';
import type { Database, TrackingSnapshot } from './database';
import { getUsdQuotes } from './coinmarketcap';
import type { ApplicationConfig } from './app';
import { sendDomainError, sendError } from './error-response';

export function registerPriceRoutes(app: Express, database: Database, config: ApplicationConfig): void {
  const handler = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (Object.keys(request.query).length) {
      sendError(response, 400, 'INVALID_QUERY', 'Query parameters are invalid');
      return;
    }
    const rawId = request.params.id as string | undefined;
    const single = rawId !== undefined;
    if (single && (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId)))) {
      sendError(response, 400, 'INVALID_TRACKING_ID', 'Tracking ID must be a positive integer');
      return;
    }
    const tracked = single ? getTrackingSnapshot(database, Number(rawId)) : undefined;
    if (single && !tracked) {
      sendError(response, 404, 'TRACKING_NOT_FOUND', 'Tracking record was not found');
      return;
    }
    try {
      const snapshot: TrackingSnapshot[] = tracked ? [tracked]
        : listTrackedCryptocurrencies(database)
          .map(item => getTrackingSnapshot(database, item.id))
          .filter((item): item is TrackingSnapshot => item !== undefined);
      const quotes = await getUsdQuotes({ apiKey: config.coinMarketCapApiKey,
        timeoutMs: config.coinMarketCapTimeoutMs, baseUrl: config.coinMarketCapBaseUrl, budget: config.budget,
        batchSize: config.batchSize }, snapshot.map(item => item.cmcId));
      const saved = saveTrackedQuotes(database, snapshot, quotes, new Date((config.clock?.now ?? Date.now)()).toISOString());
      response.status(200).json(single ? saved[0] : saved);
    } catch (error) {
      if (!sendDomainError(response, error, false, 'Tracking changed during the request')) next(error);
    }
  };
  app.get('/api/tracked-cryptocurrencies/:id/price', handler);
  app.get('/api/prices', handler);
}
