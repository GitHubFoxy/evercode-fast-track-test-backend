import crypto from 'node:crypto';
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import {
  openDatabase,
  listTrackedCryptocurrencies,
  isCmcIdTracked,
  getTrackedCryptocurrency,
  createTrackedCryptocurrencyWithQuote,
  getCryptocurrencyHistory,
} from './database';
import { ProviderBudget } from './budget';
import type { QuotaFallback } from './budget';
import { getUsdQuote, transport } from './coinmarketcap';
import { registerDocumentation } from './documentation';
import { sendDomainError, sendError } from './error-response';
import { InvalidQueryError, parsePageQuery } from './query';
import { registerPriceRoutes } from './prices';
import { createScheduler } from './scheduler';
import { isPositiveIntegerPath, parseCmcIdBody, registerTrackingMutations } from './tracking';

export interface ClockConfig {
  now: () => number;
  setTimeout?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearTimeout?: (timer: NodeJS.Timeout) => void;
}

export interface ApplicationConfig {
  apiToken: string;
  databasePath: string;
  coinMarketCapApiKey: string;
  coinMarketCapTimeoutMs: number;
  coinMarketCapBaseUrl?: string;
  quota?: QuotaFallback;
  clock?: ClockConfig;
  syncIntervalMs?: number;
  budget?: ProviderBudget;
  batchSize?: number;
}

export interface Application {
  app: Express;
  close: () => void | Promise<void>;
}

const MUTATING_METHODS = ['POST', 'PUT', 'DELETE'];

