const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

// Public CLI check in a fresh temporary checkout; no host .env or dist is copied.
test('npm start builds a fresh checkout and serves protected HTTP without preexisting dist', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evercode-start-'));
  let child, exited, exitPromise, deadline;
  try {
    for (const name of ['package.json', 'tsconfig.json', 'src']) {
      fs.cpSync(path.join(__dirname, '..', name), path.join(directory, name), { recursive: true });
    }
    // npm ci is checked separately; reuse its installed dependencies to keep this CLI test offline.
    fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    expect(fs.existsSync(path.join(directory, 'dist'))).toBe(false);
    const reserved = http.createServer();
    await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
    const port = reserved.address().port;
    await new Promise(resolve => reserved.close(resolve));
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('CMC_') && !['API_TOKEN', 'COINMARKETCAP_API_KEY', 'DATABASE_PATH', 'PORT', 'PRICE_CURRENCY', 'SYNC_INTERVAL_MS', 'SHUTDOWN_TIMEOUT_MS'].includes(key)));
    let output = '';
    child = spawn(process.execPath, [process.env.npm_execpath, 'start'], {
      cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...environment, API_TOKEN: 'start-test-client-token', COINMARKETCAP_API_KEY: 'start-test-provider-key',
        DATABASE_PATH: path.join(directory, 'service.sqlite'), PORT: String(port) },
    });
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    exitPromise = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
    deadline = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 50000);
    const end = Date.now() + 45000;
    while (!output.includes('HTTP server listening') && !exited && Date.now() < end) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(output).toContain('HTTP server listening');
    expect(fs.existsSync(path.join(directory, 'dist', 'main.js'))).toBe(true);
    const get = headers => new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/tracked-cryptocurrencies`, { headers, timeout: 1000 }, res => {
        let body = ''; res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('timeout', () => req.destroy(new Error('HTTP deadline'))); req.on('error', reject);
    });
    expect(await get({ Authorization: 'Bearer start-test-client-token' })).toEqual({ status: 200, body: [] });
    expect((await get({})).status).toBe(401);
  } finally {
    if (child && !exited) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    if (exitPromise) await exitPromise;
    // Terminate any child in the group even if npm exited ahead of it.
    if (child) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    clearTimeout(deadline); fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60000);
