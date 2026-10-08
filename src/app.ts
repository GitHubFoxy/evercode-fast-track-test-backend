import { coinMarketCapHttpFailure } from './provider-error';
const express: any = require("express");
const crypto: any = require("node:crypto");
const {
  openDatabase,
  listTrackedCryptocurrencies,
  isCmcIdTracked,
  getTrackedCryptocurrency,
  createTrackedCryptocurrencyWithQuote,
  getCryptocurrencyHistory,
  DuplicateTrackingError,
} = require("./database");
const { getUsdQuote, CoinMarketCapError } = require("./coinmarketcap");
const { registerTrackingMutations } = require("./tracking");

export interface ApplicationConfig {
  apiToken: string;
  databasePath: string;
  coinMarketCapApiKey: string;
  coinMarketCapTimeoutMs: number;
  coinMarketCapBaseUrl?: string;
  quota?: import('./budget').QuotaFallback;
  clock?: { now: () => number; setTimeout?: (callback: () => any, delay: number) => any; clearTimeout?: (timer: any) => void };
  syncIntervalMs?: number;
  budget?: import('./budget').ProviderBudget;
  batchSize?: number;
}

export interface Application {
  app: any;
  close: () => void | Promise<void>;
}

function matchesToken(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
}

export function createApplication(config: ApplicationConfig): Application {
  const database = openDatabase(config.databasePath);
  const app = express();
  config = { ...config, budget: new (require('./budget').ProviderBudget)(database, config.clock?.now ?? Date.now, config.quota,
    (signal: AbortSignal) => require('./coinmarketcap').transport({ apiKey: config.coinMarketCapApiKey,
      timeoutMs: config.coinMarketCapTimeoutMs, baseUrl: config.coinMarketCapBaseUrl }, '/v1/key/info', signal)) };

  const scheduler = require('./scheduler').createScheduler(database, config);
  config.budget!.onChange = scheduler.changed;
  let closed = false;
  let closing: Promise<void> | undefined;
  app.use((request: any, response: any, next: any) => {
    if (closed) { response.status(503).json({ error: { code: 'STOPPING', message: 'Service is stopping' } }); return; }
    response.on('finish', () => {
      if (!closed && ['POST', 'PUT', 'DELETE'].includes(request.method) && response.statusCode >= 200 && response.statusCode < 300) scheduler.changed();
    });
    next();
  });

  app.use("/api", (request: any, response: any, next: any) => {
    const authorization = request.get("authorization");
    const match = typeof authorization === "string"
      ? /^Bearer ([^\s]+)$/.exec(authorization)
      : null;

    if (!match || !matchesToken(match[1], config.apiToken)) {
      response.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required",
        },
      });
      return;
    }
    next();
  });

  app.use('/api', (request: any, response: any, next: any) => {
    if (['POST', 'PUT', 'DELETE'].includes(request.method) && Object.keys(request.query).length) {
      response.status(400).json({ error: { code: 'INVALID_QUERY', message: 'Query parameters are invalid' } });
      return;
    }
    if (['GET', 'HEAD', 'DELETE'].includes(request.method)
        && (Number(request.get('content-length')) > 0 || request.get('transfer-encoding') !== undefined)) {
      response.status(400).json({ error: { code: 'INVALID_BODY', message: 'Request body is not supported' } });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "16kb" }));
  require('./documentation').registerDocumentation(app);
  require('./prices').registerPriceRoutes(app, database, config);
  registerTrackingMutations(app, database, config);

  app.get("/api/tracked-cryptocurrencies", (request: any, response: any, next: any) => {
    try {
      const page = require('./query').parsePageQuery(request.query);
      response.status(200).json(listTrackedCryptocurrencies(database, page));
    } catch (error) { next(error); }
  });

  app.post("/api/tracked-cryptocurrencies", async (request: any, response: any, next: any) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).length !== 1 || !Object.hasOwn(body, "cmcId")
        || !Number.isSafeInteger(body.cmcId) || body.cmcId <= 0) {
      response.status(400).json({
        error: { code: "INVALID_CMC_ID", message: "A positive integer cmcId is required" },
      });
      return;
    }

    try {
      if (isCmcIdTracked(database, body.cmcId)) {
        response.status(409).json({
          error: { code: "ALREADY_TRACKED", message: "Cryptocurrency is already tracked" },
        });
        return;
      }

      const quote = await getUsdQuote({
        apiKey: config.coinMarketCapApiKey,
        timeoutMs: config.coinMarketCapTimeoutMs,
        baseUrl: config.coinMarketCapBaseUrl,
        budget: config.budget,
      }, body.cmcId);
      const tracked = createTrackedCryptocurrencyWithQuote(database, quote, new Date((config.clock?.now ?? Date.now)()).toISOString());
      response.status(201).json(tracked);
    } catch (error: any) {
      if (error instanceof DuplicateTrackingError) {
        response.status(409).json({
          error: { code: "ALREADY_TRACKED", message: "Cryptocurrency is already tracked" },
        });
        return;
      }
      if (error instanceof CoinMarketCapError) {
        const failure = coinMarketCapHttpFailure(error.kind, true);
        response.status(failure.status).json({
          error: { code: failure.code, message: failure.message },
        });
        return;
      }
      next(error);
    }
  });

  app.get("/api/tracked-cryptocurrencies/:id", (request: any, response: any) => {
    if (Object.keys(request.query).length) {
      response.status(400).json({ error: { code: "INVALID_QUERY", message: "Query parameters are invalid" } });
      return;
    }
    if (!/^[1-9]\d*$/.test(request.params.id) || !Number.isSafeInteger(Number(request.params.id))) {
      response.status(400).json({
        error: { code: "INVALID_TRACKING_ID", message: "Tracking ID must be a positive integer" },
      });
      return;
    }
    const tracked = getTrackedCryptocurrency(database, Number(request.params.id));
    if (!tracked) {
      response.status(404).json({
        error: { code: "TRACKING_NOT_FOUND", message: "Tracking record was not found" },
      });
      return;
    }
    response.status(200).json(tracked);
  });

  app.get("/api/cryptocurrencies/:cmcId/history", (request: any, response: any) => {
    if (!/^[1-9]\d*$/.test(request.params.cmcId) || !Number.isSafeInteger(Number(request.params.cmcId))) {
      response.status(400).json({
        error: { code: "INVALID_CMC_ID", message: "CMC ID must be a positive integer" },
      });
      return;
    }
    const page = require('./query').parsePageQuery(request.query, true);
    const history = getCryptocurrencyHistory(database, Number(request.params.cmcId), page);
    if (!history) {
      response.status(404).json({
        error: { code: "CRYPTOCURRENCY_NOT_FOUND", message: "Cryptocurrency was not found" },
      });
      return;
    }
    response.status(200).json(history);
  });

  app.use((_request: any, response: any) => {
    response.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "Resource not found",
      },
    });
  });

  app.use((error: any, _request: any, response: any, _next: any) => {
    if (error instanceof require('./query').InvalidQueryError) {
      response.status(400).json({ error: { code: 'INVALID_QUERY', message: 'Query parameters are invalid' } });
      return;
    }
    if (error.type === 'entity.too.large') {
      response.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'JSON body exceeds 16 KiB' } });
      return;
    }
    const isInvalidJson = error instanceof SyntaxError && "body" in error;
    if (isInvalidJson) {
      response.status(400).json({
        error: {
          code: "INVALID_JSON",
          message: "Request body must contain valid JSON",
        },
      });
      return;
    }
    response.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error occurred",
      },
    });
  });

  return {
    app,
    close: () => {
      if (closed) return closing;
      closed = true; scheduler.stop();
      const busy = config.budget!.busy;
      const drained = config.budget!.stop();
      if (!busy) { database.close(); return; }
      closing = drained.then(() => { database.close(); });
      return closing;
    },
  };
}
