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
}

export interface Application {
  app: any;
  close: () => void;
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

  app.use(express.json({ limit: "16kb" }));
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
      }, body.cmcId);
      const tracked = createTrackedCryptocurrencyWithQuote(database, quote, new Date().toISOString());
      response.status(201).json(tracked);
    } catch (error: any) {
      if (error instanceof DuplicateTrackingError) {
        response.status(409).json({
          error: { code: "ALREADY_TRACKED", message: "Cryptocurrency is already tracked" },
        });
        return;
      }
      if (error instanceof CoinMarketCapError) {
        const failure = error.kind === "unknown-id"
          ? { status: 400, code: "CMC_ID_NOT_FOUND", message: "CoinMarketCap ID was not found" }
          : error.kind === "timeout"
            ? { status: 504, code: "CMC_TIMEOUT", message: "CoinMarketCap request timed out" }
            : { status: 502, code: "CMC_API_ERROR", message: "CoinMarketCap request failed" };
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
    close: () => database.close(),
  };
}
