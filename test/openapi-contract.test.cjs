const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('./http-server.cjs');
const request = require('supertest');
const { createApplication } = require('../dist/app');
const TOKEN = 'contract-client-secret', KEY = 'contract-provider-secret';
const TRACKING = '/api/tracked-cryptocurrencies';
const timestamp = '2025-01-15T12:00:00.000Z';
let directory, application, server, spec, mode, release, entered;
const call = (method, route) => request(application.app)[method](route).set('Authorization', `Bearer ${TOKEN}`);
beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evercode-contract-'));
  mode = 'ok';
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (mode === 'timeout') return;
    if (mode === 'failure') { res.writeHead(503); res.end(JSON.stringify({ secret: KEY })); return; }
    const url = new URL(req.url, 'http://localhost');
    const ids = url.searchParams.get('id').split(',').map(Number);
    const payload = JSON.stringify({ status: { error_code: 0, credit_count: 1 }, data: ids.filter(id => id !== 999).map(id => ({
      id, name: `Coin ${id}`, symbol: `C${id}`, last_updated: timestamp,
      quote: [{ symbol: 'USD', price: 42, last_updated: timestamp }],
    })) });
    if (mode === 'hold') { release = () => res.end(payload); entered(); }
    else res.end(payload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  application = createApplication({ apiToken: TOKEN, coinMarketCapApiKey: KEY,
    databasePath: path.join(directory, 'test.sqlite'), coinMarketCapTimeoutMs: 50,
    coinMarketCapBaseUrl: `http://127.0.0.1:${server.address().port}`, quota: require('./fake-quota.cjs') });
  spec = (await request(application.app).get('/openapi.json')).body;
});
afterEach(async () => {
  await application.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true });
});

// Assertions use only the schema keywords this explicit contract publishes; no validator dependency.
function matchesSchema(value, schema) {
  if (schema.$ref) schema = spec.components.schemas[schema.$ref.split('/').pop()];
  if (value === null) { expect(schema.nullable).toBe(true); return; }
  if (schema.enum) expect(schema.enum).toContain(value);
  if (schema.type === 'array') { expect(Array.isArray(value)).toBe(true); value.forEach(item => matchesSchema(item, schema.items)); }
  else if (schema.type === 'object') {
    expect(typeof value).toBe('object'); expect(Array.isArray(value)).toBe(false);
    for (const key of schema.required || []) expect(value).toHaveProperty(key);
    if (schema.additionalProperties === false) expect(Object.keys(value).sort()).toEqual(Object.keys(schema.properties).sort());
    for (const [key, item] of Object.entries(value)) if (schema.properties?.[key]) matchesSchema(item, schema.properties[key]);
  } else if (schema.type === 'integer') { expect(Number.isSafeInteger(value)).toBe(true); }
  else if (schema.type) expect(typeof value).toBe(schema.type);
  if (schema.minimum !== undefined) expect(value).toBeGreaterThanOrEqual(schema.minimum);
  if (schema.maximum !== undefined) expect(value).toBeLessThanOrEqual(schema.maximum);
  if (schema.format === 'date-time') expect(Number.isFinite(Date.parse(value))).toBe(true);
}
function documented(response, route, method, status) {
  expect(response.status).toBe(status);
  const operation = spec.paths[route][method];
  const published = operation.responses[String(status)];
  expect(published).toBeDefined();
  if (status === 204 || method === 'head') { expect(published.content).toBeUndefined(); expect(response.text || '').toBe(''); }
  else { expect(response.headers['content-type']).toContain('application/json'); matchesSchema(response.body, published.content['application/json'].schema); }
  for (const secret of [TOKEN, KEY]) expect(response.text || '').not.toContain(secret);
}
const operations = [
  ['get', TRACKING, TRACKING], ['post', TRACKING, TRACKING],
  ['get', `${TRACKING}/1`, `${TRACKING}/{id}`], ['put', `${TRACKING}/1`, `${TRACKING}/{id}`],
  ['delete', `${TRACKING}/1`, `${TRACKING}/{id}`], ['get', `${TRACKING}/1/price`, `${TRACKING}/{id}/price`],
  ['get', '/api/prices', '/api/prices'], ['get', '/api/cryptocurrencies/1/history', '/api/cryptocurrencies/{cmcId}/history'],
];

