const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: any) => ({ 'application/json': { schema } });
const array = (name: string) => ({ type: 'array', items: ref(name) });
const id = { type: 'integer', minimum: 1, maximum: 9007199254740991 };
const timestamp = { type: 'string', format: 'date-time' };
const error = (description: string, codes: string[]) => ({ description,
  content: json({ type: 'object', additionalProperties: false, required: ['error'], properties: {
    error: { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: {
      code: { type: 'string', enum: codes }, message: { type: 'string', description: 'Safe message; no SQL, stack, credentials or raw provider response.' },
    } },
  } }) });
const common = {
  '401': error('Missing, incorrect or malformed Authorization. Exact format: Bearer <API_TOKEN>.', ['UNAUTHORIZED']),
  '413': error('JSON body exceeds 16 KiB.', ['PAYLOAD_TOO_LARGE']),
  '500': error('Unexpected internal failure.', ['INTERNAL_ERROR']),
  '503': error('Shutdown has started; no new operations.', ['STOPPING']),
};
const provider = {
  '502': error('Provider failure, invalid/incomplete response, unavailable or unconfirmed shared quota. No stored-price fallback.', ['CMC_API_ERROR']),
  '504': error('Provider request timeout.', ['CMC_TIMEOUT']),
};
const conflict = error('Duplicate cryptocurrency or tracking snapshot changed during request.', ['ALREADY_TRACKED', 'TRACKING_CHANGED']);
const missingTracking = error('Unknown local tracking record.', ['TRACKING_NOT_FOUND']);
const bad = (...codes: string[]) => error('Invalid input; unsupported fields, repeated/structured query values and malformed JSON are rejected.', [...codes, 'INVALID_JSON']);
const success = (schema: any, description = 'Success') => ({ description, content: json(schema) });
const pathId = (name: string, description: string) => ({ name, in: 'path', required: true, description: `${description} Decimal digits without leading zero; positive safe integer.`, schema: id });
const page = [
  { name: 'limit', in: 'query', description: 'Decimal integer; default 50. Unknown query fields are rejected.', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
  { name: 'offset', in: 'query', description: 'Decimal nonnegative safe integer; default 0.', schema: { type: 'integer', minimum: 0, maximum: 9007199254740991, default: 0 } },
];
const body = { required: true, content: json(ref('TrackingInput')) };
const operation = (summary: string, responses: any, parameters: any[] = [], requestBody?: any) => ({ summary,
  parameters, ...(requestBody ? { requestBody } : {}), responses: { ...common, ...responses } });
const publicOperation = (summary: string, content: any) => ({ summary, security: [], responses: {
  '200': { description: 'Public documentation; no configured credentials.', content },
  '400': bad('INVALID_QUERY'), '404': error('Unknown resource or unsupported method.', ['NOT_FOUND']),
  '413': common['413'], '500': common['500'], '503': common['503'],
} });

export const openapi: any = {
  openapi: '3.0.3',
  info: { title: 'Cryptocurrency tracking API', version: '1.0.0', description:
    'Single-process USD service. All /api routes require a separate service Bearer token. IDs of tracking records, cryptocurrencies (CMC) and observations are distinct. Unknown paths/methods return 404 NOT_FOUND (401 first under /api without valid authorization). All routes may return 503 STOPPING during shutdown. GET routes also support HEAD with the same status and headers but no body. Express accepts a trailing slash. No health endpoint. JSON body limit: 16 KiB. No manual price/history mutation.' },
  servers: [{ url: '/' }],
  security: [{ bearerAuth: [] }],
  paths: {
    '/api/tracked-cryptocurrencies': {
      get: operation('List tracking records in ascending tracking ID order; bare array.', {
        '200': success(array('TrackedCryptocurrency')), '400': bad('INVALID_QUERY'),
      }, page),
      post: operation('Validate CMC ID with a new USD quote, create tracking and save initial history atomically.', {
        '201': success(ref('TrackedCryptocurrency'), 'Created'), '400': bad('INVALID_CMC_ID', 'CMC_ID_NOT_FOUND', 'INVALID_QUERY'),
        '409': error('Cryptocurrency is already tracked.', ['ALREADY_TRACKED']), ...provider,
      }, [], body),
    },
    '/api/tracked-cryptocurrencies/{id}': {
      get: operation('Read a tracking record. No query parameters.', {
        '200': success(ref('TrackedCryptocurrency')), '400': bad('INVALID_TRACKING_ID', 'INVALID_QUERY'), '404': missingTracking,
      }, [pathId('id', 'Tracking record ID, not CMC ID.')]),
      put: operation('Replace cryptocurrency; keep tracking ID and old cryptocurrency history. Same-coin PUT also fetches a new quote. No query parameters.', {
        '200': success(ref('TrackedCryptocurrency')), '400': bad('INVALID_TRACKING_ID', 'INVALID_CMC_ID', 'CMC_ID_NOT_FOUND', 'INVALID_QUERY'),
        '404': missingTracking, '409': conflict, ...provider,
      }, [pathId('id', 'Tracking record ID.')], body),
      delete: operation('Delete only tracking; retain cryptocurrency and history. No query parameters.', {
        '204': { description: 'Deleted; no response body.' }, '400': bad('INVALID_TRACKING_ID', 'INVALID_QUERY'), '404': missingTracking,
      }, [pathId('id', 'Tracking record ID.')]),
    },
    '/api/tracked-cryptocurrencies/{id}/price': {
      get: operation('Fetch a new USD quote, save history and update lastUpdatedAt. No query parameters or stored-price fallback.', {
        '200': success(ref('Quote')), '400': bad('INVALID_TRACKING_ID', 'INVALID_QUERY'), '404': missingTracking,
        '409': error('Tracking changed during provider request; nothing saved.', ['TRACKING_CHANGED']), ...provider,
      }, [pathId('id', 'Tracking record ID.')]),
    },
    '/api/prices': {
      get: operation('Fetch and atomically save the complete tracking list. Empty list returns [] without provider I/O. No pagination or query parameters.', {
        '200': success(array('Quote')), '400': bad('INVALID_QUERY'),
        '409': error('Tracking changed during provider request; nothing saved.', ['TRACKING_CHANGED']), ...provider,
      }),
    },
    '/api/cryptocurrencies/{cmcId}/history': {
      get: operation('Read local history even after tracking deletion or provider failure. Inclusive fetchedAt boundaries, ascending fetchedAt then observation ID; bare array. Known cryptocurrency without observations returns [].', {
        '200': success(array('Quote')), '400': bad('INVALID_CMC_ID', 'INVALID_QUERY'),
        '404': error('Cryptocurrency is absent from the local catalog.', ['CRYPTOCURRENCY_NOT_FOUND']),
      }, [pathId('cmcId', 'CoinMarketCap ID, not tracking ID.'), ...page,
        ...['from', 'to'].map(name => ({ name, in: 'query', schema: timestamp,
          description: 'Calendar-valid ISO 8601 with seconds and mandatory Z or ±HH:MM; inclusive fetchedAt boundary. from must be <= to.' })),
      ]),
    },
    '/openapi.json': { get: publicOperation('OpenAPI 3.0 specification. No query parameters.', json({ type: 'object', description: 'OpenAPI 3.0.3 document.' })) },
    '/docs': { get: publicOperation('Local Swagger UI; enter your service token in Authorize. No query parameters, persisted authorization, CDN or remote validator.', {
      'text/html': { schema: { type: 'string' } },
    }) },
    '/docs/assets/{asset}': { get: { ...publicOperation('Allowlisted local Swagger assets. Unknown assets return JSON 404. No query parameters.', {
      'text/css': { schema: { type: 'string' } }, 'text/javascript': { schema: { type: 'string' } },
    }), parameters: [{ name: 'asset', in: 'path', required: true, schema: { type: 'string', enum: ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js'] } }] } },
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: {
      TrackingInput: { type: 'object', additionalProperties: false, required: ['cmcId'], properties: { cmcId: id } },
      TrackedCryptocurrency: { type: 'object', additionalProperties: false,
        required: ['id', 'cmcId', 'symbol', 'name', 'lastUpdatedAt'], properties: {
          id: { ...id, description: 'Tracking record ID.' }, cmcId: id, symbol: { type: 'string' }, name: { type: 'string' },
          lastUpdatedAt: { ...timestamp, nullable: true, description: 'UTC time of last successful fetch, or null if there are no observations.' },
        } },
      Quote: { type: 'object', additionalProperties: false,
        required: ['id', 'cmcId', 'symbol', 'name', 'price', 'currency', 'fetchedAt', 'providerUpdatedAt'], properties: {
          id: { ...id, description: 'History observation ID, not tracking ID.' }, cmcId: id,
          symbol: { type: 'string' }, name: { type: 'string' }, price: { type: 'number', minimum: 0 },
          currency: { type: 'string', enum: ['USD'] }, fetchedAt: { ...timestamp, description: 'UTC time fetched by this service.' },
          providerUpdatedAt: { ...timestamp, description: 'USD quote timestamp at provider; may have an explicit timezone offset.' },
        } },
      Error: { type: 'object', additionalProperties: false, required: ['error'], properties: {
        error: { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: {
          code: { type: 'string', enum: ['UNAUTHORIZED', 'INVALID_JSON', 'INVALID_QUERY', 'INVALID_CMC_ID', 'INVALID_TRACKING_ID', 'CMC_ID_NOT_FOUND', 'ALREADY_TRACKED', 'TRACKING_CHANGED', 'TRACKING_NOT_FOUND', 'CRYPTOCURRENCY_NOT_FOUND', 'CMC_API_ERROR', 'CMC_TIMEOUT', 'PAYLOAD_TOO_LARGE', 'NOT_FOUND', 'INTERNAL_ERROR', 'STOPPING'] },
          message: { type: 'string' },
        } },
      } },
    },
  },
};
// Express provides HEAD for every GET. Publish its bodyless contract explicitly.
for (const path of Object.values(openapi.paths) as any[]) {
  if (path.get) {
    path.get.responses['304'] = { description: 'Matching If-None-Match ETag; no response body.' };
    path.head = { ...path.get, summary: `HEAD: ${path.get.summary}`,
      responses: Object.fromEntries(Object.entries(path.get.responses).map(([status, response]: [string, any]) => [status, { description: response.description }])) };
  }
}
