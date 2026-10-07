const { getTrackedCryptocurrency, listTrackedCryptocurrencies, saveTrackedQuotes, StaleTrackingError } = require('./database');
const { getUsdQuotes, CoinMarketCapError } = require('./coinmarketcap');

export function registerPriceRoutes(app: any, database: any, config: any): void {
  const handler = async (request: any, response: any, next: any) => {
    if (Object.keys(request.query).length) {
      response.status(400).json({ error: { code: 'INVALID_QUERY', message: 'Query parameters are invalid' } });
      return;
    }
    const single = request.params.id !== undefined;
    if (single && (!/^[1-9]\d*$/.test(request.params.id) || !Number.isSafeInteger(Number(request.params.id)))) {
      response.status(400).json({ error: { code: 'INVALID_TRACKING_ID', message: 'Tracking ID must be a positive integer' } });
      return;
    }
    const tracked = single ? getTrackedCryptocurrency(database, Number(request.params.id)) : undefined;
    if (single && !tracked) {
      response.status(404).json({ error: { code: 'TRACKING_NOT_FOUND', message: 'Tracking record was not found' } });
      return;
    }
    try {
      const snapshot = single ? [tracked] : listTrackedCryptocurrencies(database);
      const quotes = await getUsdQuotes({ apiKey: config.coinMarketCapApiKey,
        timeoutMs: config.coinMarketCapTimeoutMs, baseUrl: config.coinMarketCapBaseUrl }, snapshot.map((item: any) => item.cmcId));
      const saved = saveTrackedQuotes(database, snapshot, quotes, new Date().toISOString());
      response.status(200).json(single ? saved[0] : saved);
    } catch (error: any) {
      if (error instanceof StaleTrackingError) {
        response.status(409).json({ error: { code: 'TRACKING_CHANGED', message: 'Tracking changed during the request' } });
      } else if (error instanceof CoinMarketCapError) {
        const timeout = error.kind === 'timeout';
        response.status(timeout ? 504 : 502).json({ error: {
          code: timeout ? 'CMC_TIMEOUT' : 'CMC_API_ERROR',
          message: timeout ? 'CoinMarketCap request timed out' : 'CoinMarketCap request failed',
        } });
      } else next(error);
    }
  };
  app.get('/api/tracked-cryptocurrencies/:id/price', handler);
  app.get('/api/prices', handler);
}
