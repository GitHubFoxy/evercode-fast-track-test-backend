const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { createServer } = require('./http-server.cjs');
const { createApplication } = require('../dist/app');

const start = Date.parse('2030-01-01T00:00:00.000Z');

describe('background deadlines remain independent of client traffic', () => {
  let directory, provider, application, now, scheduled, calls, respond;
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
  const advanceTo = async target => {
    while (scheduled && scheduled.at <= target) {
      const timer = scheduled;
      scheduled = undefined;
      now = timer.at;
      await timer.callback();
    }
    now = target;
  };

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evercode-scheduler-'));
    now = start; scheduled = undefined; calls = []; application = undefined;
    respond = (ids, res) => {
      const timestamp = new Date(now).toISOString();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: { error_code: 0, credit_count: 1 }, data: ids.map(id => ({
        id, name: `Coin ${id}`, symbol: `C${id}`, last_updated: timestamp,
        quote: [{ symbol: 'USD', price: 42, last_updated: timestamp }],
      })) }));
    };
    provider = createServer((req, res) => {
      const ids = new URL(req.url, 'http://localhost').searchParams.get('id').split(',').map(Number);
      calls.push({ ids, at: now });
      respond(ids, res);
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

  test('refreshing one coin every 30 seconds still saves the other coin every minute', async () => {
    open();
    for (const cmcId of [1, 2]) {
      expect((await api('post', '/api/tracked-cryptocurrencies').send({ cmcId })).status).toBe(201);
    }
    for (let step = 1; step <= 6; step++) {
      await advanceTo(start + step * 30000);
      expect((await api('get', '/api/tracked-cryptocurrencies/1/price')).status).toBe(200);
    }
    expect(calls.filter(call => call.ids.length === 2).map(call => call.at - start)).toEqual([60000, 120000, 180000]);
    const history = await api('get', '/api/cryptocurrencies/2/history');
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(4);
    expect(new Set(history.body.map(entry => entry.fetchedAt))).toEqual(new Set([
      0, 60000, 120000, 180000,
    ].map(offset => new Date(start + offset).toISOString())));

    // Confirm these observations survive closing and reopening the disk database.
    await application.close();
    expect(scheduled).toBeUndefined();
    open();
    expect((await api('get', '/api/cryptocurrencies/2/history')).body).toEqual(history.body);
  });

  test('client spending changes the budgeted interval without restarting its countdown', async () => {
    open({ quota: { monthlyLimit: 9, creditsLeft: 9, minuteLimit: 1000, requestsLeft: 1000,
      resetAt: '2030-01-01T00:10:00.000Z' } });
    expect((await api('post', '/api/tracked-cryptocurrencies').send({ cmcId: 1 })).status).toBe(201);
    expect(scheduled.at).toBe(start + 75000);
    await advanceTo(start + 30000);
    expect((await api('get', '/api/tracked-cryptocurrencies/1/price')).status).toBe(200);
    // Seven credits remain: spread six background cycles over the remaining 570 seconds.
    expect(scheduled.at).toBe(start + 81429);
    await advanceTo(start + 81428);
    expect(calls).toHaveLength(2);
    await advanceTo(start + 81429);
    expect(calls).toHaveLength(3);
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(3);
    expect(scheduled.at - now).toBeGreaterThanOrEqual(60000);
  });

  test.each(['disabled', 'enabled'])('overlapping clients do not starve three background cycles with quota %s', async mode => {
    open(mode === 'enabled' ? { quota: { monthlyLimit: 1000, creditsLeft: 1000,
      minuteLimit: 1000, requestsLeft: 1000, resetAt: '2030-01-01T00:10:00Z' } } : {});
    for (const cmcId of [1, 2]) expect((await api('post', '/api/tracked-cryptocurrencies').send({ cmcId })).status).toBe(201);
    const normal = respond, clients = [], releases = [];
    let entered, backgroundEntered, backgroundRelease, activeBackgrounds = 0, peakBackgrounds = 0;
    respond = (ids, res) => {
      if (ids.length === 1) {
        releases.push(() => normal(ids, res));
        entered();
      } else {
        activeBackgrounds++;
        peakBackgrounds = Math.max(peakBackgrounds, activeBackgrounds);
        backgroundRelease = () => { activeBackgrounds--; normal(ids, res); };
        backgroundEntered();
      }
    };
    const startClient = async () => {
      const started = new Promise(resolve => { entered = resolve; });
      clients.push(api('get', '/api/tracked-cryptocurrencies/1/price').then(response => response));
      await started;
    };
    try {
      await startClient();
      for (let step = 1; step <= 3; step++) {
        await startClient();
        const timer = scheduled;
        now = timer.at; scheduled = undefined;
        const started = new Promise(resolve => { backgroundEntered = resolve; });
        const cycle = timer.callback();
        // A skipped cycle resolves before reaching CMC: fail promptly rather than waiting for a timeout.
        expect(await Promise.race([started.then(() => true), cycle.then(() => false)])).toBe(true);
        await timer.callback();
        expect(scheduled).toBeUndefined();
        expect(activeBackgrounds).toBe(1);
        backgroundRelease(); backgroundRelease = undefined;
        await cycle;
        expect((await api('get', '/api/cryptocurrencies/2/history')).body).toHaveLength(step + 1);
      }
      expect(peakBackgrounds).toBe(1);
      expect(calls.filter(call => call.ids.length === 2).map(call => call.at - start)).toEqual([60000, 120000, 180000]);
    } finally {
      backgroundRelease?.();
      for (const release of releases) release();
      expect((await Promise.all(clients)).map(response => response.status)).toEqual(clients.map(() => 200));
    }
  });
});
