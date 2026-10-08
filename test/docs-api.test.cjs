const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { createApplication } = require('../dist/app');
const TOKEN = 'docs-test-client-secret';
const KEY = 'docs-test-provider-secret';
let directory, application;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evercode-docs-'));
  application = createApplication({ apiToken: TOKEN, coinMarketCapApiKey: KEY,
    databasePath: path.join(directory, 'test.sqlite'), coinMarketCapTimeoutMs: 100 });
});
afterEach(async () => { await application.close(); fs.rmSync(directory, { recursive: true, force: true }); });

const docsRoutes = ['/openapi.json', '/docs', '/docs/assets/swagger-ui.css', '/docs/assets/swagger-ui-bundle.js', '/docs/assets/swagger-ui-standalone-preset.js'];

test.each(docsRoutes)('returns complete resources for Range and documented bodyless 304 for matching ETag at %s', async route => {
  const first = await request(application.app).get(route);
  const range = await request(application.app).get(route).set('Range', 'bytes=0-5');
  expect(range.status).toBe(200); expect(range.text).toBe(first.text);
  const cached = await request(application.app).get(route).set('If-None-Match', first.headers.etag);
  expect(cached.status).toBe(304); expect(cached.text).toBe('');
  const spec = (await request(application.app).get('/openapi.json')).body;
  const publishedPath = route.startsWith('/docs/assets/') ? '/docs/assets/{asset}' : route;
  expect(spec.paths[publishedPath].get.responses['304']).toEqual({ description: 'Matching If-None-Match ETag; no response body.' });
});

test.each(docsRoutes)('rejects unsupported query at %s', async route => {
  const response = await request(application.app).get(`${route}?token=${TOKEN}`);
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe('INVALID_QUERY');
  expect(response.text).not.toContain(TOKEN);
});

test.each(docsRoutes)('supports bodyless HEAD and rejects unsupported method at %s', async route => {
  const head = await request(application.app).head(route);
  expect(head.status).toBe(200);
  expect(head.text).toBeUndefined();
  expect((await request(application.app).head(`${route}?x=1`)).status).toBe(400);
  expect((await request(application.app).post(route)).body.error.code).toBe('NOT_FOUND');
});

test.each(docsRoutes)('refuses new docs requests during STOPPING at %s', async route => {
  await application.close();
  const response = await request(application.app).get(route);
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ error: { code: 'STOPPING', message: 'Service is stopping' } });
});

test.each([
  ['swagger-ui.css', 'text/css', '.swagger-ui'],
  ['swagger-ui-bundle.js', 'text/javascript', 'SwaggerUIBundle'],
  ['swagger-ui-standalone-preset.js', 'text/javascript', 'SwaggerUIStandalonePreset'],
])('serves the local asset %s', async (asset, type, marker) => {
  const response = await request(application.app).get(`/docs/assets/${asset}`);
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toContain(type);
  expect(response.text).toContain(marker);
  for (const secret of [TOKEN, KEY]) expect(response.text).not.toContain(secret);
});

test.each(['swagger-initializer.js', 'missing.js', 'package.json', '..%2F..%2Fpackage.json'])('does not publish asset %s', async asset => {
  const response = await request(application.app).get(`/docs/assets/${asset}`);
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Resource not found' } });
});

test('serves local Swagger with manual Authorize and no external validator', async () => {
  const response = await request(application.app).get('/docs');
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toContain('text/html');
  expect(response.text).toContain('validatorUrl: null');
  expect(response.text).toContain("url: '/openapi.json'");
  expect(response.text).toContain('persistAuthorization: false');
  expect(response.text).not.toMatch(/https?:\/\//);
  expect(response.text).not.toMatch(/preauthorize|authActions|petstore/);
  for (const secret of [TOKEN, KEY]) expect(response.text).not.toContain(secret);
});

test('publishes OpenAPI 3.0 without authentication or configured secrets', async () => {
  const response = await request(application.app).get('/openapi.json');
  expect(response.status).toBe(200);
  expect(response.body.openapi).toBe('3.0.3');
  expect(response.body.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
  expect(response.body.paths['/api/tracked-cryptocurrencies'].post.responses['201']).toBeDefined();
  expect(response.body.paths['/api/cryptocurrencies/{cmcId}/history'].get).toBeDefined();
  for (const secret of [TOKEN, KEY]) expect(response.text).not.toContain(secret);
});
