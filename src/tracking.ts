const {
  getTrackingSnapshot,
  isCmcIdTracked,
  TrackingChangedError,
  replaceTrackedCryptocurrencyWithQuote,
  deleteTrackedCryptocurrency,
  DuplicateTrackingError,
} = require("./database");
const { getUsdQuote, CoinMarketCapError } = require("./coinmarketcap");
import type { ApplicationConfig } from "./app";

export function registerTrackingMutations(app: any, database: any, config: ApplicationConfig): void {
  const validateTrackingId = (request: any, response: any, next: any) => {
    if (!/^[1-9]\d*$/.test(request.params.id) || !Number.isSafeInteger(Number(request.params.id))) {
      response.status(400).json({ error: { code: "INVALID_TRACKING_ID", message: "Tracking ID must be a positive integer" } });
      return;
    }
    next();
  };
  app.delete("/api/tracked-cryptocurrencies/:id", validateTrackingId, (request: any, response: any) => {
    if (!deleteTrackedCryptocurrency(database, Number(request.params.id))) {
      response.status(404).json({ error: { code: "TRACKING_NOT_FOUND", message: "Tracking record was not found" } });
      return;
    }
    response.status(204).end();
  });
  app.put("/api/tracked-cryptocurrencies/:id", validateTrackingId, async (request: any, response: any, next: any) => {
    const body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).length !== 1 || !Object.hasOwn(body, "cmcId")
        || !Number.isSafeInteger(body.cmcId) || body.cmcId <= 0) {
      response.status(400).json({ error: { code: "INVALID_CMC_ID", message: "A positive integer cmcId is required" } });
      return;
    }
    try {
      const id = Number(request.params.id);
      const snapshot = getTrackingSnapshot(database, id);
      if (!snapshot) {
        response.status(404).json({ error: { code: "TRACKING_NOT_FOUND", message: "Tracking record was not found" } });
        return;
      }
      if (snapshot.cmcId !== body.cmcId && isCmcIdTracked(database, body.cmcId)) {
        throw new DuplicateTrackingError();
      }
      const quote = await getUsdQuote({
        apiKey: config.coinMarketCapApiKey,
        timeoutMs: config.coinMarketCapTimeoutMs,
        baseUrl: config.coinMarketCapBaseUrl,
      }, request.body.cmcId);
      response.status(200).json(replaceTrackedCryptocurrencyWithQuote(database, snapshot, quote, new Date().toISOString()));
    } catch (error: any) {
      if (error instanceof TrackingChangedError) {
        response.status(409).json({ error: { code: "TRACKING_CHANGED", message: "Tracking record changed while the request was in progress" } });
        return;
      }
      if (error instanceof DuplicateTrackingError) {
        response.status(409).json({ error: { code: "ALREADY_TRACKED", message: "Cryptocurrency is already tracked" } });
        return;
      }
      if (error instanceof CoinMarketCapError) {
        const failure = error.kind === "unknown-id"
          ? { status: 400, code: "CMC_ID_NOT_FOUND", message: "CoinMarketCap ID was not found" }
          : error.kind === "timeout"
            ? { status: 504, code: "CMC_TIMEOUT", message: "CoinMarketCap request timed out" }
            : { status: 502, code: "CMC_API_ERROR", message: "CoinMarketCap request failed" };
        response.status(failure.status).json({ error: { code: failure.code, message: failure.message } });
        return;
      }
      next(error);
    }
  });
}
