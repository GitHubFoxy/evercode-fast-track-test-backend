const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { createServer } = require('./http-server.cjs');
const { createApplication } = require('../dist/app');

const start = Date.parse('2030-01-01T00:00:00.000Z');

describe('review fixes', () => {
  let directory, provider, application, now, scheduled, calls, handler;
  const api = (method, url) => request(application.app)[method](url).set('Authorization', 'Bearer client');
  const open = (extra = {}) => {
    application = createApplication({
      apiToken: 'client', databasePath: path.join(directory, 'prices.sqlite'),
      coinMarketCapApiKey: 'fake', coinMarketCapTimeoutMs: 1000,
      coinMarketCapBaseUrl: `http://127.0.0.1:${provider.address().port}`,
      syncIntervalMs: 60000,
      clock: {
        now: () => now,
        setTimeout: (callback, delay) => { scheduled = { callback, at: now + delay }; return scheduled; },
        clearTimeout: timer => { if (scheduled === timer) scheduled = undefined; },
      },
      ...extra,
    });
  };
  const okBody = ids => {
    const timestamp = new Date(now).toISOString();
    return JSON.stringify({ status: { error_code: 0, credit_count: 1 }, data: ids.map(id => ({
      id, name: `Coin ${id}`, symbol: `C${id}`, last_updated: timestamp,
      quote: [{ symbol: 'USD', price: 42, last_updated: timestamp }],
    })) });
  };

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evercode-fixes-'));
    now = start; scheduled = undefined; calls = []; application = undefined;
    handler = (ids, res) => { res.setHeader('content-type', 'application/json'); res.end(okBody(ids)); };
    provider = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/v1/key/info') { res.statusCode = 500; res.end('{}'); return; }
      const ids = url.searchParams.get('id').split(',').map(Number);
      calls.push(ids);
      handler(ids, res);
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  });
  afterEach(async () => {
    try { await application?.close(); }
    finally {
      provider.closeAllConnections();
      await new Promise(resolve => provider.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('limited minute quota still refreshes every coin in rotation', async () => {
    open({ batchSize: 1, quota: { monthlyLimit: 1000, creditsLeft: 1000, minuteLimit: 2,
      requestsLeft: 2, resetAt: '2030-01-01T00:10:00.000Z' } });
    for (const cmcId of [1, 2]) expect((await api('post', '/api/tracked-cryptocurrencies').send({ cmcId })).status).toBe(201);
    calls = [];
    for (let cycle = 0; cycle < 4 && scheduled; cycle++) {
      const timer = scheduled; scheduled = undefined; now = timer.at; await timer.callback();
    }
    expect(calls.flat()).toEqual(expect.arrayContaining([1, 2]));
    const sizes = [1, 2].map(async id => (await api('get', `/api/cryptocurrencies/${id}/history`)).body.length);
    for (const size of await Promise.all(sizes)) expect(size).toBeGreaterThan(1);
  });

  test('a persistently failing batch does not starve the others under limited quota', async () => {
    open({ batchSize: 1, quota: { monthlyLimit: 1000, creditsLeft: 1000, minuteLimit: 2,
      requestsLeft: 2, resetAt: '2030-01-01T00:10:00.000Z' } });
    for (const cmcId of [1, 2]) expect((await api('post', '/api/tracked-cryptocurrencies').send({ cmcId })).status).toBe(201);
    const ok = handler;
    handler = (ids, res) => {
      if (ids[0] !== 1) return ok(ids, res);
      res.statusCode = 500; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: { error_code: 500, credit_count: 1 } }));
    };
    calls = [];
    for (let cycle = 0; cycle < 4 && scheduled; cycle++) {
      const timer = scheduled; scheduled = undefined; now = timer.at; await timer.callback();
    }
    expect(calls.flat()).toContain(2);
    expect((await api('get', '/api/cryptocurrencies/2/history')).body.length).toBeGreaterThan(1);
  });

  test.each([
    ['unrelated 400', { status: { error_code: 400, error_message: 'Bad request' } }, 502, 'CMC_API_ERROR'],
    ['invalid id 400', { status: { error_code: 400, error_message: 'Invalid value for "id": "x"' } }, 400, 'CMC_ID_NOT_FOUND'],
  ])('maps provider %s correctly', async (_name, body, status, code) => {
    open();
    handler = (_ids, res) => { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    const response = await api('post', '/api/tracked-cryptocurrencies').send({ cmcId: 1 });
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });

  test.each(['bearer client', 'BEARER   client', 'Bearer client'])('accepts authorization %j', async value => {
    open();
    const response = await request(application.app).get('/api/tracked-cryptocurrencies').set('Authorization', value);
    expect(response.status).toBe(200);
  });

  test('401 advertises the Bearer scheme', async () => {
    open();
    const response = await request(application.app).get('/api/tracked-cryptocurrencies').set('Authorization', 'Bearer wrong');
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });
});