function matchesToken(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

export function createApplication(input: ApplicationConfig): Application {
  const database = openDatabase(input.databasePath);
  const app = express();
  const budget = new ProviderBudget(database, input.clock?.now ?? Date.now, input.quota,
    signal => transport({ apiKey: input.coinMarketCapApiKey, timeoutMs: input.coinMarketCapTimeoutMs,
      baseUrl: input.coinMarketCapBaseUrl }, '/v1/key/info', signal));
  const config: ApplicationConfig = { ...input, budget };
  const now = config.clock?.now ?? Date.now;

  const scheduler = createScheduler(database, config);
  budget.onChange = scheduler.changed;
  let closed = false;
  let closing: Promise<void> | undefined;
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (closed) { sendError(response, 503, 'STOPPING', 'Service is stopping'); return; }
    response.on('finish', () => {
      if (!closed && MUTATING_METHODS.includes(request.method) && response.statusCode >= 200 && response.statusCode < 300) scheduler.changed();
    });
    next();
  });

  app.use('/api', (request: Request, response: Response, next: NextFunction) => {
    const authorization = request.get('authorization');
    const match = typeof authorization === 'string' ? /^bearer +([^\s]+) *$/i.exec(authorization) : null;
    if (!match || !matchesToken(match[1], config.apiToken)) {
      response.set('WWW-Authenticate', 'Bearer');
      sendError(response, 401, 'UNAUTHORIZED', 'Authentication required');
      return;
    }
    next();
  });

  app.use('/api', (request: Request, response: Response, next: NextFunction) => {
    if (MUTATING_METHODS.includes(request.method) && Object.keys(request.query).length) {
      sendError(response, 400, 'INVALID_QUERY', 'Query parameters are invalid');
      return;
    }
    if (['GET', 'HEAD', 'DELETE'].includes(request.method)
        && (Number(request.get('content-length')) > 0 || request.get('transfer-encoding') !== undefined)) {
      sendError(response, 400, 'INVALID_BODY', 'Request body is not supported');
      return;
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  registerDocumentation(app);
  registerPriceRoutes(app, database, config);
  registerTrackingMutations(app, database, config);

  app.get('/api/tracked-cryptocurrencies', (request: Request, response: Response, next: NextFunction) => {
    try {
      response.status(200).json(listTrackedCryptocurrencies(database, parsePageQuery(request.query)));
    } catch (error) { next(error); }
  });

  app.post('/api/tracked-cryptocurrencies', async (request: Request, response: Response, next: NextFunction) => {
    const cmcId = parseCmcIdBody(request.body);
    if (cmcId === undefined) {
      sendError(response, 400, 'INVALID_CMC_ID', 'A positive integer cmcId is required');
      return;
    }
    try {
      if (isCmcIdTracked(database, cmcId)) {
        sendError(response, 409, 'ALREADY_TRACKED', 'Cryptocurrency is already tracked');
        return;
      }
      const quote = await getUsdQuote({
        apiKey: config.coinMarketCapApiKey,
        timeoutMs: config.coinMarketCapTimeoutMs,
        baseUrl: config.coinMarketCapBaseUrl,
        budget: config.budget,
      }, cmcId);
      response.status(201).json(createTrackedCryptocurrencyWithQuote(database, quote, new Date(now()).toISOString()));
    } catch (error) {
      if (!sendDomainError(response, error, true, 'Tracking record changed while the request was in progress')) next(error);
    }
  });

  app.get('/api/tracked-cryptocurrencies/:id', (request: Request, response: Response) => {
    if (Object.keys(request.query).length) {
      sendError(response, 400, 'INVALID_QUERY', 'Query parameters are invalid');
      return;
    }
    if (!isPositiveIntegerPath(request.params.id as string)) {
      sendError(response, 400, 'INVALID_TRACKING_ID', 'Tracking ID must be a positive integer');
      return;
    }
    const tracked = getTrackedCryptocurrency(database, Number(request.params.id));
    if (!tracked) {
      sendError(response, 404, 'TRACKING_NOT_FOUND', 'Tracking record was not found');
      return;
    }
    response.status(200).json(tracked);
  });

  app.get('/api/cryptocurrencies/:cmcId/history', (request: Request, response: Response, next: NextFunction) => {
    if (!isPositiveIntegerPath(request.params.cmcId as string)) {
      sendError(response, 400, 'INVALID_CMC_ID', 'CMC ID must be a positive integer');
      return;
    }
    try {
      const history = getCryptocurrencyHistory(database, Number(request.params.cmcId), parsePageQuery(request.query, true));
      if (!history) {
        sendError(response, 404, 'CRYPTOCURRENCY_NOT_FOUND', 'Cryptocurrency was not found');
        return;
      }
      response.status(200).json(history);
    } catch (error) { next(error); }
  });

  app.use((_request: Request, response: Response) => {
    sendError(response, 404, 'NOT_FOUND', 'Resource not found');
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const requestError = error instanceof Error ? error as Error & { type?: unknown; status?: unknown } : undefined;
    if (error instanceof InvalidQueryError) {
      sendError(response, 400, 'INVALID_QUERY', 'Query parameters are invalid');
    } else if (requestError?.type === 'entity.too.large' && requestError.status === 413) {
      sendError(response, 413, 'PAYLOAD_TOO_LARGE', 'JSON body exceeds 16 KiB');
    } else if (requestError?.type === 'encoding.unsupported' && requestError.status === 415) {
      sendError(response, 415, 'UNSUPPORTED_ENCODING', 'Request body encoding is not supported');
    } else if (requestError?.type === 'charset.unsupported' && requestError.status === 415) {
      sendError(response, 415, 'UNSUPPORTED_CHARSET', 'JSON body charset is not supported');
    } else if (error instanceof URIError && requestError?.status === 400
        && error.message.startsWith('Failed to decode param \'')) {
      sendError(response, 400, 'INVALID_PATH', 'Path parameter encoding is invalid');
    } else if (error instanceof SyntaxError && requestError?.type === 'entity.parse.failed'
        && requestError.status === 400 && 'body' in error) {
      sendError(response, 400, 'INVALID_JSON', 'Request body must contain valid JSON');
    } else if (requestError?.status === 400
        && (requestError.type === 'request.aborted' || requestError.type === 'request.size.invalid')) {
      sendError(response, 400, 'INVALID_BODY', 'Request body is invalid');
    } else {
      sendError(response, 500, 'INTERNAL_ERROR', 'An internal error occurred');
    }
  });

  return {
    app,
    close: () => {
      if (closed) return closing;
      closed = true; scheduler.stop();
      const busy = budget.busy;
      const drained = budget.stop();
      if (!busy) { database.close(); return; }
      closing = drained.then(() => { database.close(); });
      return closing;
    },
  };
}
