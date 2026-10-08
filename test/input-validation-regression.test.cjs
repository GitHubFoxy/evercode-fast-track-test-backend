const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const database = require('../dist/database');
const { createApplication } = require('../dist/app');

const TOKEN = 'input-client-secret', KEY = 'input-provider-secret';
const TRACKING = '/api/tracked-cryptocurrencies';
let directory, application;
const call = (method, route) => request(application.app)[method](route).set('Authorization', `Bearer ${TOKEN}`);

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evercode-input-'));
  application = createApplication({ apiToken: TOKEN, coinMarketCapApiKey: KEY,
    databasePath: path.join(directory, 'test.sqlite'), coinMarketCapTimeoutMs: 50,
    coinMarketCapBaseUrl: 'http://127.0.0.1:1', quota: require('./fake-quota.cjs') });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await application.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function safeFailure(response, status, code, message) {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ error: { code, message } });
  for (const secret of [TOKEN, KEY, 'private-error-detail']) expect(response.text).not.toContain(secret);
}

test.each([
  ['post', TRACKING], ['put', `${TRACKING}/1`], ['get', '/openapi.json'],
  ['get', '/docs'], ['get', '/docs/assets/swagger-ui.css'],
])('%s %s rejects unsupported encoding and charset without reflecting input', async (method, route) => {
  safeFailure(await call(method, route).set('Content-Type', 'application/json')
    .set('Content-Encoding', 'private-error-detail').send('{}'),
  415, 'UNSUPPORTED_ENCODING', 'Request body encoding is not supported');
  safeFailure(await call(method, route).set('Content-Type', 'application/json; charset=iso-8859-1').send('{}'),
    415, 'UNSUPPORTED_CHARSET', 'JSON body charset is not supported');
  safeFailure(await call(method, route).set('Content-Type', 'application/json; charset=utf-unsupported').send('{}'),
    415, 'UNSUPPORTED_CHARSET', 'JSON body charset is not supported');
  expect((await call('get', TRACKING)).body).toEqual([]);
});

test.each([
  ['get', `${TRACKING}/%ZZ`], ['put', `${TRACKING}/%ZZ`], ['delete', `${TRACKING}/%ZZ`],
  ['get', `${TRACKING}/%E0%A4%A/price`], ['get', '/api/cryptocurrencies/%ZZ/history'],
  ['get', '/docs/assets/%ZZ'],
])('%s %s rejects malformed path encoding with a safe client error', async (method, route) => {
  safeFailure(await call(method, route), 400, 'INVALID_PATH', 'Path parameter encoding is invalid');
});

test('HEAD preserves the status and omits the error body for malformed path encoding', async () => {
  const response = await call('head', `${TRACKING}/%ZZ`);
  expect(response.status).toBe(400);
  expect(response.text || '').toBe('');
});

test('authentication precedes parser and path errors under /api', async () => {
  const response = await request(application.app).post(`${TRACKING}/%ZZ`)
    .set('Content-Type', 'application/json').set('Content-Encoding', 'unknown').send('{}');
  safeFailure(response, 401, 'UNAUTHORIZED', 'Authentication required');
});

test.each([
  ['ordinary failure', new Error('private-error-detail')],
  ['arbitrary status', Object.assign(new Error('private-error-detail'), { status: 415 })],
  ['unrecognized parser type', Object.assign(new Error('private-error-detail'), { status: 400, type: 'stream.not.readable' })],
  ['wrong status for known parser type', Object.assign(new Error('private-error-detail'), { status: 500, type: 'charset.unsupported' })],
  ['plain object resembling parser error', { status: 415, type: 'encoding.unsupported', message: 'private-error-detail' }],
  ['internal SyntaxError', Object.assign(new SyntaxError('private-error-detail'), { status: 400, body: KEY })],
  ['internal URIError', Object.assign(new URIError('private-error-detail'), { status: 400 })],
])('preserves safe 500 for %s', async (_name, error) => {
  jest.spyOn(database, 'listTrackedCryptocurrencies').mockImplementation(() => { throw error; });
  safeFailure(await call('get', TRACKING), 500, 'INTERNAL_ERROR', 'An internal error occurred');
});

test('malformed JSON and oversized bodies keep their established safe errors', async () => {
  safeFailure(await call('post', TRACKING).set('Content-Type', 'application/json').send('{'),
    400, 'INVALID_JSON', 'Request body must contain valid JSON');
  safeFailure(await call('post', TRACKING).send({ cmcId: 1, extra: 'x'.repeat(17000) }),
    413, 'PAYLOAD_TOO_LARGE', 'JSON body exceeds 16 KiB');
});

test('OpenAPI publishes parser and path errors for every documented operation', async () => {
  const spec = (await request(application.app).get('/openapi.json')).body;
  for (const item of Object.values(spec.paths)) for (const [method, operation] of Object.entries(item)) {
    const unsupported = operation.responses['415'];
    expect(unsupported).toBeDefined();
    if (method === 'head') continue;
    expect(unsupported.content['application/json'].schema.properties.error.properties.code.enum)
      .toEqual(['UNSUPPORTED_ENCODING', 'UNSUPPORTED_CHARSET']);
    expect(operation.responses['400'].content['application/json'].schema.properties.error.properties.code.enum)
      .toContain('INVALID_PATH');
  }
});
