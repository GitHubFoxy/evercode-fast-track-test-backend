const { loadConfig } = require("../dist/config.js");
const { createApplication } = require("../dist/app.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const request = require("supertest");

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

  test.each(['fake-shared-secret', '  fake-shared-secret  '])('rejects equal normalized API keys without exposing values (%s)', token => {
    const environment = { ...validEnvironment, API_TOKEN: token, COINMARKETCAP_API_KEY: 'fake-shared-secret' };
    expect(() => loadConfig(environment)).toThrow('API_TOKEN and COINMARKETCAP_API_KEY must differ');
    try { loadConfig(environment); }
    catch (error) {
      expect(error.name).toBe('ConfigurationError');
      expect(error.message).not.toContain('fake-shared-secret');
    }
  });
  test.each([
    '  azAZ09-._~+/  ',
    'fake-token==',
    'header.payload.signature',
  ])('accepts and authenticates valid normalized Bearer token (%s)', async token => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evercode-config-token-'));
    let application;
    try {
      const config = loadConfig({ ...validEnvironment, API_TOKEN: token,
        DATABASE_PATH: path.join(directory, 'service.sqlite') });
      expect(config.apiToken).toBe(token.trim());
      application = createApplication(config);
      const response = await request(application.app).get('/api/tracked-cryptocurrencies')
        .set('Authorization', `Bearer ${config.apiToken}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    } finally {
      await application?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  test.each([
    ['space', 'first second'],
    ['tab', 'first\tsecond'],
    ['line break', 'first\nsecond'],
    ['carriage return', 'first\rsecond'],
    ['NUL', 'secret\u0000'],
    ['control character', 'secret\u007f'],
    ['non-ASCII', 'секрет'],
    ['non-ASCII whitespace', 'first\u00a0second'],
    ['invalid punctuation', 'secret:value'],
    ['leading padding', '=secret'],
    ['embedded padding', 'sec=ret'],
    ['padding only', '==='],
  ])('rejects %s in API_TOKEN without exposing the secret', (_case, token) => {
    let failure;
    try { loadConfig({ ...validEnvironment, API_TOKEN: token }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ name: 'ConfigurationError',
      message: 'API_TOKEN must use the Bearer token format' });
    expect(failure.message).not.toContain(token);
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
