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
