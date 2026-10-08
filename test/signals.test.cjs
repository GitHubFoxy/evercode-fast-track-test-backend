const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { createApplication } = require('../dist/app');
const quota = require('./fake-quota.cjs');
const bounded = (promise, ms = 15000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('child deadline exceeded')), ms); })])
    .finally(() => clearTimeout(timer));
};

test.each([['SIGINT', 'quotes'], ['SIGTERM', 'quotes'], ['SIGINT', 'key-info'], ['SIGTERM', 'key-info']])('%s cancels active %s and exits without new requests', async (signal, phase) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evercode-signal-'));
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let entered, child, outgoing, reopened;
  const arrived = new Promise(resolve => { entered = resolve; });
  const calls = [];
  const provider = http.createServer((req, res) => {
    calls.push(req.url);
    if (req.url === '/v1/key/info' && phase === 'quotes') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: { error_code: 0, credit_count: 1 }, data: {
        plan: { credit_limit_monthly: 100000, credit_limit_monthly_reset_timestamp: quota.resetAt, rate_limit_minute: 100000 },
        usage: { current_month: { credits_used: 1, credits_left: 99999 }, current_minute: { requests_made: 1, requests_left: 99999 } }
      } }));
    } else entered(); // Deliberately held until shutdown aborts the socket.
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  try {
    child = spawn(process.execPath, ['dist/main.js'], { cwd: path.join(__dirname, '..'), env: {
      API_TOKEN: 'fake-client', COINMARKETCAP_API_KEY: 'fake-provider', DATABASE_PATH: path.join(dir, 'db.sqlite'), PORT: String(port),
      CMC_BASE_URL: `http://127.0.0.1:${provider.address().port}`, CMC_TIMEOUT_MS: '10000', SHUTDOWN_TIMEOUT_MS: '500',
      CMC_MONTHLY_LIMIT: '100000', CMC_CREDITS_LEFT: '100000', CMC_RESET_AT: quota.resetAt,
      CMC_RATE_LIMIT_MINUTE: '100000', CMC_REQUESTS_LEFT: '100000', CMC_KEY_INFO_CREDITS: '1'
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, killed) => resolve({ code, killed })));
    await bounded(new Promise((resolve, reject) => {
      child.stdout.on('data', chunk => { if (String(chunk).includes('HTTP server listening')) resolve(); });
      child.once('exit', () => reject(new Error(output || 'child exited before startup')));
      child.once('error', reject);
    }));
    const response = new Promise(resolve => {
      outgoing = http.request({ hostname: '127.0.0.1', port, path: '/api/tracked-cryptocurrencies', method: 'POST',
        headers: { authorization: 'Bearer fake-client', 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', resolve); });
      outgoing.on('error', resolve); outgoing.end('{"cmcId":1}');
    });
    await bounded(arrived);
    const count = calls.length;
    child.kill(signal); child.kill(signal);
    expect(await bounded(exited)).toEqual({ code: 0, killed: null });
    await bounded(response);
    expect(calls).toHaveLength(count);
    reopened = createApplication({ apiToken: 'fake-client', coinMarketCapApiKey: 'fake-provider', coinMarketCapTimeoutMs: 100,
      databasePath: path.join(dir, 'db.sqlite') });
    expect((await request(reopened.app).get('/api/tracked-cryptocurrencies').set('Authorization', 'Bearer fake-client')).body).toEqual([]);
  } finally {
    outgoing?.destroy(); await reopened?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await bounded(new Promise(resolve => child.once('exit', resolve)));
    }
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 45000);
