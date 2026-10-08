#!/usr/bin/env python3
"""Bounded Docker/Compose check. Uses only fake credentials and loopback CMC."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
PROJECT = 'evercode-smoke-' + uuid.uuid4().hex[:12]
TOKEN, KEY = 'smoke-only-client-token', 'smoke-only-provider-key'
# Avoid inheriting real API/quota settings from the caller; never read .env.
ENV = {k: v for k, v in os.environ.items() if not k.startswith('CMC_') and k not in
       ['API_TOKEN', 'COINMARKETCAP_API_KEY', 'PORT', 'DATABASE_PATH', 'PRICE_CURRENCY',
        'SYNC_INTERVAL_MS', 'SHUTDOWN_TIMEOUT_MS', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME',
        'COMPOSE_ENV_FILES', 'COMPOSE_PROFILES']}
ENV['COMPOSE_DISABLE_ENV_FILE'] = 'true'


def run(*args, timeout=60):
    result = subprocess.run(args, cwd=ROOT, env=ENV, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'Command failed: {args}\n{result.stdout}\n{result.stderr}')
    return result.stdout.strip()


def wait(check, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if check():
                return
        except (OSError, RuntimeError):
            pass
        time.sleep(.2)
    raise RuntimeError('Readiness deadline exceeded')


PROVIDER = r"""
const http = require('node:http');
let quotes = 0, info = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/__stats') { res.end(JSON.stringify({ quotes, info })); return; }
  if (req.headers['x-cmc_pro_api_key'] !== 'smoke-only-provider-key') { res.writeHead(401); res.end('{}'); return; }
  const status = { error_code: 0, credit_count: 1 };
  if (url.pathname === '/v1/key/info') {
    info++; res.end(JSON.stringify({ status, data: {
      plan: { credit_limit_monthly: 8, credit_limit_monthly_reset_timestamp: '2099-02-01T00:00:00Z', rate_limit_minute: 100 },
      usage: { current_month: { credits_left: 8 }, current_minute: { requests_left: 100 } }
    } })); return;
  }
  if (url.pathname !== '/v3/cryptocurrency/quotes/latest' || url.searchParams.get('convert') !== 'USD') {
    res.writeHead(400); res.end('{}'); return;
  }
  quotes++;
  res.end(JSON.stringify({ status, data: url.searchParams.get('id').split(',').map(Number).map(id => ({
    id, symbol: id === 1 ? 'BTC' : 'ETH', name: id === 1 ? 'Bitcoin' : 'Ethereum',
    last_updated: '2025-01-15T12:00:00Z', quote: [{ symbol: 'USD', price: id * 42, last_updated: '2025-01-15T12:00:00Z' }]
  })) }));
});
server.listen(9001, '127.0.0.1');
process.on('SIGTERM', () => server.close());
"""
SCAN = r"""
const fs = require('node:fs'), path = require('node:path');
function scan(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, item.name);
    if (item.name === '.env' || item.name.startsWith('.env.') || /\.(sqlite3?|db)(-|$)/.test(item.name)) throw Error('Forbidden file: ' + p);
    if (item.isDirectory()) scan(p);
  }
}
"""


def main():
    image = probe_image = cid = None
    context_fixture = Path(tempfile.mkdtemp(prefix='.smoke-context-', dir=ROOT))
    with tempfile.TemporaryDirectory(prefix=PROJECT + '-') as temporary:
        tmp = Path(temporary)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        settings = {
            'API_TOKEN': TOKEN, 'COINMARKETCAP_API_KEY': KEY, 'PORT': str(port),
            'PRICE_CURRENCY': 'USD', 'CMC_BASE_URL': 'http://127.0.0.1:9001',
            'CMC_TIMEOUT_MS': '3210', 'SYNC_INTERVAL_MS': '65000', 'CMC_BATCH_SIZE': '1',
            'SHUTDOWN_TIMEOUT_MS': '3210', 'CMC_MONTHLY_LIMIT': '8', 'CMC_CREDITS_LEFT': '8',
            'CMC_RESET_AT': '2099-02-01T00:00:00Z', 'CMC_RATE_LIMIT_MINUTE': '100',
            'CMC_REQUESTS_LEFT': '99', 'CMC_KEY_INFO_CREDITS': '1',
        }
        envfile = tmp / 'fake.env'
        envfile.write_text(''.join(f'{k}={v}\n' for k, v in settings.items()))
        provider = tmp / 'provider.cjs'
        provider.write_text(PROVIDER)
        compose = ['docker', 'compose', '--project-name', PROJECT, '--env-file', str(envfile), '-f', str(ROOT / 'compose.yaml')]
        base = f'http://127.0.0.1:{port}'

        def api(method, route, status=200, body=None, auth=True):
            headers = {'Content-Type': 'application/json'}
            if auth:
                headers['Authorization'] = 'Bearer ' + TOKEN
            req = urllib.request.Request(base + route, method=method, headers=headers,
                                         data=json.dumps(body).encode() if body is not None else None)
            try:
                res = urllib.request.urlopen(req, timeout=5)
            except urllib.error.HTTPError as error:
                res = error
            with res:
                raw = res.read().decode()
                assert res.status == status, (method, route, res.status, raw)
                assert TOKEN not in raw and KEY not in raw, 'Credentials leaked in API'
                return json.loads(raw) if raw and 'application/json' in res.headers.get('Content-Type', '') else raw

        def exec_node(code):
            return run('docker', 'exec', cid, 'node', '-e', code, timeout=30)

        def start_provider():
            run('docker', 'cp', str(provider), f'{cid}:/tmp/provider.cjs', timeout=30)
            run('docker', 'exec', '-d', cid, 'node', '/tmp/provider.cjs', timeout=30)
            wait(lambda: json.loads(exec_node("fetch('http://127.0.0.1:9001/__stats').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))")) == {'quotes': 0, 'info': 0})

        try:
            # This config command is safe: it resolves ONLY our explicitly supplied fake env.
            config = json.loads(run(*compose, 'config', '--format', 'json', timeout=30))
            assert list(config['services']) == ['api'], 'Production Compose must have one API service'
            actual = config['services']['api']['environment']
            for name, value in settings.items():
                assert actual.get(name) == value, f'Compose did not forward {name}'
            assert actual['DATABASE_PATH'] == '/data/evercode.sqlite'
            print('Compose: все настройки переданы', flush=True)

            # Test context rules with fake nested secret/DB canaries; never touch real .env.
            for name in ['.env', '.env.secret', 'canary.sqlite', 'canary.sqlite-wal', 'canary.sqlite3', 'canary.db', 'canary.db-shm']:
                (context_fixture / name).write_text('fake-context-canary-not-a-real-secret')
            probe = tmp / 'Context.Dockerfile'
            probe.write_text('FROM node:24-alpine\nWORKDIR /context\nCOPY . .\n')
            probe_image = PROJECT + '-context'
            run('docker', 'build', '-t', probe_image, '-f', str(probe), '.', timeout=180)
            run('docker', 'run', '--rm', '--name', PROJECT + '-context-check', probe_image, 'node', '-e', SCAN + "scan('/context'); console.log('context clean')", timeout=30)
            print('Docker context: секреты и БД исключены', flush=True)

            run(*compose, 'build', timeout=180)
            image = PROJECT + '-api'
            run('docker', 'run', '--rm', '--name', PROJECT + '-image-check', '--entrypoint', 'node', image,
                '-e', SCAN + "scan('/app'); scan('/data'); console.log('image clean')", timeout=30)
            run(*compose, 'up', '-d', '--no-build', timeout=60)
            cid = run(*compose, 'ps', '-q', 'api', timeout=30)
            assert cid
            wait(lambda: api('GET', '/openapi.json', auth=False).get('openapi') == '3.0.3')
            command = json.loads(exec_node("console.log(JSON.stringify(require('node:fs').readFileSync('/proc/1/cmdline','utf8').split('\\0').filter(Boolean)))"))
            assert command == ['node', 'dist/main.js'], command
            assert exec_node("console.log(process.getuid())") != '0', 'Runtime must be non-root'
            for name, value in settings.items():
                assert exec_node(f'console.log(process.env[{json.dumps(name)}])') == value, f'Container missing {name}'
            start_provider()
            assert 'validatorUrl: null' in api('GET', '/docs', auth=False)
            for asset in ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js']:
                assert api('GET', '/docs/assets/' + asset, auth=False)
            assert api('GET', '/docs/assets/missing.js', status=404, auth=False)['error']['code'] == 'NOT_FOUND'
            assert api('GET', '/api/tracked-cryptocurrencies', status=401, auth=False)['error']['code'] == 'UNAUTHORIZED'
            assert api('GET', '/api/prices') == []
            tracked = api('POST', '/api/tracked-cryptocurrencies', 201, {'cmcId': 1})
            ident = tracked['id']
            assert api('GET', f'/api/tracked-cryptocurrencies/{ident}') == tracked
            assert api('POST', '/api/tracked-cryptocurrencies', 409, {'cmcId': 1})['error']['code'] == 'ALREADY_TRACKED'
            tracked = api('PUT', f'/api/tracked-cryptocurrencies/{ident}', body={'cmcId': 2})
            assert tracked['cmcId'] == 2 and tracked['id'] == ident
            first_history = api('GET', '/api/cryptocurrencies/1/history')
            price = api('GET', f'/api/tracked-cryptocurrencies/{ident}/price')
            assert price['price'] == 84 and price['currency'] == 'USD'
            assert api('GET', '/api/prices')[0]['cmcId'] == 2
            history = api('GET', '/api/cryptocurrencies/2/history')
            assert len(history) == 3
            assert api('GET', '/api/cryptocurrencies/2/history?limit=1&offset=1') == [history[1]]
            assert api('GET', '/api/tracked-cryptocurrencies?limit=0', 400)['error']['code'] == 'INVALID_QUERY'
            print('Контейнер: Node PID1, защищённый CRUD, цены и история проверены', flush=True)

            run(*compose, 'restart', 'api', timeout=60)
            wait(lambda: api('GET', '/openapi.json', auth=False).get('openapi') == '3.0.3')
            start_provider()
            assert api('GET', f'/api/tracked-cryptocurrencies/{ident}') == tracked or api('GET', f'/api/tracked-cryptocurrencies/{ident}')['cmcId'] == 2
            assert api('GET', '/api/cryptocurrencies/1/history') == first_history
            assert api('GET', '/api/cryptocurrencies/2/history') == history
            assert api('GET', f'/api/tracked-cryptocurrencies/{ident}/price')['price'] == 84
            assert api('DELETE', f'/api/tracked-cryptocurrencies/{ident}', 204) == ''
            assert len(api('GET', '/api/cryptocurrencies/2/history')) == 4
            assert api('POST', '/api/tracked-cryptocurrencies', 201, {'cmcId': 2})['id'] > ident
            # 8 initial credits: initial key/info + 4 quotes, restart key/info + 2 quotes.
            # Optimistic fake key/info advertises 8 again; durable local budget must not refill.
            assert api('GET', '/api/prices', 502)['error']['code'] == 'CMC_API_ERROR'
            stats = json.loads(exec_node("fetch('http://127.0.0.1:9001/__stats').then(r=>r.json()).then(v=>console.log(JSON.stringify(v)))"))
            assert stats == {'quotes': 2, 'info': 1}, stats
            print('Restart: SQLite/история и потраченная квота сохранены', flush=True)

            logs = run('docker', 'logs', cid, timeout=30)
            assert TOKEN not in logs and KEY not in logs
            started = time.monotonic()
            run('docker', 'kill', '--signal=SIGTERM', cid, timeout=30)
            wait(lambda: json.loads(run('docker', 'inspect', '--format', '{{json .State}}', cid, timeout=30))['Running'] is False, seconds=10)
            state = json.loads(run('docker', 'inspect', '--format', '{{json .State}}', cid, timeout=30))
            assert state['ExitCode'] == 0 and not state['OOMKilled'], state
            assert time.monotonic() - started < 10
            print('SIGTERM: конечное завершение Node с кодом 0; Docker smoke прошёл', flush=True)
        finally:
            # Remove only this unique project's containers, volume, images and temporary fixtures.
            try:
                run(*compose, 'down', '--volumes', '--remove-orphans', timeout=60)
            finally:
                for name in [PROJECT + '-context-check', PROJECT + '-image-check']:
                    subprocess.run(['docker', 'rm', '-f', name], env=ENV, capture_output=True, timeout=30)
                for name in [image, probe_image]:
                    if name:
                        subprocess.run(['docker', 'image', 'rm', '-f', name], env=ENV, capture_output=True, timeout=30)
                shutil.rmtree(context_fixture)


if __name__ == '__main__':
    main()
