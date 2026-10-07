const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const request = require('supertest');
const { createApplication } = require('../dist/app');
const TOKEN = 'prices-client-token';
const KEY = 'fake-prices-provider-key';
const timestamp = '2025-01-15T12:00:00.000Z';
const coin = (id, price = 42) => ({ id, name: `Coin ${id}`, symbol: `C${id}`, last_updated: timestamp,
  quote: [{ symbol: 'USD', price, last_updated: timestamp }] });

describe('fresh prices and saved history HTTP API', () => {
  let directory, application, server, baseUrl, calls, respond;
  const get = (url) => request(application.app).get(url).set('Authorization', `Bearer ${TOKEN}`);
  const add = (cmcId) => request(application.app).post('/api/tracked-cryptocurrencies')
    .set('Authorization', `Bearer ${TOKEN}`).send({ cmcId });
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evercode-prices-'));
    calls = [];
    respond = (ids, outgoing) => outgoing.end(JSON.stringify({ data: ids.map(id => coin(id)), status: { error_code: 0 } }));
    server = http.createServer((incoming, outgoing) => {
      const url = new URL(incoming.url, 'http://localhost');
      calls.push({ ids: url.searchParams.get('id'), currency: url.searchParams.get('convert'), key: incoming.headers['x-cmc_pro_api_key'] });
      outgoing.setHeader('content-type', 'application/json');
      respond(url.searchParams.get('id').split(',').map(Number), outgoing);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    application = createApplication({ apiToken: TOKEN, coinMarketCapApiKey: KEY,
      coinMarketCapTimeoutMs: 100, coinMarketCapBaseUrl: baseUrl,
      databasePath: path.join(directory, 'service.sqlite') });
  });
  afterEach(async () => {
    application.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test.each(['/api/prices?limit=1', '/api/tracked-cryptocurrencies/1/price?currency=EUR', '/api/tracked-cryptocurrencies/1?other=1'])('rejects unsupported query fields at %s before external requests', async route => {
    await add(1);
    calls.length = 0;
    expect((await get(route)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('returns an empty price list without contacting the provider', async () => {
    expect((await get('/api/prices')).body).toEqual([]);
    expect(calls).toEqual([]);
  });

  test.each([['provider HTTP failure', 502], ['missing quote', 502], ['invalid price', 502], ['timeout', 504], ['connection failure', 502]])('never falls back to stored prices on %s', async (mode, status) => {
    await add(1); await add(2);
    const before = (await get('/api/cryptocurrencies/1/history')).body;
    respond = (ids, outgoing) => {
      if (mode === 'provider HTTP failure') { outgoing.statusCode = 429; outgoing.end(JSON.stringify({ secret: KEY })); }
      else if (mode === 'timeout') setTimeout(() => outgoing.end('{}'), 200);
      else if (mode === 'connection failure') outgoing.destroy();
      else outgoing.end(JSON.stringify({ data: mode === 'missing quote' ? [] : ids.map(id => coin(id, -1)), status: { error_code: 0 } }));
    };
    for (const route of ['/api/tracked-cryptocurrencies/1/price', '/api/prices']) {
      const failed = await get(route);
      expect(failed.status).toBe(status);
      expect(failed.body.error.code).toBe(status === 504 ? 'CMC_TIMEOUT' : 'CMC_API_ERROR');
      expect(JSON.stringify(failed.body)).not.toContain(KEY);
    }
    expect((await get('/api/cryptocurrencies/1/history')).body).toEqual(before);
  });

  test('validates the entire multi-batch result before storing any observation', async () => {
    for (let id = 1; id <= 251; id++) expect((await add(id)).status).toBe(201);
    calls.length = 0;
    respond = (ids, outgoing) => outgoing.end(JSON.stringify({ data: ids.length === 1 ? [] : ids.map(id => coin(id, 99)), status: { error_code: 0 } }));
    expect((await get('/api/prices')).status).toBe(502);
    expect(calls.map(call => call.ids.split(',').length)).toEqual([250, 1]);
    expect((await get('/api/cryptocurrencies/1/history')).body.map(entry => entry.price)).toEqual([42]);
    respond = (ids, outgoing) => outgoing.end(JSON.stringify({ data: ids.map(id => coin(id, 99)), status: { error_code: 0 } }));
    const fresh = await get('/api/prices');
    expect(fresh.status).toBe(200);
    expect(fresh.body).toHaveLength(251);
    expect((await get('/api/cryptocurrencies/251/history')).body.map(entry => entry.price)).toEqual([42, 99]);
    expect((await get('/api/tracked-cryptocurrencies')).body).toHaveLength(50);
    expect((await get('/api/tracked-cryptocurrencies?limit=100')).body).toHaveLength(100);
  });

  test.each(['0', '-1', '1.5', '1x', '9007199254740992'])('rejects invalid price tracking ID %s without contacting provider', async id => {
    expect((await get(`/api/tracked-cryptocurrencies/${id}/price`)).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('returns 404 for missing tracking price and protects new price routes', async () => {
    expect((await get('/api/tracked-cryptocurrencies/999/price')).status).toBe(404);
    for (const route of ['/api/prices', '/api/tracked-cryptocurrencies/1/price', '/api/cryptocurrencies/1/history']) {
      expect((await request(application.app).get(route)).status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  test('normalizes history boundaries with timezone offsets to UTC', async () => {
    await add(1);
    const entry = (await get('/api/cryptocurrencies/1/history')).body[0];
    const shifted = new Date(Date.parse(entry.fetchedAt) + 3600000).toISOString().replace('Z', '+01:00');
    const boundary = encodeURIComponent(shifted);
    expect((await get(`/api/cryptocurrencies/1/history?from=${boundary}&to=${boundary}`)).body).toEqual([entry]);
  });

  test('rejects duplicate provider rows instead of selecting an arbitrary quote', async () => {
    await add(1);
    respond = (_ids, outgoing) => outgoing.end(JSON.stringify({ data: [coin(1), coin(1, 100)], status: { error_code: 0 } }));
    expect((await get('/api/prices')).status).toBe(502);
    expect((await get('/api/cryptocurrencies/1/history')).body).toHaveLength(1);
  });

  test.each(['from=2025-02-31T00:00:00Z', 'from=2025-01-01', 'from=2025-01-01T00:00:00', 'from=bad', 'from=', 'from=2025-01-01T24:00:00Z', 'from=2025-01-01T00:00:00Z&from=2025-01-02T00:00:00Z', 'from=2025-01-02T00:00:00Z&to=2025-01-01T00:00:00Z', 'limit=0', 'unknown=1'])('rejects invalid history query %s', async query => {
    await add(1);
    expect((await get(`/api/cryptocurrencies/1/history?${query}`)).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  test('filters history by inclusive fetch timestamps and pages matching observations', async () => {
    await add(1);
    const fresh = await get('/api/tracked-cryptocurrencies/1/price');
    const date = encodeURIComponent(fresh.body.fetchedAt);
    const exact = await get(`/api/cryptocurrencies/1/history?from=${date}&to=${date}&limit=1`);
    expect(exact.status).toBe(200);
    expect(exact.body[0]).toEqual(fresh.body);
    const second = await get('/api/cryptocurrencies/1/history?limit=1&offset=1');
    expect(second.body).toEqual([fresh.body]);
    expect((await get('/api/cryptocurrencies/1/history?to=2000-01-01T00%3A00%3A00Z')).body).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  test.each(['limit=0', 'limit=101', 'limit=1.5', 'limit=Infinity', 'offset=-1', 'offset=1x', 'offset=9007199254740992', 'limit=', 'limit=1&limit=2', 'from=2025-01-01T00:00:00Z', 'other=1'])('rejects invalid list query %s', async query => {
    expect((await get(`/api/tracked-cryptocurrencies?${query}`)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('pages the tracking list in stable ID order', async () => {
    await add(1); await add(2); await add(3);
    const page = await get('/api/tracked-cryptocurrencies?limit=1&offset=1');
    expect(page.status).toBe(200);
    expect(page.body.map(entry => entry.cmcId)).toEqual([2]);
  });

  test('fetches the full tracking list in a single USD batch and saves every quote', async () => {
    await add(1);
    await add(1027);
    calls.length = 0;
    const fresh = await get('/api/prices');
    expect(fresh.status).toBe(200);
    expect(fresh.body.map(entry => entry.cmcId)).toEqual([1, 1027]);
    expect(calls).toEqual([{ ids: '1,1027', currency: 'USD', key: KEY }]);
    for (const id of [1, 1027]) expect((await get(`/api/cryptocurrencies/${id}/history`)).body).toHaveLength(2);
  });

  test('fetches a new USD price for one tracking record and appends its history', async () => {
    const created = await add(1);
    respond = (ids, outgoing) => outgoing.end(JSON.stringify({ data: ids.map(id => coin(id, 99)), status: { error_code: 0 } }));
    const fresh = await get(`/api/tracked-cryptocurrencies/${created.body.id}/price`);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ cmcId: 1, name: 'Coin 1', symbol: 'C1', price: 99, currency: 'USD', providerUpdatedAt: timestamp });
    expect(new Date(fresh.body.fetchedAt).toISOString()).toBe(fresh.body.fetchedAt);
    expect(calls).toEqual([{ ids: '1', currency: 'USD', key: KEY }, { ids: '1', currency: 'USD', key: KEY }]);
    const history = await get('/api/cryptocurrencies/1/history');
    expect(history.body.map(entry => entry.price)).toEqual([42, 99]);
    expect(history.body[1]).toEqual(fresh.body);
    expect((await get(`/api/tracked-cryptocurrencies/${created.body.id}`)).body.lastUpdatedAt).toBe(fresh.body.fetchedAt);
  });
});