test('documents all API operations with separate Bearer and exact pagination/time constraints', () => {
  expect(spec.security).toEqual([{ bearerAuth: [] }]);
  expect(spec.components.schemas.TrackedCryptocurrency.properties.lastUpdatedAt).toMatchObject({ type: 'string', format: 'date-time', nullable: true });
  expect(spec.components.schemas.Quote.properties.providerUpdatedAt.nullable).not.toBe(true);
  const history = spec.paths['/api/cryptocurrencies/{cmcId}/history'].get.parameters;
  expect(history.map(p => p.name)).toEqual(['cmcId', 'limit', 'offset', 'from', 'to']);
  expect(history.find(p => p.name === 'limit').schema).toEqual({ type: 'integer', minimum: 1, maximum: 100, default: 50 });
  expect(history.find(p => p.name === 'offset').schema).toEqual({ type: 'integer', minimum: 0, maximum: 9007199254740991, default: 0 });
  expect(history.find(p => p.name === 'from').schema.format).toBe('date-time');
  expect(history.find(p => p.name === 'to').description).toContain('from must be <= to');
  expect(spec.paths[TRACKING].post.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/TrackingInput');
  expect(spec.components.schemas.TrackingInput.additionalProperties).toBe(false);
});

test('successful CRUD, price and history responses match the HTTP-published schema', async () => {
  documented(await call('get', TRACKING), TRACKING, 'get', 200);
  documented(await call('post', TRACKING).send({ cmcId: 1 }), TRACKING, 'post', 201);
  documented(await call('get', `${TRACKING}/1`), `${TRACKING}/{id}`, 'get', 200);
  const fresh = await call('get', `${TRACKING}/1/price`);
  documented(fresh, `${TRACKING}/{id}/price`, 'get', 200);
  expect(fresh.body).toMatchObject({ cmcId: 1, price: 42, currency: 'USD', providerUpdatedAt: timestamp });
  documented(await call('get', '/api/prices'), '/api/prices', 'get', 200);
  const bound = encodeURIComponent(fresh.body.fetchedAt);
  const history = await call('get', `/api/cryptocurrencies/1/history?from=${bound}&to=${bound}&limit=1&offset=0`);
  documented(history, '/api/cryptocurrencies/{cmcId}/history', 'get', 200);
  expect(history.body.length).toBe(1);
  documented(await call('put', `${TRACKING}/1`).send({ cmcId: 2 }), `${TRACKING}/{id}`, 'put', 200);
  documented(await call('delete', `${TRACKING}/1`), `${TRACKING}/{id}`, 'delete', 204);
  documented(await call('get', '/api/cryptocurrencies/1/history'), '/api/cryptocurrencies/{cmcId}/history', 'get', 200);
});

test.each(operations)('%s %s protects data for missing/wrong/malformed Bearer and stops after close', async (method, url, route) => {
  for (const header of [undefined, 'Bearer wrong', `Basic ${TOKEN}`]) {
    let req = request(application.app)[method](url);
    if (header) req = req.set('Authorization', header);
    documented(await req, route, method, 401);
  }
  await application.close();
  documented(await call(method, url), route, method, 503);
});

test.each(operations.filter(([method]) => method === 'get'))('HEAD %s has positive and negative bodyless contracts', async (_method, url, route) => {
  await call('post', TRACKING).send({ cmcId: 1 });
  documented(await call('head', url), route, 'head', 200);
  documented(await request(application.app).head(url), route, 'head', 401);
});

test.each([
  ['get', `${TRACKING}?limit=0`, TRACKING, 400, 'INVALID_QUERY'],
  ['get', `${TRACKING}/01`, `${TRACKING}/{id}`, 400, 'INVALID_TRACKING_ID'],
  ['get', `${TRACKING}/77`, `${TRACKING}/{id}`, 404, 'TRACKING_NOT_FOUND'],
  ['delete', `${TRACKING}/77`, `${TRACKING}/{id}`, 404, 'TRACKING_NOT_FOUND'],
  ['get', `${TRACKING}/77/price`, `${TRACKING}/{id}/price`, 404, 'TRACKING_NOT_FOUND'],
  ['get', '/api/prices?offset=1', '/api/prices', 400, 'INVALID_QUERY'],
  ['get', '/api/cryptocurrencies/77/history', '/api/cryptocurrencies/{cmcId}/history', 404, 'CRYPTOCURRENCY_NOT_FOUND'],
  ['get', '/api/cryptocurrencies/0/history', '/api/cryptocurrencies/{cmcId}/history', 400, 'INVALID_CMC_ID'],
  ['get', '/api/cryptocurrencies/1/history?from=2025-02-31T00:00:00Z', '/api/cryptocurrencies/{cmcId}/history', 400, 'INVALID_QUERY'],
])('documents negative response %s %s', async (method, url, route, status, code) => {
  const response = await call(method, url); documented(response, route, method, status); expect(response.body.error.code).toBe(code);
});

test.each(operations.filter(([method]) => ['get', 'delete'].includes(method)))('documents unsupported body for %s %s', async (method, url, route) => {
  await call('post', TRACKING).send({ cmcId: 1 });
  const response = await call(method, url).send({ price: 999, enabled: true });
  documented(response, route, method, 400);
  expect(response.body.error.code).toBe('INVALID_BODY');
  expect(spec.paths[route][method].requestBody).toBeUndefined();
});

test('documents duplicate, invalid body, unknown CMC ID and invalid JSON failures', async () => {
  await call('post', TRACKING).send({ cmcId: 1 });
  const duplicate = await call('post', TRACKING).send({ cmcId: 1 });
  documented(duplicate, TRACKING, 'post', 409); expect(duplicate.body.error.code).toBe('ALREADY_TRACKED');
  for (const [method, url, route] of [operations[1], operations[3]]) {
    documented(await call(method, url).send({ cmcId: '1' }), route, method, 400);
    const unknown = await call(method, url).send({ cmcId: 999 });
    documented(unknown, route, method, 400); expect(unknown.body.error.code).toBe('CMC_ID_NOT_FOUND');
    const malformed = await call(method, url).set('Content-Type', 'application/json').send('{');
    documented(malformed, route, method, 400); expect(malformed.body.error.code).toBe('INVALID_JSON');
  }
});

test.each(['failure', 'timeout'])('documents %s provider failures without secret leakage', async failure => {
  await call('post', TRACKING).send({ cmcId: 1 }); mode = failure;
  for (const [method, url, route] of [operations[1], operations[3], operations[5], operations[6]]) {
    const req = call(method, url);
    documented(await (method === 'get' ? req : req.send({ cmcId: 2 })), route, method, failure === 'timeout' ? 504 : 502);
  }
});

test.each([operations[3], operations[5], operations[6]])('documents tracking conflict for %s %s without appending stale history', async (method, url, route) => {
  await call('post', TRACKING).send({ cmcId: 1 });
  mode = 'hold';
  const started = new Promise(resolve => { entered = resolve; });
  let req = call(method, url); if (method === 'put') req = req.send({ cmcId: 2 });
  const pending = req.then(response => response);
  await started;
  const before = (await call('get', '/api/cryptocurrencies/1/history')).body;
  await call('delete', `${TRACKING}/1`);
  release();
  const response = await pending; documented(response, route, method, 409);
  expect(response.body.error.code).toBe('TRACKING_CHANGED');
  expect((await call('get', '/api/cryptocurrencies/1/history')).body).toEqual(before);
});

test('reads a migrated catalog coin without observations as null timestamp and empty history', async () => {
  await application.close();
  // Arrange an on-disk legacy fixture, not a side channel for verifying writes.
  const db = new (require('../dist/database').SqliteDatabase)(path.join(directory, 'test.sqlite'));
  db.exec("INSERT INTO cryptocurrencies(id,cmc_id,symbol,name) VALUES(1,1,'BTC','Bitcoin'); INSERT INTO tracked_cryptocurrencies(cryptocurrency_id) VALUES(1)"); db.close();
  application = createApplication({ apiToken: TOKEN, coinMarketCapApiKey: KEY, databasePath: path.join(directory, 'test.sqlite'), coinMarketCapTimeoutMs: 50 });
  const response = await call('get', `${TRACKING}/1`); documented(response, `${TRACKING}/{id}`, 'get', 200);
  expect(response.body.lastUpdatedAt).toBeNull();
  const history = await call('get', '/api/cryptocurrencies/1/history'); documented(history, '/api/cryptocurrencies/{cmcId}/history', 'get', 200);
  expect(history.body).toEqual([]);
});

test('unknown routes/methods return safe 404 and unsupported parser encoding returns documented 415', async () => {
  for (const [method, url] of [['get', '/missing'], ['patch', TRACKING]]) {
    const response = await call(method, url); expect(response.status).toBe(404);
    matchesSchema(response.body, spec.components.schemas.Error); expect(response.body.error.code).toBe('NOT_FOUND');
  }
  const response = await call('post', TRACKING).set('Content-Type', 'application/json').set('Content-Encoding', 'unknown').send('{}');
  documented(response, TRACKING, 'post', 415); expect(response.body.error.code).toBe('UNSUPPORTED_ENCODING');
});

test.each(['post', 'put', 'delete'])('rejects unsupported query fields for %s mutations', async method => {
  const route = method === 'post' ? TRACKING : `${TRACKING}/1`;
  const response = await call(method, `${route}?unexpected=1`).send({ cmcId: 1 });
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('INVALID_QUERY');
});

test('returns a safe documented 413 for oversized JSON', async () => {
  const response = await call('post', TRACKING).send({ cmcId: 1, extra: 'x'.repeat(17000) });
  expect(response.status).toBe(413);
  expect(response.body).toEqual({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'JSON body exceeds 16 KiB' } });
});
