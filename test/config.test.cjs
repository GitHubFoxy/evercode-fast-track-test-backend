const { loadConfig } = require("../dist/config.js");

const validEnvironment = {
  API_TOKEN: "a-fake-test-token-with-sufficient-length",
  COINMARKETCAP_API_KEY: "fake-cmc-test-key",
  PORT: "3000",
  DATABASE_PATH: "./data/service.sqlite",
  PRICE_CURRENCY: "USD",
  CMC_TIMEOUT_MS: "10000",
  SYNC_INTERVAL_MS: "60000",
};

describe("service configuration", () => {
  test("parses valid environment values without conflating the two API keys", () => {
    const config = loadConfig(validEnvironment);

    expect(config.apiToken).toBe(validEnvironment.API_TOKEN);
    expect(config.coinMarketCapApiKey).toBe(validEnvironment.COINMARKETCAP_API_KEY);
    expect(config.port).toBe(3000);
    expect(config.databasePath).toBe("./data/service.sqlite");
  });

  test('parses verified bootstrap quota and rejects unsafe runtime values', () => {
    const env = { ...validEnvironment, CMC_MONTHLY_LIMIT: '100', CMC_CREDITS_LEFT: '90',
      CMC_RESET_AT: '2099-02-01T00:00:00Z', CMC_RATE_LIMIT_MINUTE: '10', CMC_REQUESTS_LEFT: '8',
      CMC_KEY_INFO_CREDITS: '1', CMC_BATCH_SIZE: '50', SHUTDOWN_TIMEOUT_MS: '500', CMC_BASE_URL: 'http://127.0.0.1:1234' };
    expect(loadConfig(env)).toMatchObject({ quota: { monthlyLimit: 100, creditsLeft: 90, resetAt: env.CMC_RESET_AT,
      minuteLimit: 10, requestsLeft: 8, keyInfoCredits: 1 }, batchSize: 50, shutdownTimeoutMs: 500,
      coinMarketCapBaseUrl: env.CMC_BASE_URL });
    for (const extra of [{ CMC_CREDITS_LEFT: '101' }, { CMC_REQUESTS_LEFT: '11' }, { CMC_RESET_AT: 'bad' },
      { CMC_KEY_INFO_CREDITS: '-1' }, { CMC_BATCH_SIZE: '0' }, { SHUTDOWN_TIMEOUT_MS: '0' }, { CMC_BASE_URL: 'http://example.org' }]) {
      expect(() => loadConfig({ ...env, ...extra })).toThrow();
    }
  });
  test('an expired bootstrap timestamp remains parseable for restart with persisted quota', () => {
    expect(loadConfig({ ...validEnvironment, CMC_RESET_AT: '2020-01-01T00:00:00Z' }).quota.resetAt).toBe('2020-01-01T00:00:00Z');
  });
  test("rejects missing credentials and invalid numeric values", () => {
    expect(() => loadConfig({ ...validEnvironment, API_TOKEN: "" })).toThrow(
      "API_TOKEN is required",
    );
    expect(() => loadConfig({ ...validEnvironment, PORT: "3000oops" })).toThrow(
      "PORT must be an integer between 1 and 65535",
    );
    expect(() => loadConfig({ ...validEnvironment, DATABASE_PATH: ":memory:" })).toThrow(
      "DATABASE_PATH must point to a SQLite file on disk",
    );
  });
});
