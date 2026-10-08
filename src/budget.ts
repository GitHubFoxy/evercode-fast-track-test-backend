import type { Database } from './database';
import { CoinMarketCapError, isIsoTimestamp, isRecord } from './coinmarketcap';

export interface QuotaFallback {
  monthlyLimit?: number;
  creditsLeft?: number;
  resetAt?: string;
  minuteLimit?: number;
  requestsLeft?: number;
  keyInfoCredits?: number;
}

/** Persisted allowance; everything is a safe integer except the ISO reset timestamp. */
interface BudgetState {
  monthlyLimit: number;
  creditsLeft: number;
  resetAt: string;
  minuteLimit: number;
  requestsLeft: number;
  minute: number;
  quoteCreditUnit?: number;
  keyInfoCost?: number;
  blockedUntil?: number;
  unconfirmed?: boolean;
  resetPending?: boolean;
}

export type ProviderOperation = (signal: AbortSignal) => Promise<unknown>;

const fail = (): CoinMarketCapError => new CoinMarketCapError('provider-error');
const nonNegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function field(source: unknown, ...path: string[]): unknown {
  let value: unknown = source;
  for (const key of path) value = isRecord(value) ? value[key] : undefined;
  return value;
}

// Reservations are durable before I/O; an interrupted call conservatively keeps its charge.
// One Node process owns this DB; multiple replicas would need transactional cross-process reservations.
//
// Without any configured quota (and no persisted state) the budget is "provider-enforced":
// requests are not metered locally and CoinMarketCap itself rejects over-limit calls. A partial
// quota is a configuration mistake and still denies external calls instead of guessing.
export class ProviderBudget {
  onChange?: () => void;
  private stopped = false;
  private active = new Set<AbortController>();
  private clients = 0;
  private drained?: () => void;
  private reconciled = false;
  private reconciling?: Promise<void>;
  private readonly unmetered: boolean;

