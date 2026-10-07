const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const request = require("supertest");
const { createApplication } = require("../dist/app.js");

const API_TOKEN = "test-api-token";
const CMC_API_KEY = "fake-cmc-test-key";
const providerUpdatedAt = "2025-02-03T04:06:00.000Z";

function successfulQuote(cmcId = 1) {
  return {
    data: [{
      id: cmcId,
      name: "Bitcoin",
      symbol: "BTC",
      last_updated: "2025-02-03T04:05:06.000Z",
      quote: [{ id: 2781, symbol: "USD", price: 97234.5, last_updated: providerUpdatedAt }],
    }],
    status: {
      timestamp: "2025-02-03T04:06:01.000Z",
      error_code: 0,
      error_message: null,
      elapsed: 12,
      credit_count: 1,
    },
  };
}

describe("tracked cryptocurrency API", () => {
  let directory;
  let application;
  let cmcServer;
  let cmcBaseUrl;
  let cmcResponse;
  let cmcStatus;
  let cmcDelayMs;
  let cmcRequests;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "evercode-create-"));
    cmcResponse = successfulQuote();
    cmcStatus = 200;
    cmcDelayMs = 0;
    cmcRequests = [];
    cmcServer = http.createServer((incoming, outgoing) => {
      cmcRequests.push({
        method: incoming.method,
        url: incoming.url,
        apiKey: incoming.headers["x-cmc_pro_api_key"],
      });
      setTimeout(() => {
        outgoing.writeHead(cmcStatus, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(cmcResponse));
      }, cmcDelayMs);
    });
    await new Promise((resolve) => cmcServer.listen(0, "127.0.0.1", resolve));
    cmcBaseUrl = `http://127.0.0.1:${cmcServer.address().port}`;
    application = createApplication({
      apiToken: API_TOKEN,
      databasePath: path.join(directory, "service.sqlite"),
      coinMarketCapApiKey: CMC_API_KEY,
      coinMarketCapTimeoutMs: 100,
      coinMarketCapBaseUrl: cmcBaseUrl,
    });
  });

  afterEach(async () => {
    application.close();
    await new Promise((resolve) => cmcServer.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("adds a cryptocurrency by CMC ID using its official USD quote", async () => {
    const response = await request(application.app)
      .post("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ cmcId: 1 });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      id: 1,
      cmcId: 1,
      symbol: "BTC",
      name: "Bitcoin",
    });
    expect(new Date(response.body.lastUpdatedAt).toISOString()).toBe(response.body.lastUpdatedAt);
    expect(cmcRequests).toEqual([{
      method: "GET",
      url: "/v3/cryptocurrency/quotes/latest?id=1&convert=USD",
      apiKey: CMC_API_KEY,
    }]);
  });

  test("rejects an impossible provider timestamp without creating a tracking record", async () => {
    cmcResponse = successfulQuote();
    cmcResponse.data[0].quote[0].last_updated = "2025-02-31T04:06:00.000Z";

    const response = await request(application.app)
      .post("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ cmcId: 1 });
    const list = await request(application.app)
      .get("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`);

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("CMC_API_ERROR");
    expect(list.body).toEqual([]);
  });

  test("lists and reads the created tracking record", async () => {
    const created = await request(application.app)
      .post("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ cmcId: 1 });

    const list = await request(application.app)
      .get("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`);
    const retrieved = await request(application.app)
      .get(`/api/tracked-cryptocurrencies/${created.body.id}`)
      .set("Authorization", `Bearer ${API_TOKEN}`);

    expect(list.status).toBe(200);
    expect(list.body).toEqual([created.body]);
    expect(retrieved.status).toBe(200);
    expect(retrieved.body).toEqual(created.body);
  });

  test("distinguishes invalid identifiers from missing local records", async () => {
    const invalidTrackingId = await request(application.app)
      .get("/api/tracked-cryptocurrencies/not-an-id")
      .set("Authorization", `Bearer ${API_TOKEN}`);
    const missingTrackingId = await request(application.app)
      .get("/api/tracked-cryptocurrencies/999")
      .set("Authorization", `Bearer ${API_TOKEN}`);
    const invalidHistoryId = await request(application.app)
      .get("/api/cryptocurrencies/0/history")
      .set("Authorization", `Bearer ${API_TOKEN}`);
    const missingHistoryId = await request(application.app)
      .get("/api/cryptocurrencies/999/history")
      .set("Authorization", `Bearer ${API_TOKEN}`);

    expect(invalidTrackingId.status).toBe(400);
    expect(missingTrackingId.status).toBe(404);
    expect(invalidHistoryId.status).toBe(400);
    expect(missingHistoryId.status).toBe(404);
  });

  test("reads the saved USD quote and its provider and fetch timestamps", async () => {
    await request(application.app)
      .post("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ cmcId: 1 });

    const response = await request(application.app)
      .get("/api/cryptocurrencies/1/history")
      .set("Authorization", `Bearer ${API_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      cmcId: 1,
      symbol: "BTC",
      name: "Bitcoin",
      price: 97234.5,
      currency: "USD",
      providerUpdatedAt,
    });
    expect(new Date(response.body[0].fetchedAt).toISOString()).toBe(response.body[0].fetchedAt);
  });

  test("rejects a duplicate tracking entry without making another provider request", async () => {
    const create = () => request(application.app)
      .post("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ cmcId: 1 });

    expect((await create()).status).toBe(201);
    const duplicate = await create();

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("ALREADY_TRACKED");
    expect(cmcRequests).toHaveLength(1);
  });

  test("keeps concurrent duplicate POST requests to one record and one initial quote", async () => {
    const create = () => request(application.app)
      .post("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ cmcId: 1 });

    const responses = await Promise.all([create(), create()]);
    const list = await request(application.app)
      .get("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`);
    const history = await request(application.app)
      .get("/api/cryptocurrencies/1/history")
      .set("Authorization", `Bearer ${API_TOKEN}`);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(list.body).toHaveLength(1);
    expect(history.body).toHaveLength(1);
  });

  test.each([
    ["fractional ID", { cmcId: 1.5 }],
    ["zero ID", { cmcId: 0 }],
    ["negative ID", { cmcId: -1 }],
    ["string ID", { cmcId: "1" }],
    ["extra fields", { cmcId: 1, name: "Bitcoin" }],
    ["alternate field name", { cmc_id: 1 }],
  ])("rejects POST with %s without contacting CoinMarketCap", async (_case, body) => {
    const response = await request(application.app)
      .post("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send(body);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_CMC_ID");
    expect(cmcRequests).toHaveLength(0);
  });

  test("returns a safe not-found error for an unknown CoinMarketCap ID", async () => {
    cmcResponse = { data: [], status: { error_code: 0, error_message: null } };

    const response = await request(application.app)
      .post("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ cmcId: 999999 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("CMC_ID_NOT_FOUND");
    expect(JSON.stringify(response.body)).not.toContain(CMC_API_KEY);
    expect(await request(application.app)
      .get("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`)).toHaveProperty("body", []);
  });

  test("hides CoinMarketCap response details when the provider fails", async () => {
    cmcStatus = 503;
    cmcResponse = { error_message: "fake provider detail and credential: fake-cmc-test-key" };

    const response = await request(application.app)
      .post("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ cmcId: 1 });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("CMC_API_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("fake provider detail");
    expect(JSON.stringify(response.body)).not.toContain(CMC_API_KEY);
  });

  test("returns a timeout error without storing a partial tracking record", async () => {
    cmcDelayMs = 300;

    const response = await request(application.app)
      .post("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ cmcId: 1 });

    expect(response.status).toBe(504);
    expect(response.body.error.code).toBe("CMC_TIMEOUT");
    expect(JSON.stringify(response.body)).not.toContain(CMC_API_KEY);
    expect(await request(application.app)
      .get("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`)).toHaveProperty("body", []);
  });

  test("returns a safe provider error when the external server is unavailable", async () => {
    await new Promise((resolve) => cmcServer.close(resolve));

    const response = await request(application.app)
      .post("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`)
      .send({ cmcId: 1 });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("CMC_API_ERROR");
    expect(JSON.stringify(response.body)).not.toContain(CMC_API_KEY);
  });
});
