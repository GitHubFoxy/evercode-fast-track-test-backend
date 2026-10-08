const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cryptocurrency tracking API</title><link rel="stylesheet" href="/docs/assets/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="/docs/assets/swagger-ui-bundle.js"></script>
<script src="/docs/assets/swagger-ui-standalone-preset.js"></script>
<script>SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui',
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset], layout: 'StandaloneLayout',
  validatorUrl: null, persistAuthorization: false });</script></body></html>`;

export function registerDocumentation(app: any): void {
  app.use(['/openapi.json', '/docs'], (request: any, response: any, next: any) => {
    if (Object.keys(request.query).length) {
      response.status(400).json({ error: { code: 'INVALID_QUERY', message: 'Query parameters are invalid' } });
      return;
    }
    next();
  });
  app.get('/openapi.json', (_request: any, response: any) => response.json(require('./openapi').openapi));
  app.get('/docs', (_request: any, response: any) => response.type('html').send(html));
  const assets = ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js'];
  app.get('/docs/assets/:asset', (request: any, response: any, next: any) => {
    if (!assets.includes(request.params.asset)) { next(); return; }
    const file = require('node:path').join(require('swagger-ui-dist').getAbsoluteFSPath(), request.params.asset);
    response.type(request.params.asset.endsWith('.css') ? 'css' : 'js').send(require('node:fs').readFileSync(file));
  });
}
