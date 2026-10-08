import fs from 'node:fs';
import path from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-dist';
import { openapi } from './openapi';
import { sendError } from './error-response';

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cryptocurrency tracking API</title><link rel="stylesheet" href="/docs/assets/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="/docs/assets/swagger-ui-bundle.js"></script>
<script src="/docs/assets/swagger-ui-standalone-preset.js"></script>
<script>SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui',
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset], layout: 'StandaloneLayout',
  validatorUrl: null, persistAuthorization: false });</script></body></html>`;

const assets = ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js'];

export function registerDocumentation(app: Express): void {
  app.use(['/openapi.json', '/docs'], (request: Request, response: Response, next: NextFunction) => {
    if (Object.keys(request.query).length) {
      sendError(response, 400, 'INVALID_QUERY', 'Query parameters are invalid');
      return;
    }
    next();
  });
  app.get('/openapi.json', (_request: Request, response: Response) => { response.json(openapi); });
  app.get('/docs', (_request: Request, response: Response) => { response.type('html').send(html); });
  app.get('/docs/assets/:asset', (request: Request, response: Response, next: NextFunction) => {
    const asset = request.params.asset as string;
    if (!assets.includes(asset)) { next(); return; }
    const file = path.join(swaggerUi.getAbsoluteFSPath(), asset);
    response.type(asset.endsWith('.css') ? 'css' : 'js').send(fs.readFileSync(file));
  });
}
