const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const request = require("supertest");
const { createApplication } = require("../dist/app.js");

const API_TOKEN = "test-api-token";

describe("GET /api/tracked-cryptocurrencies", () => {
  let directory;
  let application;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "evercode-foundation-"));
    application = createApplication({
      apiToken: API_TOKEN,
      databasePath: path.join(directory, "service.sqlite"),
    });
  });

  afterEach(() => {
    application.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("returns the empty list from a disk-backed database for an authorized client", async () => {
    const response = await request(application.app)
      .get("/api/tracked-cryptocurrencies")
      .set("Authorization", `Bearer ${API_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(fs.existsSync(path.join(directory, "service.sqlite"))).toBe(true);
  });

  test.each([
    ["missing", undefined],
    ["wrong", "Bearer wrong-token"],
    ["malformed", `Basic ${API_TOKEN}`],
  ])("rejects a %s authorization header", async (_case, authorization) => {
    let call = request(application.app).get("/api/tracked-cryptocurrencies");
    if (authorization !== undefined) call = call.set("Authorization", authorization);

    const response = await call;

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
    expect(JSON.stringify(response.body)).not.toContain(API_TOKEN);
  });
});
