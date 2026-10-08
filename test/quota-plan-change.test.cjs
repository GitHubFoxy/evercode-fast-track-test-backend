const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../dist/database');
const { ProviderBudget } = require('../dist/budget');

const oldReset = '2030-02-01T00:00:00Z';
const nextReset = '2030-03-01T00:00:00Z';
const quoteBody = { status: { error_code: 0, credit_count: 1 }, data: [] };
const snapshot = { monthlyLimit: 5, creditsLeft: 5, resetAt: oldReset,
  minuteLimit: 20, requestsLeft: 20, keyInfoCredits: 1 };
const info = (monthlyLimit, creditsLeft, resetAt, requestsLeft = 19, creditCount = 1) => ({
  status: { error_code: 0, credit_count: creditCount }, data: {
    plan: { credit_limit_monthly: monthlyLimit, credit_limit_monthly_reset_timestamp: resetAt, rate_limit_minute: 20 },
    usage: { current_month: { credits_used: monthlyLimit - creditsLeft, credits_left: creditsLeft },
      current_minute: { requests_made: 20 - requestsLeft, requests_left: requestsLeft } },
  },
});

describe('official quota across plan changes', () => {
  let directory, database, budget, now, keyInfo, response, quote;
  const state = () => JSON.parse(database.prepare('SELECT state FROM provider_budget WHERE id=1').get().state);
  const reopen = async (fallback = snapshot) => {
    await budget?.stop();
    database?.close();
    database = openDatabase(path.join(directory, 'quota.sqlite'));
    budget = new ProviderBudget(database, () => now, fallback, keyInfo);
  };
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evercode-plan-change-'));
    now = Date.parse('2030-01-01T00:00:00Z');
    response = info(5, 4, oldReset);
    keyInfo = jest.fn(async () => response);
    quote = jest.fn(async () => quoteBody);
    await reopen();
  });
  afterEach(async () => {
    await budget?.stop();
    database?.close();
    budget = database = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('a confirmed new 100-credit plan preserves its official 99 credits instead of the old five-credit cap', async () => {
    await budget.reconcile();
    expect(state()).toMatchObject({ monthlyLimit: 5, creditsLeft: 4 });
    now = Date.parse(oldReset);
    response = info(100, 99, nextReset);
    await budget.reconcile();
    expect(state()).toMatchObject({ monthlyLimit: 100, creditsLeft: 99, resetAt: nextReset, keyInfoCost: 1 });
    expect(keyInfo).toHaveBeenCalledTimes(2);
  });

  test('the new allowance funds real quote calls and reopening the disk database cannot refill it', async () => {
    await budget.reconcile();
    now = Date.parse(oldReset);
    response = info(100, 99, nextReset);
    await budget.reconcile();
    for (let i = 0; i < 6; i++) await budget.call(1, false, quote);
    expect(state().creditsLeft).toBe(93);
    await reopen();
    await budget.call(1, false, quote);
    expect(state()).toMatchObject({ monthlyLimit: 100, creditsLeft: 91, resetAt: nextReset });
    expect(quote).toHaveBeenCalledTimes(7);
    expect(keyInfo).toHaveBeenCalledTimes(3);
  });

  test('a confirmed downgrade trusts the new smaller allowance', async () => {
    database.prepare('DELETE FROM provider_budget').run();
    await reopen({ ...snapshot, monthlyLimit: 100, creditsLeft: 100 });
    response = info(100, 99, oldReset);
    await budget.reconcile();
    now = Date.parse(oldReset);
    response = info(3, 2, nextReset);
    await budget.reconcile();
    expect(state()).toMatchObject({ monthlyLimit: 3, creditsLeft: 2, resetAt: nextReset });
    await budget.call(1, false, quote);
    await budget.call(1, false, quote);
    await expect(budget.call(1, false, quote)).rejects.toThrow('provider-error');
    expect(quote).toHaveBeenCalledTimes(2);
  });

  test('equivalent timestamps and a larger same-period plan cannot restore already spent credits', async () => {
    await budget.call(1, false, quote);
    expect(state().creditsLeft).toBe(3);
    response = info(100, 99, '2030-02-01T00:00:00.000Z');
    await reopen();
    await budget.reconcile();
    expect(state()).toMatchObject({ monthlyLimit: 100, creditsLeft: 2, requestsLeft: 17 });
    await budget.call(1, false, quote);
    await budget.call(1, false, quote);
    await expect(budget.call(1, false, quote)).rejects.toThrow('provider-error');
    expect(quote).toHaveBeenCalledTimes(3);
  });

  test('an earlier future reset returned by the provider is stale and cannot replace a confirmed period', async () => {
    await budget.reconcile();
    now = Date.parse(oldReset);
    response = info(100, 99, nextReset);
    await budget.reconcile();
    response = info(100, 99, '2030-02-15T00:00:00Z');
    await reopen();
    await expect(budget.call(1, false, quote)).rejects.toThrow('provider-error');
    expect(state()).toMatchObject({ monthlyLimit: 100, creditsLeft: 98, resetAt: nextReset });
    expect(quote).not.toHaveBeenCalled();
  });

  test('a monthly rollover does not refill a still-current minute request allowance', async () => {
    const resetInsideMinute = '2030-02-01T00:00:30Z';
    database.prepare('DELETE FROM provider_budget').run();
    await reopen({ ...snapshot, resetAt: resetInsideMinute });
    now = Date.parse(resetInsideMinute) - 1000;
    response = info(5, 4, resetInsideMinute);
    await budget.reconcile();
    await budget.call(1, false, quote);
    expect(state().requestsLeft).toBe(18);
    now = Date.parse(resetInsideMinute);
    // Monthly reset is inside the same minute; its previous two requests still count.
    response = info(100, 99, nextReset, 19);
    await budget.reconcile();
    expect(state().requestsLeft).toBe(17);
    await budget.call(1, false, quote);
    expect(state().requestsLeft).toBe(16);
    await reopen();
    await budget.reconcile();
    expect(state().requestsLeft).toBe(15);
  });

  test.each([oldReset, '2030-02-01T00:00:00.000Z'])('reconciliation preserves in-flight reservations and actual charges with reset %s', async reset => {
    database.prepare('DELETE FROM provider_budget').run();
    await reopen({ ...snapshot, monthlyLimit: 20, creditsLeft: 20 });
    response = info(20, 19, oldReset);
    await budget.reconcile();
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const pending = budget.call(1, false, () => {
      entered();
      return new Promise(resolve => { release = resolve; });
    });
    await started;
    try {
      // A real malformed provider reply triggers an additional same-period reconciliation.
      await expect(budget.call(1, false, async () => ({ status: { error_code: 0, credit_count: 'invalid' } })))
        .rejects.toThrow('provider-error');
      response = info(20, 19, reset);
      await budget.reconcile();
    } finally { release({ status: { error_code: 0, credit_count: 3 }, data: [] }); }
    await pending;
    expect(state()).toMatchObject({ creditsLeft: 14, requestsLeft: 16, quoteCreditUnit: 3 });
  });

  test('a late quote from the old period cannot change the new confirmed allowance', async () => {
    await budget.reconcile();
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const pending = budget.call(1, false, () => {
      entered();
      return new Promise(resolve => { release = resolve; });
    });
    await started;
    now = Date.parse(oldReset);
    response = info(100, 99, nextReset);
    try { await budget.reconcile(); }
    finally { release({ status: { error_code: 0, credit_count: 3 }, data: [] }); }
    await pending;
    expect(state()).toMatchObject({ monthlyLimit: 100, creditsLeft: 99, resetAt: nextReset, quoteCreditUnit: 1 });
  });

  test('a newly confirmed period keeps the key/info payment even if the provider snapshot precedes it', async () => {
    await budget.reconcile();
    now = Date.parse(oldReset);
    response = info(100, 100, nextReset, 19, 2);
    await budget.reconcile();
    expect(state()).toMatchObject({ monthlyLimit: 100, creditsLeft: 98, resetAt: nextReset, keyInfoCost: 2 });
  });
});