  constructor(private database: Database, private now: () => number, private fallback: QuotaFallback = {},
    private keyInfo?: ProviderOperation) {
    database.exec('CREATE TABLE IF NOT EXISTS provider_budget (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)');
    this.unmetered = Object.values(fallback).every(value => value === undefined);
    const bootstrap = this.complete(fallback);
    if (!this.state() && bootstrap) this.save({ ...bootstrap, minute: this.minute() });
  }
  private minute(): number { return Math.floor(this.now() / 60000); }
  private complete(q: QuotaFallback): Omit<BudgetState, 'minute'> | undefined {
    const { monthlyLimit, creditsLeft, resetAt, minuteLimit, requestsLeft } = q;
    return monthlyLimit !== undefined && creditsLeft !== undefined && resetAt !== undefined
      && minuteLimit !== undefined && requestsLeft !== undefined
      ? { monthlyLimit, creditsLeft, resetAt, minuteLimit, requestsLeft } : undefined;
  }
  private valid(q: Partial<BudgetState>, permitExpired = false): q is BudgetState {
    const { monthlyLimit, creditsLeft, minuteLimit, requestsLeft, resetAt } = q;
    return nonNegative(monthlyLimit) && nonNegative(creditsLeft) && nonNegative(minuteLimit) && nonNegative(requestsLeft)
      && monthlyLimit > 0 && minuteLimit > 0 && creditsLeft <= monthlyLimit && requestsLeft <= minuteLimit
      && isIsoTimestamp(resetAt) && (permitExpired || Date.parse(resetAt) > this.now());
  }
  private state(): BudgetState | undefined {
    const row = this.database.prepare('SELECT state FROM provider_budget WHERE id=1').get() as { state: string } | undefined;
    return row ? JSON.parse(row.state) as BudgetState : undefined;
  }
  private save(state: BudgetState): void {
    this.database.prepare('INSERT INTO provider_budget VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(JSON.stringify(state));
  }
  private update(change: (state: BudgetState) => void): void {
    const state = this.state();
    if (state) { change(state); this.save(state); }
  }
  private current(): BudgetState | undefined {
    const q = this.state();
    if (q && q.minute !== this.minute()) { q.minute = this.minute(); q.requestsLeft = q.minuteLimit; this.save(q); }
    return q;
  }
  async reconcile(): Promise<void> {
    if (this.stopped) throw fail();
    const state = this.state();
    const expired = state && Date.parse(state.resetAt) <= this.now();
    if ((this.reconciled && !expired && !state?.unconfirmed) || !this.keyInfo || this.fallback.keyInfoCredits === undefined) return;
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.reconcileOnce(this.keyInfo, this.fallback.keyInfoCredits)
      .finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }
  private async reconcileOnce(keyInfo: ProviderOperation, configuredCost: number): Promise<void> {
    const body = await this.execute(Math.max(configuredCost, this.state()?.keyInfoCost ?? 0), false, keyInfo, true);
    if (this.stopped) throw fail();
    const local = this.state();
    const plan = field(body, 'data', 'plan'), usage = field(body, 'data', 'usage');
    const fallback = this.fallback;
    const candidate: Partial<BudgetState> = {
      monthlyLimit: (field(plan, 'credit_limit_monthly') ?? fallback.monthlyLimit) as number | undefined,
      creditsLeft: (field(usage, 'current_month', 'credits_left')
        ?? (fallback.creditsLeft !== undefined ? local?.creditsLeft : undefined)) as number | undefined,
      resetAt: (field(plan, 'credit_limit_monthly_reset_timestamp') ?? fallback.resetAt) as string | undefined,
      minuteLimit: (field(plan, 'rate_limit_minute') ?? fallback.minuteLimit) as number | undefined,
      requestsLeft: (field(usage, 'current_minute', 'requests_left')
        ?? (fallback.requestsLeft !== undefined ? local?.requestsLeft : undefined)) as number | undefined,
      minute: this.minute(), quoteCreditUnit: local?.quoteCreditUnit ?? 1, keyInfoCost: local?.keyInfoCost,
    };
    const used = field(usage, 'current_month', 'credits_used');
    const made = field(usage, 'current_minute', 'requests_made');
    const creditCount = field(body, 'status', 'credit_count');
    if (!local || field(body, 'status', 'error_code') !== 0 || !plan || !usage || !this.valid(candidate)
        || !nonNegative(creditCount)
        || (used !== undefined && (!nonNegative(used) || used + candidate.creditsLeft > candidate.monthlyLimit))
        || (made !== undefined && (!nonNegative(made) || made + candidate.requestsLeft > candidate.minuteLimit))) {
      // Do not trust a stale bootstrap after a failed reconciliation.
      this.update(old => { old.unconfirmed = true; });
      throw fail();
    }
    candidate.creditsLeft = Math.min(candidate.creditsLeft, local.creditsLeft);
    candidate.requestsLeft = Math.min(candidate.requestsLeft, local.requestsLeft);
    this.save(candidate);
    this.reconciled = true; this.onChange?.();
  }
  async call(cost: number, background: boolean, operation: ProviderOperation): Promise<unknown> {
    await this.reconcile();
    return this.execute(cost, background, operation);
  }
  private async execute(cost: number, background: boolean, operation: ProviderOperation, service = false): Promise<unknown> {
    if (this.stopped) throw fail();
    const q = this.current();
    if (!q && this.unmetered && !service) return this.executeUnmetered(background, operation);
    const expired = q !== undefined && Date.parse(q.resetAt) <= this.now();
    if (q && service && expired && !q.resetPending) {
      q.creditsLeft = q.monthlyLimit; q.resetPending = true; this.save(q);
    }
    const baseCost = cost;
    if (!service && q) cost *= q.quoteCreditUnit ?? 1;
    if (this.stopped || !q || !this.valid(q, expired && service) || (q.blockedUntil ?? 0) > this.now()
        || (!service && q.unconfirmed) || !Number.isSafeInteger(cost) || cost < 0
        || q.creditsLeft < cost + (background ? 1 : 0) || q.requestsLeft < (background ? 2 : 1)
        || (background && this.clients > 0)) throw fail();
    q.creditsLeft -= cost; q.requestsLeft--; this.save(q);
    const controller = new AbortController(); this.active.add(controller);
    if (!background) this.clients++;
    let body: unknown;
    try {
      body = await operation(controller.signal);
      if (this.stopped) throw fail();
      const creditCount = field(body, 'status', 'credit_count');
      if (field(body, 'status', 'error_code') === 0 && !nonNegative(creditCount)) {
        this.update(current => { current.unconfirmed = true; });
        throw fail();
      }
      return body;
    } catch (error) {
      body = error instanceof CoinMarketCapError ? error.providerBody ?? body : body;
      if (error instanceof CoinMarketCapError && error.httpStatus === 429) {
        const retryAfterMs = error.retryAfterMs;
        this.update(current => {
          current.requestsLeft = 0;
          if (retryAfterMs !== undefined && Number.isSafeInteger(this.now() + retryAfterMs))
            current.blockedUntil = this.now() + retryAfterMs;
        });
        this.reconciled = false;
      }
      throw error;
    } finally {
      const actual = field(body, 'status', 'credit_count');
      const current = this.state();
      if (current && nonNegative(actual) && current.resetAt === q.resetAt) {
        current.creditsLeft = Math.max(0, Math.min(current.monthlyLimit, current.creditsLeft + cost - actual));
        if (service) current.keyInfoCost = Math.max(current.keyInfoCost ?? 0, actual);
        else if (baseCost > 0) current.quoteCreditUnit = Math.max(current.quoteCreditUnit ?? 1, Math.ceil(actual / baseCost));
        this.save(current);
      }
      this.finish(controller, background);
    }
  }
  /** No quota is known anywhere: let the provider enforce its own limits. */
  private async executeUnmetered(background: boolean, operation: ProviderOperation): Promise<unknown> {
    if (background && this.clients > 0) throw fail();
    const controller = new AbortController(); this.active.add(controller);
    if (!background) this.clients++;
    try {
      const body = await operation(controller.signal);
      if (this.stopped) throw fail();
      return body;
    } finally { this.finish(controller, background); }
  }
  private finish(controller: AbortController, background: boolean): void {
    this.active.delete(controller);
    if (!background) this.clients--;
    if (!this.stopped) this.onChange?.();
    if (!this.active.size) this.drained?.();
  }
  interval(cycleCredits: number, cycleRequests: number, sourceInterval: number): number {
    const q = this.current();
    cycleCredits *= q?.quoteCreditUnit ?? 1;
    if (!q || q.unconfirmed || !this.valid(q) || q.creditsLeft <= cycleCredits || q.requestsLeft < 2) return Math.max(60000, sourceInterval);
    // Distribute whole cycles strictly inside the period; preserve one client credit.
    const cycles = Math.floor((q.creditsLeft - 1) / cycleCredits);
    return Math.max(sourceInterval, Math.ceil((Date.parse(q.resetAt) - this.now()) / (cycles + 1)),
      Math.ceil(60000 * cycleRequests / Math.max(1, q.minuteLimit - 1)));
  }
  stop(): Promise<void> {
    this.stopped = true; for (const controller of this.active) controller.abort();
    return this.active.size ? new Promise(resolve => { this.drained = resolve; }) : Promise.resolve();
  }
  get busy(): boolean { return this.active.size > 0; }
}
