const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../dist/database');
const { ProviderBudget } = require('../dist/budget');
const { CoinMarketCapError } = require('../dist/coinmarketcap');

const snapshot = { monthlyLimit: 5, creditsLeft: 2, resetAt: '2030-02-01T00:00:00Z',
  minuteLimit: 10, requestsLeft: 10 };
const success = { status: { error_code: 0, credit_count: 1 }, data: [] };

describe('optional quota recovery across periods and restarts', () => {
  let directory, database, budget, now, quote;
  const state = () => JSON.parse(database.prepare('SELECT state FROM provider_budget WHERE id=1').get().state);
  const reopen = async (quota = snapshot, keyInfo) => {
    await budget?.stop();
    database?.close();
    database = openDatabase(path.join(directory, 'quota.sqlite'));
    budget = new ProviderBudget(database, () => now, quota, keyInfo);
  };
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evercode-quota-regression-'));
    now = Date.parse('2030-01-01T00:00:00Z');
    quote = jest.fn(async () => success);
    await reopen();
  });
  afterEach(async () => {
    await budget?.stop();
    database?.close();
    budget = database = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('an expired manual snapshot resumes client and background requests without inventing a new quota', async () => {
    const keyInfo = jest.fn();
    await reopen(snapshot, keyInfo);
    await budget.call(1, false, quote);
    await budget.call(1, false, quote);
    await expect(budget.call(1, false, quote)).rejects.toThrow('provider-error');
    expect(quote).toHaveBeenCalledTimes(2);

    now = Date.parse(snapshot.resetAt);
    await expect(budget.call(1, false, quote)).resolves.toBe(success);
    await expect(budget.call(1, true, quote)).resolves.toBe(success);
    await reopen(snapshot, keyInfo);
    await expect(budget.call(1, false, quote)).resolves.toBe(success);
    expect(keyInfo).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ creditsLeft: 0, resetAt: snapshot.resetAt });
    expect(budget.interval(1, 1, 1000)).toBe(60000);
  });

  test('a confirmed future period replaces an expired snapshot and subsequent restarts preserve spending', async () => {
    await budget.call(1, false, quote);
    await budget.call(1, false, quote);
    now = Date.parse(snapshot.resetAt);
    const next = { ...snapshot, creditsLeft: 3, resetAt: '2030-03-01T00:00:00Z' };
    await reopen(next);
    await budget.call(1, false, quote);
    await budget.call(1, false, quote);
    await reopen({ ...next, creditsLeft: 5, resetAt: '2030-03-01T00:00:00.000Z' });
    expect(state()).toMatchObject({ creditsLeft: 1, resetAt: next.resetAt });
    await budget.call(1, false, quote);
    await expect(budget.call(1, false, quote)).rejects.toThrow('provider-error');
    expect(quote).toHaveBeenCalledTimes(5);
  });

  test('a later reset in the environment cannot refill a still-active period', async () => {
    await budget.call(1, false, quote);
    await budget.call(1, false, quote);
    await reopen({ ...snapshot, creditsLeft: 5, resetAt: '2030-03-01T00:00:00Z' });
    await expect(budget.call(1, false, quote)).rejects.toThrow('provider-error');
    expect(state()).toMatchObject({ creditsLeft: 0, resetAt: snapshot.resetAt });
  });

  test.each(['active', 'expired'])('removing all quota settings disables persisted %s metering without deleting it', async period => {
    await budget.call(1, false, quote);
    await budget.call(1, false, quote);
    if (period === 'expired') now = Date.parse(snapshot.resetAt);
    const stored = state();
    const keyInfo = jest.fn();
    await reopen({}, keyInfo);
    await budget.call(1, false, quote);
    await budget.call(1, true, quote);
    expect(keyInfo).not.toHaveBeenCalled();
    expect(state()).toEqual(stored);
    expect(budget.interval(1, 1, 1000)).toBe(60000);
    await reopen(snapshot);
    if (period === 'active') await expect(budget.call(1, false, quote)).rejects.toThrow('provider-error');
    else await expect(budget.call(1, false, quote)).resolves.toBe(success);
    expect(state().creditsLeft).toBe(0);
  });

  test('partial settings deny external operations even when a valid persisted budget exists', async () => {
    await budget.call(1, false, quote);
    const stored = state();
    const keyInfo = jest.fn();
    await reopen({ monthlyLimit: 5, keyInfoCredits: 1 }, keyInfo);
    await expect(budget.call(1, false, quote)).rejects.toThrow('provider-error');
    await expect(budget.call(1, true, quote)).rejects.toThrow('provider-error');
    expect(keyInfo).not.toHaveBeenCalled();
    expect(quote).toHaveBeenCalledTimes(1);
    expect(state()).toEqual(stored);
  });

  test('configured key/info still requires an official future period before resuming quotes', async () => {
    let reset = snapshot.resetAt;
    const keyInfo = jest.fn(async () => ({ status: { error_code: 0, credit_count: 1 }, data: {
      plan: { credit_limit_monthly: 5, credit_limit_monthly_reset_timestamp: reset, rate_limit_minute: 10 },
      usage: { current_month: { credits_left: 4 }, current_minute: { requests_left: 9 } },
    } }));
    const quota = { ...snapshot, keyInfoCredits: 1 };
    await reopen(quota, keyInfo);
    await budget.call(1, false, quote);
    expect(state().creditsLeft).toBe(0);
    now = Date.parse(snapshot.resetAt);
    await expect(budget.call(1, false, quote)).rejects.toThrow('provider-error');
    expect(quote).toHaveBeenCalledTimes(1);
    reset = '2030-03-01T00:00:00Z';
    await expect(budget.call(1, false, quote)).resolves.toBe(success);
    expect(state()).toMatchObject({ resetAt: reset, creditsLeft: 3 });
    await reopen(quota, keyInfo);
    await budget.call(1, false, quote);
    expect(state()).toMatchObject({ resetAt: reset, creditsLeft: 1 });
    await budget.call(1, false, quote);
    expect(state()).toMatchObject({ resetAt: reset, creditsLeft: 0 });
    await expect(budget.call(1, false, quote)).rejects.toThrow('provider-error');
  });

  test('failed key/info rollover remains conservative and never falls through to unmetered quotes', async () => {
    const keyInfo = jest.fn(async () => { throw new CoinMarketCapError('timeout'); });
    await reopen({ ...snapshot, keyInfoCredits: 1 }, keyInfo);
    now = Date.parse(snapshot.resetAt);
    await expect(budget.call(1, false, quote)).rejects.toThrow('timeout');
    expect(quote).not.toHaveBeenCalled();
    expect(state()).toMatchObject({ resetAt: snapshot.resetAt, creditsLeft: 4, resetPending: true });
    await reopen({ ...snapshot, keyInfoCredits: 1 }, keyInfo);
    await expect(budget.call(1, false, quote)).rejects.toThrow('timeout');
    expect(state().creditsLeft).toBe(3);
  });

  test.each(['disabled', 'expired'])('provider errors propagate in %s metering mode', async mode => {
    if (mode === 'disabled') await reopen({});
    else now = Date.parse(snapshot.resetAt);
    const error = new CoinMarketCapError('provider-error');
    error.httpStatus = 429;
    const failing = jest.fn(async () => { throw error; });
    await expect(budget.call(1, false, failing)).rejects.toBe(error);
    await expect(budget.call(1, false, quote)).resolves.toBe(success);
  });

  test.each(['manual', 'disabled', 'expired'])('shutdown cancels active %s calls and prevents late success', async mode => {
    if (mode === 'disabled') await reopen({});
    else if (mode === 'expired') now = Date.parse(snapshot.resetAt);
    let entered, release, signal;
    const started = new Promise(resolve => { entered = resolve; });
    const pending = budget.call(1, false, current => {
      signal = current;
      entered();
      return new Promise(resolve => { release = resolve; });
    });
    const result = expect(pending).rejects.toThrow('provider-error');
    await started;
    try {
      // With manual metering, the active client leaves only its reserved final credit.
      if (mode === 'manual') await expect(budget.call(1, true, quote)).rejects.toThrow('provider-error');
      else await expect(budget.call(1, true, quote)).resolves.toBe(success);
      const stopped = budget.stop();
      expect(signal.aborted).toBe(true);
      release(success);
      await Promise.all([stopped, result]);
    } finally {
      // Release the held operation even if an assertion fails, so cleanup cannot hang.
      const stopped = budget.stop();
      release(success);
      await Promise.all([stopped, result]);
    }
    await expect(budget.call(1, false, quote)).rejects.toThrow('provider-error');
    expect(quote).toHaveBeenCalledTimes(mode === 'manual' ? 0 : 1);
    expect(budget.busy).toBe(false);
  });
});
