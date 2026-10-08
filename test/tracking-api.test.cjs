const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const request = require("supertest");
const { createApplication } = require("../dist/app.js");

function quote(cmcId, price = cmcId === 1 ? 97000 : 3500) {
  return {
    data: [{ id: cmcId, symbol: cmcId === 1 ? "BTC" : "ETH",
      name: cmcId === 1 ? "Bitcoin" : "Ethereum", last_updated: "2025-02-03T04:05:00.000Z",
      quote: [{ symbol: "USD", price, last_updated: "2025-02-03T04:05:00.000Z" }] }],
    status: { error_code: 0, credit_count: 1 },
  };
}

describe("tracking replacement and removal", () => {
  let directory, application, server, handler, baseUrl;
  const api = (method, route) => request(application.app)[method](route).set("Authorization", "Bearer test-token");
  const tracked = (method, id) => api(method, `/api/tracked-cryptocurrencies${id === undefined ? "" : `/${id}`}`);
  const add = (cmcId) => tracked("post").send({ cmcId });
  const history = async (cmcId) => (await api("get", `/api/cryptocurrencies/${cmcId}/history`)).body;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "evercode-tracking-"));
    handler = (incoming, outgoing) => {
      const id = Number(new URL(incoming.url, "http://localhost").searchParams.get("id"));
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(quote(id)));
    };
    server = http.createServer((incoming, outgoing) => handler(incoming, outgoing));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    application = createApplication({ quota: require('./fake-quota.cjs'), apiToken: "test-token", databasePath: path.join(directory, "service.sqlite"),
      coinMarketCapApiKey: "fake-key", coinMarketCapTimeoutMs: 1000, coinMarketCapBaseUrl: baseUrl });
  });
  afterEach(async () => {
    application.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("PUT replaces BTC with provider-sourced ETH while keeping each coin's history separate", async () => {
    const btc = (await add(1)).body;
    const before = await history(1);
    const replaced = await tracked("put", btc.id).send({ cmcId: 1027 });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ id: btc.id, cmcId: 1027, symbol: "ETH", name: "Ethereum" });
    expect((await tracked("get", btc.id)).body).toEqual(replaced.body);
    expect(await history(1)).toEqual(before);
    expect(await history(1027)).toEqual([expect.objectContaining({ cmcId: 1027, price: 3500, currency: "USD" })]);
    expect(replaced.body).not.toHaveProperty("enabled");
  });

  test("DELETE preserves history and re-adding continues it with a new tracking ID, including after restart", async () => {
    const btc = (await add(1)).body;
    const before = await history(1);
    expect((await tracked("delete", btc.id)).status).toBe(204);
    expect((await tracked("get", btc.id)).status).toBe(404);
    expect(await history(1)).toEqual(before);
    application.close();
    application = createApplication({ quota: require('./fake-quota.cjs'), apiToken: "test-token", databasePath: path.join(directory, "service.sqlite"),
      coinMarketCapApiKey: "fake-key", coinMarketCapTimeoutMs: 1000, coinMarketCapBaseUrl: baseUrl });
    const readded = await add(1);
    expect(readded.status).toBe(201);
    expect(readded.body.id).toBeGreaterThan(btc.id);
    const continued = await history(1);
    expect(continued).toHaveLength(2);
    expect(continued[0]).toEqual(before[0]);
    expect(readded.body).not.toHaveProperty("enabled");
  });
  test.each([
    ['application/json', '{"price":999,"enabled":true}', false],
    ['application/json', '{}', false],
    ['application/json', '{', false],
    ['text/plain', 'price=999', false],
    ['application/octet-stream', 'price=999', false],
    ['application/x-www-form-urlencoded', 'price=999&enabled=true', false],
    [undefined, 'price=999', false],
    ['text/plain', 'price=999', true],
  ])('DELETE rejects any body (%s, %s, chunked=%s) without data loss or provider access', async (contentType, body, chunked) => {
    const btc = (await add(1)).body;
    const before = await history(1);
    let calls = 0;
    handler = (_incoming, outgoing) => { calls++; outgoing.end(JSON.stringify(quote(1))); };
    let result;
    if (chunked) {
      const listener = application.app.listen(0, '127.0.0.1');
      await new Promise(resolve => listener.once('listening', resolve));
      try {
        result = await new Promise((resolve, reject) => {
          const call = http.request({ host: '127.0.0.1', port: listener.address().port, method: 'DELETE',
            path: `/api/tracked-cryptocurrencies/${btc.id}`, headers: {
              Authorization: 'Bearer test-token', 'Content-Type': contentType, 'Transfer-Encoding': 'chunked'
            } }, response => {
            let data = ''; response.on('data', chunk => { data += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: data ? JSON.parse(data) : {} }));
          });
          call.on('error', reject); call.write(body); call.end();
        });
      } finally { await new Promise(resolve => listener.close(resolve)); }
    } else {
      let call = tracked('delete', btc.id).send(body);
      if (contentType) call = call.set('Content-Type', contentType);
      else call = call.unset('Content-Type');
      result = await call;
    }
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: { code: 'INVALID_BODY', message: 'Request body is not supported' } });
    expect((await tracked('get', btc.id)).body).toEqual(btc);
    expect(await history(1)).toEqual(before);
    expect(calls).toBe(0);
    expect((await tracked('delete', btc.id)).status).toBe(204);
    expect(await history(1)).toEqual(before);
  });
  test.each(['get', 'head'])('%s data routes reject bodies before quotes are requested', async method => {
    const btc = (await add(1)).body;
    const before = await history(1);
    let calls = 0;
    handler = (_incoming, outgoing) => { calls++; outgoing.end(JSON.stringify(quote(1))); };
    for (const route of ['/api/tracked-cryptocurrencies', `/api/tracked-cryptocurrencies/${btc.id}`,
      `/api/tracked-cryptocurrencies/${btc.id}/price`, '/api/prices', '/api/cryptocurrencies/1/history']) {
      const result = await api(method, route).set('Content-Type', 'text/plain').set('Content-Length', '9').send('price=999');
      expect(result.status).toBe(400);
      if (method === 'get') expect(result.body.error.code).toBe('INVALID_BODY');
    }
    expect(calls).toBe(0);
    expect(await history(1)).toEqual(before);
  });
  test("PUT rejects an already tracked coin and leaves both histories and records unchanged", async () => {
    const btc = (await add(1)).body;
    const eth = (await add(1027)).body;
    const btcHistory = await history(1);
    const ethHistory = await history(1027);
    const result = await tracked("put", btc.id).send({ cmcId: 1027 });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("ALREADY_TRACKED");
    expect((await tracked("get", btc.id)).body).toEqual(btc);
    expect((await tracked("get", eth.id)).body).toEqual(eth);
    expect(await history(1)).toEqual(btcHistory);
    expect(await history(1027)).toEqual(ethHistory);
  });
  test("unknown tracking records cannot be replaced or deleted and do not contact the provider", async () => {
    handler = () => { throw new Error("Provider must not be contacted"); };
    const put = await tracked("put", 999).send({ cmcId: 1 });
    const remove = await tracked("delete", 999);
    expect(put.status).toBe(404);
    expect(put.body.error.code).toBe("TRACKING_NOT_FOUND");
    expect(remove.status).toBe(404);
    expect(remove.body.error.code).toBe("TRACKING_NOT_FOUND");
    expect((await tracked("get")).body).toEqual([]);
    expect((await api("get", "/api/cryptocurrencies/1/history")).status).toBe(404);
  });
  test("invalid mutation input is rejected before provider access and preserves the record", async () => {
    const btc = (await add(1)).body;
    const before = await history(1);
    let calls = 0;
    handler = (_incoming, outgoing) => { calls++; outgoing.end(JSON.stringify(quote(1))); };
    for (const body of [{ cmcId: 0 }, { cmcId: -1 }, { cmcId: 1.5 }, { cmcId: "1" },
      { cmcId: 9007199254740992 }, { cmcId: 1, enabled: true }, { cmcId: 1, price: 4 }, {}, []]) {
      expect((await tracked("put", btc.id).send(body)).status).toBe(400);
    }
    for (const id of ["0", "-1", "1.2", "1foo", "9007199254740992"]) {
      expect((await tracked("put", id).send({ cmcId: 1 })).status).toBe(400);
      expect((await tracked("delete", id)).status).toBe(400);
    }
    expect(calls).toBe(0);
    expect((await tracked("get", btc.id)).body).toEqual(btc);
    expect(await history(1)).toEqual(before);
  });
  test("an old PUT cannot append a quote after BTC is replaced by ETH and then BTC again", async () => {
    const btc = (await add(1)).body;
    const normal = handler;
    let release;
    const arrived = new Promise(resolve => {
      handler = (_incoming, outgoing) => {
        handler = normal;
        release = () => outgoing.end(JSON.stringify(quote(1, 123)));
        resolve();
      };
    });
    const pending = tracked("put", btc.id).send({ cmcId: 1 }).then(response => response);
    await arrived;
    expect((await tracked("put", btc.id).send({ cmcId: 1027 })).status).toBe(200);
    expect((await tracked("put", btc.id).send({ cmcId: 1 })).status).toBe(200);
    const before = await history(1);
    const current = (await tracked("get", btc.id)).body;
    release();
    const stale = await pending;
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("TRACKING_CHANGED");
    expect(await history(1)).toEqual(before);
    expect((await tracked("get", btc.id)).body).toEqual(current);
  });
  test("PUT rejects a known duplicate without spending a provider request", async () => {
    const btc = (await add(1)).body;
    await add(1027);
    let calls = 0;
    handler = (_incoming, outgoing) => { calls++; outgoing.end(JSON.stringify(quote(1027))); };
    expect((await tracked("put", btc.id).send({ cmcId: 1027 })).status).toBe(409);
    expect(calls).toBe(0);
  });
  test("a delayed PUT cannot restore deleted tracking or append history after re-addition", async () => {
    const btc = (await add(1)).body;
    const normal = handler;
    let release;
    const arrived = new Promise(resolve => {
      handler = (_incoming, outgoing) => {
        handler = normal;
        release = () => outgoing.end(JSON.stringify(quote(1027)));
        resolve();
      };
    });
    const pending = tracked("put", btc.id).send({ cmcId: 1027 }).then(response => response);
    await arrived;
    expect((await tracked("delete", btc.id)).status).toBe(204);
    const readded = (await add(1)).body;
    const before = await history(1);
    release();
    expect((await pending).status).toBe(409);
    expect(readded.id).toBeGreaterThan(btc.id);
    expect((await tracked("get")).body).toEqual([readded]);
    expect(await history(1)).toEqual(before);
    expect((await api("get", "/api/cryptocurrencies/1027/history")).status).toBe(404);
  });
  test("a target added while PUT waits produces a conflict without partial history changes", async () => {
    const btc = (await add(1)).body;
    const before = await history(1);
    const normal = handler;
    let release;
    const arrived = new Promise(resolve => {
      handler = (_incoming, outgoing) => {
        handler = normal;
        release = () => outgoing.end(JSON.stringify(quote(1027, 123)));
        resolve();
      };
    });
    const pending = tracked("put", btc.id).send({ cmcId: 1027 }).then(response => response);
    await arrived;
    const eth = (await add(1027)).body;
    const ethHistory = await history(1027);
    release();
    expect((await pending).status).toBe(409);
    expect((await tracked("get")).body).toEqual([btc, eth]);
    expect(await history(1)).toEqual(before);
    expect(await history(1027)).toEqual(ethHistory);
  });
  test("same-coin PUT keeps the tracking ID, appends its quote, and invalidates older operations", async () => {
    const btc = (await add(1)).body;
    const normal = handler;
    let release;
    const arrived = new Promise(resolve => {
      handler = (_incoming, outgoing) => {
        handler = normal;
        release = () => outgoing.end(JSON.stringify(quote(1, 123)));
        resolve();
      };
    });
    const pending = tracked("put", btc.id).send({ cmcId: 1 }).then(response => response);
    await arrived;
    const updated = await tracked("put", btc.id).send({ cmcId: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body.id).toBe(btc.id);
    expect((await tracked("get")).body).toEqual([updated.body]);
    const before = await history(1);
    expect(before).toHaveLength(2);
    release();
    expect((await pending).status).toBe(409);
    expect(await history(1)).toEqual(before);
  });
  test("unknown CMC ID and failed provider responses leave the old coin and history unchanged", async () => {
    const btc = (await add(1)).body;
    const before = await history(1);
    for (const [status, body, expected] of [
      [200, { data: [], status: { error_code: 0, credit_count: 1 } }, 400],
      [503, { error_message: "secret fake-key" }, 502],
      [200, { data: [{ id: 1027 }], status: { error_code: 0, credit_count: 1 } }, 502],
    ]) {
      handler = (_incoming, outgoing) => {
        outgoing.writeHead(status, { "content-type": "application/json" });
        outgoing.end(JSON.stringify(body));
      };
      const result = await tracked("put", btc.id).send({ cmcId: 1027 });
      expect(result.status).toBe(expected);
      expect(JSON.stringify(result.body)).not.toContain("fake-key");
      expect((await tracked("get", btc.id)).body).toEqual(btc);
      expect(await history(1)).toEqual(before);
      expect((await api("get", "/api/cryptocurrencies/1027/history")).status).toBe(404);
    }
  });
  test("PUT timeout never changes tracking or appends a delayed quote", async () => {
    const btc = (await add(1)).body;
    const before = await history(1);
    let release;
    handler = (_incoming, outgoing) => { release = () => outgoing.end(JSON.stringify(quote(1027))); };
    const result = await tracked("put", btc.id).send({ cmcId: 1027 });
    expect(result.status).toBe(504);
    expect(result.body.error.code).toBe("CMC_TIMEOUT");
    release();
    expect((await tracked("get", btc.id)).body).toEqual(btc);
    expect(await history(1)).toEqual(before);
    expect((await api("get", "/api/cryptocurrencies/1027/history")).status).toBe(404);
  });
  test("PUT and DELETE require valid Bearer authentication, and malformed PUT JSON does not mutate data", async () => {
    const btc = (await add(1)).body;
    const before = await history(1);
    for (const method of ["put", "delete"]) {
      for (const authorization of [undefined, "Bearer wrong", "Basic test-token"]) {
        let call = request(application.app)[method](`/api/tracked-cryptocurrencies/${btc.id}`);
        if (authorization) call = call.set("Authorization", authorization);
        if (method === "put") call = call.send({ cmcId: 1027 });
        expect((await call).status).toBe(401);
      }
    }
    const malformed = await tracked("put", btc.id).set("Content-Type", "application/json").send('{"cmcId":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("INVALID_JSON");
    expect((await tracked("get", btc.id)).body).toEqual(btc);
    expect(await history(1)).toEqual(before);
  });
  test("opening the previous disk schema preserves existing tracking and history and upgrades ID allocation", async () => {
    application.close();
    fs.rmSync(path.join(directory, "service.sqlite"));
    const { SqliteDatabase } = require("../dist/database");
    const fixture = new SqliteDatabase(path.join(directory, "service.sqlite"));
    fixture.exec(`
      CREATE TABLE cryptocurrencies (
        id INTEGER PRIMARY KEY, cmc_id INTEGER NOT NULL UNIQUE,
        symbol TEXT NOT NULL, name TEXT NOT NULL, last_updated_at TEXT,
        created_at TEXT NOT NULL DEFAULT '2025-02-03T04:05:00.000Z'
      );
      CREATE TABLE tracked_cryptocurrencies (
        id INTEGER PRIMARY KEY, cryptocurrency_id INTEGER NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT '2025-02-03T04:05:00.000Z',
        FOREIGN KEY (cryptocurrency_id) REFERENCES cryptocurrencies(id) ON DELETE RESTRICT
      );
      CREATE TABLE price_history (
        id INTEGER PRIMARY KEY, cryptocurrency_id INTEGER NOT NULL,
        price REAL NOT NULL CHECK (price >= 0), fetched_at TEXT NOT NULL, provider_updated_at TEXT NOT NULL,
        FOREIGN KEY (cryptocurrency_id) REFERENCES cryptocurrencies(id) ON DELETE RESTRICT
      );
      INSERT INTO cryptocurrencies (id, cmc_id, symbol, name, last_updated_at)
        VALUES (7, 1, 'BTC', 'Bitcoin', '2025-02-03T04:05:00.000Z');
      INSERT INTO tracked_cryptocurrencies (id, cryptocurrency_id) VALUES (9, 7);
      INSERT INTO price_history VALUES (11, 7, 500, '2025-02-03T04:05:00.000Z', '2025-02-03T04:04:00.000Z');
    `);
    fixture.close();
    application = createApplication({ quota: require('./fake-quota.cjs'), apiToken: "test-token", databasePath: path.join(directory, "service.sqlite"),
      coinMarketCapApiKey: "fake-key", coinMarketCapTimeoutMs: 1000, coinMarketCapBaseUrl: baseUrl });
    expect((await tracked("get", 9)).body).toMatchObject({ id: 9, cmcId: 1, symbol: "BTC" });
    const before = await history(1);
    expect(before).toEqual([expect.objectContaining({ id: 11, cmcId: 1, price: 500 })]);
    expect((await tracked("put", 9).send({ cmcId: 1027 })).status).toBe(200);
    expect(await history(1)).toEqual(before);
    expect((await tracked("delete", 9)).status).toBe(204);
    const readded = await add(1);
    expect(readded.body.id).toBeGreaterThan(9);
    expect((await history(1))[0]).toEqual(before[0]);
  });
});
