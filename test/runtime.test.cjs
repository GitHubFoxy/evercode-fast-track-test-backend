const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const request = require('supertest');
const { createApplication } = require('../dist/app');
const stamp = '2030-01-01T00:00:00.000Z';
const quote = id => ({ id, name: `Coin ${id}`, symbol: `C${id}`, last_updated: stamp,
  quote: [{ symbol: 'USD', price: 42, last_updated: stamp }] });
const fallback = { monthlyLimit: 1000, creditsLeft: 1000, resetAt: '2030-02-01T00:00:00Z',
  minuteLimit: 1000, requestsLeft: 1000 };
describe('shared persistent provider budget and runtime', () => {
  let dir, provider, app, config, calls, respond, now;
  const api = (method, url) => request(app.app)[method](url).set('Authorization', 'Bearer client');
  const add = id => api('post', '/api/tracked-cryptocurrencies').send({ cmcId: id });
  const reopen = extra => { app?.close(); app = createApplication({ ...config, ...extra }); };
  beforeEach(async () => {
    app = undefined;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evercode-runtime-'));
    calls = []; now = Date.parse(stamp);
    respond = (url, res) => res.end(JSON.stringify({ data: url.searchParams.get('id').split(',').map(Number).map(quote),
      status: { error_code: 0, credit_count: 1 } }));
    provider = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost'); calls.push(url.pathname + url.search);
      res.setHeader('content-type', 'application/json'); respond(url, res);
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    config = { apiToken: 'client', coinMarketCapApiKey: 'fake', coinMarketCapTimeoutMs: 100,
      coinMarketCapBaseUrl: `http://127.0.0.1:${provider.address().port}`,
      databasePath: path.join(dir, 'db.sqlite'), clock: { now: () => now } };
    reopen();
  });
  afterEach(async () => {
    try { await app?.close(); }
    finally {
      app = undefined;
      provider.closeAllConnections();
      await new Promise(r => provider.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  test('POST, PUT and fresh GET share actual credits across restart, including invalid and failed responses', async () => {
    reopen({ quota: { ...fallback, monthlyLimit: 7, creditsLeft: 7 } });
    expect((await add(1)).status).toBe(201);
    respond = (url, res) => res.end(JSON.stringify({ data: [quote(Number(url.searchParams.get('id')))], status: { error_code: 0, credit_count: 2 } }));
    expect((await api('put', '/api/tracked-cryptocurrencies/1').send({ cmcId: 2 })).status).toBe(200);
    respond = (_url, res) => res.end(JSON.stringify({ data: [], status: { error_code: 0, credit_count: 2 } }));
    expect((await api('get', '/api/prices')).status).toBe(502);
    respond = (_url, res) => { res.statusCode = 503; res.end(JSON.stringify({ status: { credit_count: 2 } })); };
    expect((await api('get', '/api/prices')).status).toBe(502);
    reopen({ quota: { ...fallback, monthlyLimit: 7, creditsLeft: 7 } });
    expect((await api('get', '/api/prices')).status).toBe(502);
    expect(calls).toHaveLength(4);
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(1);
  });
  test.each(['client', 'background'])('invalid credit count recovers through budgeted reconciliation for %s quotes', async mode => {
    let scheduled;
    const clock = { now: () => now, setTimeout: (callback, delay) => { scheduled = { callback, at: now + delay }; return scheduled; },
      clearTimeout: timer => { if (scheduled === timer) scheduled = undefined; } };
    const tick = async () => {
      expect(scheduled).toBeDefined();
      expect(Number.isFinite(scheduled.at)).toBe(true);
      expect(scheduled.at).toBeGreaterThan(now);
      const timer = scheduled; now = timer.at; scheduled = undefined; await timer.callback();
    };
    reopen({ clock, syncIntervalMs: 60000, quota: { ...fallback, monthlyLimit: 7, creditsLeft: 7, keyInfoCredits: 1 } });
    const normal = respond;
    let invalid = false;
    respond = (url, res) => {
      if (url.pathname === '/v1/key/info') res.end(JSON.stringify({ status: { error_code: 0, credit_count: 1 }, data: {
        plan: { credit_limit_monthly: 7, credit_limit_monthly_reset_timestamp: fallback.resetAt, rate_limit_minute: 1000 },
        usage: { current_month: { credits_left: 7 }, current_minute: { requests_left: 1000 } }
      } }));
      else if (invalid) res.end(JSON.stringify({ status: { error_code: 0, credit_count: '1' }, data: [quote(1)] }));
      else normal(url, res);
    };
    expect((await add(1)).status).toBe(201);
    invalid = true;
    if (mode === 'client') expect((await api('get', '/api/prices')).status).toBe(502);
    else await tick();
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(1);
    invalid = false;
    if (mode === 'client') expect((await api('get', '/api/prices')).status).toBe(200);
    else await tick();
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(2);
    expect(calls.filter(url => url === '/v1/key/info')).toHaveLength(2);
    await tick();
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(3);
    expect((await api('get', '/api/prices')).status).toBe(200);
    expect((await api('get', '/api/prices')).status).toBe(502);
    const before = calls.length;
    await tick(); expect(calls).toHaveLength(before);
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(4);
  });
  test('official key info reconciles the bootstrap and consumes the shared allowance', async () => {
    reopen({ quota: { ...fallback, keyInfoCredits: 2 } });
    const normal = respond;
    respond = (url, res) => url.pathname === '/v1/key/info' ? res.end(JSON.stringify({
      status: { error_code: 0, credit_count: 2 }, data: {
        plan: { credit_limit_monthly: 10, credit_limit_monthly_reset_timestamp: fallback.resetAt, rate_limit_minute: 3 },
        usage: { current_month: { credits_used: 6, credits_left: 4 }, current_minute: { requests_made: 1, requests_left: 2 } }
      } })) : normal(url, res);
    expect((await add(1)).status).toBe(201);
    expect((await api('get', '/api/prices')).status).toBe(200);
    expect((await api('get', '/api/prices')).status).toBe(502);
    expect(calls.map(url => url.split('?')[0])).toEqual(['/v1/key/info', '/v3/cryptocurrency/quotes/latest', '/v3/cryptocurrency/quotes/latest']);
    now += 60000;
    expect((await api('get', '/api/prices')).status).toBe(200);
    expect((await api('get', '/api/prices')).status).toBe(200);
    expect((await api('get', '/api/prices')).status).toBe(502);
  });
  test('month rollover requires a new official reset timestamp before quotes resume', async () => {
    reopen({ quota: { ...fallback, keyInfoCredits: 1 } });
    const normal = respond;
    respond = (url, res) => url.pathname === '/v1/key/info' ? res.end(JSON.stringify({ status: { error_code: 0, credit_count: 1 }, data: {
      plan: { credit_limit_monthly: 10, rate_limit_minute: 10,
        credit_limit_monthly_reset_timestamp: now < Date.parse(fallback.resetAt) ? fallback.resetAt : '2030-03-01T00:00:00Z' },
      usage: { current_month: { credits_used: 9, credits_left: 1 }, current_minute: { requests_made: 1, requests_left: 9 } }
    } })) : normal(url, res);
    expect((await add(1)).status).toBe(201);
    expect((await api('get', '/api/prices')).status).toBe(502);
    now = Date.parse(fallback.resetAt);
    expect((await api('get', '/api/prices')).status).toBe(200);
    expect(calls.filter(url => url === '/v1/key/info')).toHaveLength(2);
  });
  test('background persists fresh quotes and slows down after client spending', async () => {
    let scheduled;
    const clock = { now: () => now, setTimeout: (callback, delay) => { scheduled = { callback, at: now + delay }; return scheduled; },
      clearTimeout: timer => { if (scheduled === timer) scheduled = undefined; } };
    const tick = async () => { const timer = scheduled; now = timer.at; scheduled = undefined; await timer.callback(); };
    reopen({ clock, syncIntervalMs: 60000, quota: { ...fallback, monthlyLimit: 9, creditsLeft: 9,
      resetAt: '2030-01-01T00:10:00Z' } });
    expect((await add(1)).status).toBe(201);
    expect(scheduled.at - now).toBe(75000);
    await tick();
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(2);
    expect((await api('get', '/api/prices')).status).toBe(200);
    expect(scheduled.at - now).toBe(87500);
    await tick();
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(4);
    await api('delete', '/api/tracked-cryptocurrencies/1');
    const before = calls.length; await tick(); expect(calls).toHaveLength(before);
    app.close(); expect(scheduled).toBeUndefined();
  });
  test('client in flight prevents background spending and cycles never overlap', async () => {
    let scheduled;
    const clock = { now: () => now, setTimeout: (callback, delay) => { scheduled = { callback, at: now + delay }; return scheduled; },
      clearTimeout: timer => { if (scheduled === timer) scheduled = undefined; } };
    reopen({ clock, syncIntervalMs: 60000, coinMarketCapTimeoutMs: 1000, quota: fallback });
    await add(1);
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const normal = respond;
    respond = (url, res) => { release = () => normal(url, res); entered(); };
    const client = api('get', '/api/prices').then(r => r);
    await started;
    const timer = scheduled; now = timer.at; await timer.callback();
    expect(calls).toHaveLength(2);
    release(); expect((await client).status).toBe(200);
    const next = scheduled; now = next.at;
    const bgStarted = new Promise(resolve => { entered = resolve; });
    const background = next.callback(); await bgStarted;
    await next.callback(); expect(calls).toHaveLength(3);
    release(); await background;
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(3);
  });
  test('provider throttling blocks further calls in the minute and recovers after reset', async () => {
    reopen({ quota: fallback }); await add(1);
    const normal = respond;
    respond = (_url, res) => { res.statusCode = 429; res.end(JSON.stringify({ status: { credit_count: 1 } })); };
    expect((await api('get', '/api/prices')).status).toBe(502);
    respond = normal;
    expect((await api('get', '/api/prices')).status).toBe(502);
    expect(calls).toHaveLength(2);
    now += 60000;
    expect((await api('get', '/api/prices')).status).toBe(200);
  });
  test('missing key-info fields use verified fallback minus service credits, never invented quota', async () => {
    reopen({ quota: { ...fallback, creditsLeft: 3, keyInfoCredits: 1 } });
    const normal = respond;
    respond = (url, res) => url.pathname === '/v1/key/info' ? res.end(JSON.stringify({
      status: { error_code: 0, credit_count: 1 }, data: { plan: {}, usage: {} } })) : normal(url, res);
    expect((await add(1)).status).toBe(201);
    expect((await api('get', '/api/prices')).status).toBe(200);
    expect((await api('get', '/api/prices')).status).toBe(502);
    expect(calls).toHaveLength(3);
  });
  test('invalid official quota denies quotes but can recover with a valid budgeted reconciliation', async () => {
    reopen({ quota: { ...fallback, keyInfoCredits: 1 } });
    respond = (_url, res) => res.end(JSON.stringify({ status: { error_code: 0, credit_count: 1 }, data: {
      plan: { credit_limit_monthly: -1 }, usage: {} } }));
    expect((await add(1)).status).toBe(502);
    expect(calls).toEqual(['/v1/key/info']);
    const quotes = (url, res) => res.end(JSON.stringify({ status: { error_code: 0, credit_count: 1 }, data: url.searchParams.get('id').split(',').map(Number).map(quote) }));
    respond = (url, res) => url.pathname === '/v1/key/info' ? res.end(JSON.stringify({ status: { error_code: 0, credit_count: 1 }, data: { plan: {}, usage: {} } })) : quotes(url, res);
    expect((await add(1)).status).toBe(201);
    expect(calls.map(url => url.split('?')[0])).toEqual(['/v1/key/info', '/v1/key/info', '/v3/cryptocurrency/quotes/latest']);
  });
  test('background never polls faster than the documented 60-second source updates', async () => {
    let scheduled;
    const clock = { now: () => now, setTimeout: (callback, delay) => { scheduled = { callback, at: now + delay }; return scheduled; }, clearTimeout: () => {} };
    reopen({ clock, syncIntervalMs: 1000, quota: { ...fallback, resetAt: '2030-01-01T00:01:00Z' } });
    await add(1);
    expect(scheduled.at - now).toBe(60000);
  });
  test.each(['delete', 'replace', 'ABA', 'same coin'])('background rejects stale tracking after %s and rereads the next cycle', async change => {
    let scheduled;
    const clock = { now: () => now, setTimeout: (callback, delay) => { scheduled = { callback, at: now + delay }; return scheduled; },
      clearTimeout: timer => { if (timer === scheduled) scheduled = undefined; } };
    reopen({ clock, syncIntervalMs: 60000, coinMarketCapTimeoutMs: 1000, quota: fallback });
    await add(1);
    const normal = respond;
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    respond = (url, res) => { release = () => normal(url, res); entered(); };
    const timer = scheduled; now = timer.at; const cycle = timer.callback(); await started;
    respond = normal;
    const replace = id => api('put', '/api/tracked-cryptocurrencies/1').send({ cmcId: id });
    if (change === 'delete') await api('delete', '/api/tracked-cryptocurrencies/1');
    else { expect((await replace(change === 'same coin' ? 1 : 2)).status).toBe(200);
      if (change === 'ABA') expect((await replace(1)).status).toBe(200); }
    const before = (await api('get', '/api/cryptocurrencies/1/history')).body;
    release(); await cycle;
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toEqual(before);
    const count = calls.length; const next = scheduled; now = next.at; await next.callback();
    if (change === 'delete') expect(calls).toHaveLength(count);
    else expect(calls.at(-1)).toContain(`id=${change === 'replace' ? 2 : 1}&convert=USD`);
  });
  test('background keeps successful batches and resumes after a failed batch', async () => {
    let scheduled;
    const clock = { now: () => now, setTimeout: (callback, delay) => { scheduled = { callback, at: now + delay }; return scheduled; },
      clearTimeout: timer => { if (timer === scheduled) scheduled = undefined; } };
    reopen({ clock, syncIntervalMs: 60000, batchSize: 1, quota: fallback });
    await add(1); await add(2);
    const normal = respond;
    respond = (url, res) => {
      if (url.searchParams.get('id') === '1') { res.statusCode = 503; res.end(JSON.stringify({ status: { credit_count: 1 } })); }
      else normal(url, res);
    };
    let timer = scheduled; now = timer.at; await timer.callback();
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(1);
    expect((await api('get', '/api/cryptocurrencies/2/history')).body).toHaveLength(2);
    respond = normal; timer = scheduled; now = timer.at; await timer.callback();
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(2);
    expect((await api('get', '/api/cryptocurrencies/2/history')).body).toHaveLength(3);
  });
  test('an unconfirmed successful credit count never permits writes or more quote calls', async () => {
    reopen({ quota: fallback });
    respond = (_url, res) => res.end(JSON.stringify({ status: { error_code: 0, credit_count: '1' }, data: [quote(1)] }));
    expect((await add(1)).status).toBe(502);
    expect((await api('get', '/api/tracked-cryptocurrencies')).body).toEqual([]);
    expect((await add(2)).status).toBe(502);
    expect(calls).toHaveLength(1);
  });
  test('client observations use the same controlled UTC clock as the quota', async () => {
    reopen({ quota: fallback });
    expect((await add(1)).body.lastUpdatedAt).toBe(stamp);
    now += 1000;
    expect((await api('put', '/api/tracked-cryptocurrencies/1').send({ cmcId: 1 })).body.lastUpdatedAt).toBe('2030-01-01T00:00:01.000Z');
    now += 1000;
    expect((await api('get', '/api/tracked-cryptocurrencies/1/price')).body.fetchedAt).toBe('2030-01-01T00:00:02.000Z');
  });
  test('background shares depletion with clients and leaves the last credit for a fresh client quote', async () => {
    let scheduled;
    const clock = { now: () => now, setTimeout: (callback, delay) => { scheduled = { callback, at: now + delay }; return scheduled; },
      clearTimeout: timer => { if (timer === scheduled) scheduled = undefined; } };
    reopen({ clock, syncIntervalMs: 60000, quota: { ...fallback, monthlyLimit: 3, creditsLeft: 3, resetAt: '2030-01-01T00:03:00Z' } });
    await add(1);
    let timer = scheduled; now = timer.at; await timer.callback();
    expect(calls).toHaveLength(2);
    timer = scheduled; now = timer.at; await timer.callback();
    expect(calls).toHaveLength(2);
    expect((await api('get', '/api/prices')).status).toBe(200);
    expect((await api('get', '/api/prices')).status).toBe(502);
    expect(calls).toHaveLength(3);
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(3);
  });
  test('unauthorized and invalid requests cannot postpone the scheduled background cycle', async () => {
    let scheduled;
    const clock = { now: () => now, setTimeout: (callback, delay) => { scheduled = { callback, at: now + delay }; return scheduled; },
      clearTimeout: timer => { if (timer === scheduled) scheduled = undefined; } };
    reopen({ clock, syncIntervalMs: 60000, quota: fallback }); await add(1);
    const expected = scheduled.at; now += 1000;
    expect((await request(app.app).post('/api/tracked-cryptocurrencies').send({ cmcId: 2 })).status).toBe(401);
    expect((await api('post', '/api/tracked-cryptocurrencies').send({ cmcId: -1 })).status).toBe(400);
    expect(scheduled.at).toBe(expected);
  });
  test('background forecasts observed credit cost and preserves it across restart', async () => {
    let scheduled;
    const clock = { now: () => now, setTimeout: (callback, delay) => { scheduled = { callback, at: now + delay }; return scheduled; },
      clearTimeout: timer => { if (timer === scheduled) scheduled = undefined; } };
    const extra = { clock, syncIntervalMs: 60000, quota: { ...fallback, monthlyLimit: 11, creditsLeft: 11, resetAt: '2030-01-01T00:10:00Z' } };
    reopen(extra);
    respond = (url, res) => res.end(JSON.stringify({ data: url.searchParams.get('id').split(',').map(Number).map(quote), status: { error_code: 0, credit_count: 2 } }));
    await add(1);
    expect(scheduled.at - now).toBe(120000);
    reopen(extra);
    expect(scheduled.at - now).toBe(120000);
  });
  test('a supplied Retry-After is respected across minute reset and database restart', async () => {
    reopen({ quota: fallback }); await add(1);
    const normal = respond;
    respond = (_url, res) => { res.statusCode = 429; res.setHeader('Retry-After', '120'); res.end('{}'); };
    expect((await api('get', '/api/prices')).status).toBe(502);
    now += 60000; respond = normal; reopen({ quota: fallback });
    expect((await api('get', '/api/prices')).status).toBe(502);
    expect(calls).toHaveLength(2);
    now += 60000; expect((await api('get', '/api/prices')).status).toBe(200);
  });
  test('closing during an active background request cancels it without late history or timers', async () => {
    let scheduled;
    const clock = { now: () => now, setTimeout: (callback, delay) => { scheduled = { callback, at: now + delay }; return scheduled; },
      clearTimeout: timer => { if (timer === scheduled) scheduled = undefined; } };
    reopen({ clock, syncIntervalMs: 60000, coinMarketCapTimeoutMs: 1000, quota: fallback }); await add(1);
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    respond = () => entered();
    const timer = scheduled; now = timer.at; scheduled = undefined;
    const cycle = timer.callback(); await started;
    await Promise.all([app.close(), app.close(), cycle]);
    expect(scheduled).toBeUndefined();
    const before = calls.length; await timer.callback(); expect(calls).toHaveLength(before);
    reopen({ quota: fallback });
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(1);
  });
  test('restart reconciles external key spending without restoring the environment allowance', async () => {
    const extra = { quota: { ...fallback, keyInfoCredits: 1 } };
    reopen(extra);
    const normal = respond;
    let left = 10;
    respond = (url, res) => url.pathname === '/v1/key/info' ? res.end(JSON.stringify({ status: { error_code: 0, credit_count: 1 }, data: {
      plan: { credit_limit_monthly: 20, credit_limit_monthly_reset_timestamp: fallback.resetAt, rate_limit_minute: 1000 },
      usage: { current_month: { credits_used: 20 - left, credits_left: left }, current_minute: { requests_made: 1, requests_left: 999 } }
    } })) : normal(url, res);
    await add(1); left = 2; reopen(extra);
    expect((await api('get', '/api/prices')).status).toBe(200);
    expect((await api('get', '/api/prices')).status).toBe(200);
    expect((await api('get', '/api/prices')).status).toBe(502);
    expect(calls.filter(url => url === '/v1/key/info')).toHaveLength(2);
    expect((await api('get', '/api/cryptocurrencies/1/history')).body).toHaveLength(3);
  });
  test('unknown quotas deny external calls while local reads remain available', async () => {
    expect((await add(1)).status).toBe(502);
    expect((await api('get', '/api/tracked-cryptocurrencies')).body).toEqual([]);
    expect(calls).toEqual([]);
  });
});
