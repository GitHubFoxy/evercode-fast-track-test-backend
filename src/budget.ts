import { CoinMarketCapError, isIsoTimestamp } from './coinmarketcap';

export interface QuotaFallback {
  monthlyLimit?: number;
  creditsLeft?: number;
  resetAt?: string;
  minuteLimit?: number;
  requestsLeft?: number;
  keyInfoCredits?: number;
}

// Reservations are durable before I/O; an interrupted call conservatively keeps its charge.
// ponytail: one Node process owns this DB; multiple replicas need transactional cross-process reservations.
export class ProviderBudget {
  onChange?: () => void;
  private stopped = false;
  private active = new Set<AbortController>();
  private clients = 0;
  private drained?: () => void;
  private reconciled = false;
  private reconciling?: Promise<void>;
  constructor(private database: any, private now: () => number, private fallback: QuotaFallback = {},
    private keyInfo?: (signal: AbortSignal) => Promise<any>) {
    database.exec('CREATE TABLE IF NOT EXISTS provider_budget (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)');
    if (!this.state() && this.valid(fallback)) this.save({ ...fallback, minute: this.minute() });
  }
  private minute(): number { return Math.floor(this.now() / 60000); }
  private valid(q: any, permitExpired = false): boolean {
    return ['monthlyLimit', 'creditsLeft', 'minuteLimit', 'requestsLeft'].every(k => Number.isSafeInteger(q[k]) && q[k] >= 0)
      && q.monthlyLimit > 0 && q.minuteLimit > 0 && q.creditsLeft <= q.monthlyLimit && q.requestsLeft <= q.minuteLimit
      && isIsoTimestamp(q.resetAt) && (permitExpired || Date.parse(q.resetAt) > this.now());
  }
  private state(): any {
    const row = this.database.prepare('SELECT state FROM provider_budget WHERE id=1').get();
    return row ? JSON.parse(row.state) : undefined;
  }
  private save(state: any): void {
    this.database.prepare('INSERT INTO provider_budget VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(JSON.stringify(state));
  }
  private current(): any {
    const q = this.state();
    if (q && q.minute !== this.minute()) { q.minute = this.minute(); q.requestsLeft = q.minuteLimit; this.save(q); }
    return q;
  }
  async reconcile(): Promise<void> {
    if (this.stopped) throw new CoinMarketCapError('provider-error');
    const expired = this.state() && Date.parse(this.state().resetAt) <= this.now();
    if ((this.reconciled && !expired) || !this.keyInfo || this.fallback.keyInfoCredits === undefined) return;
    if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      const body = await this.execute(Math.max(this.fallback.keyInfoCredits!, this.state()?.keyInfoCost ?? 0), false, this.keyInfo!, true);
      if (this.stopped) throw new CoinMarketCapError('provider-error');
      const plan = body?.data?.plan, usage = body?.data?.usage;
      const local = this.state();
      const q = { monthlyLimit: plan?.credit_limit_monthly ?? this.fallback.monthlyLimit,
        creditsLeft: usage?.current_month?.credits_left ?? (this.fallback.creditsLeft !== undefined ? local.creditsLeft : undefined), resetAt: plan?.credit_limit_monthly_reset_timestamp ?? this.fallback.resetAt,
        minuteLimit: plan?.rate_limit_minute ?? this.fallback.minuteLimit,
        requestsLeft: usage?.current_minute?.requests_left ?? (this.fallback.requestsLeft !== undefined ? local.requestsLeft : undefined), minute: this.minute(),
        quoteCreditUnit: local.quoteCreditUnit ?? 1, keyInfoCost: local.keyInfoCost };
      const used = usage?.current_month?.credits_used;
      const made = usage?.current_minute?.requests_made;
      if (body?.status?.error_code !== 0 || !plan || !usage || !this.valid(q)
          || !Number.isSafeInteger(body?.status?.credit_count) || body.status.credit_count < 0
          || (used !== undefined && (!Number.isSafeInteger(used) || used < 0 || used + q.creditsLeft > q.monthlyLimit))
          || (made !== undefined && (!Number.isSafeInteger(made) || made < 0 || made + q.requestsLeft > q.minuteLimit))) {
        // Do not trust a stale bootstrap after a failed reconciliation.
        const old = this.state(); if (old) { old.unconfirmed = true; this.save(old); }
        throw new CoinMarketCapError('provider-error');
      }
      q.creditsLeft = Math.min(q.creditsLeft, local.creditsLeft);
      q.requestsLeft = Math.min(q.requestsLeft, local.requestsLeft);
      this.save(q); this.reconciled = true; this.onChange?.();
    })().finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }
  async call(cost: number, background: boolean, operation: (signal: AbortSignal) => Promise<any>): Promise<any> {
    await this.reconcile();
    return this.execute(cost, background, operation);
  }
  private async execute(cost: number, background: boolean, operation: (signal: AbortSignal) => Promise<any>, service = false): Promise<any> {
    if (this.stopped) throw new CoinMarketCapError('provider-error');
    const q = this.current();
    const expired = q && Date.parse(q.resetAt) <= this.now();
    if (service && expired && !q.resetPending) {
      q.creditsLeft = q.monthlyLimit; q.resetPending = true; this.save(q);
    }
    const baseCost = cost;
    if (!service && q) cost *= q.quoteCreditUnit ?? 1;
    const validated = q && this.valid(q, Boolean(expired && service));
    if (this.stopped || !q || !validated || q.blockedUntil > this.now() || (!service && q.unconfirmed) || !Number.isSafeInteger(cost) || cost < 0
        || q.creditsLeft < cost + (background ? 1 : 0) || q.requestsLeft < (background ? 2 : 1)
        || (background && this.clients > 0)) throw new CoinMarketCapError('provider-error');
    q.creditsLeft -= cost; q.requestsLeft--; this.save(q);
    const controller = new AbortController(); this.active.add(controller);
    if (!background) this.clients++;
    let body: any;
    try { body = await operation(controller.signal);
      if (this.stopped) throw new CoinMarketCapError('provider-error');
      if (body?.status?.error_code === 0 && (!Number.isSafeInteger(body.status.credit_count) || body.status.credit_count < 0)) {
        const current = this.state(); current.unconfirmed = true; this.save(current);
        throw new CoinMarketCapError('provider-error');
      }
      return body; }
    catch (error: any) {
      body = error.providerBody ?? body;
      if (error.httpStatus === 429) {
        const current = this.state(); current.requestsLeft = 0;
        if (Number.isSafeInteger(error.retryAfterMs) && Number.isSafeInteger(this.now() + error.retryAfterMs))
          current.blockedUntil = this.now() + error.retryAfterMs;
        this.save(current); this.reconciled = false;
      }
      throw error;
    }
    finally {
      const actual = body?.status?.credit_count;
      const current = this.state();
      if (current && Number.isSafeInteger(actual) && actual >= 0 && current.resetAt === q.resetAt) {
        current.creditsLeft = Math.max(0, Math.min(current.monthlyLimit, current.creditsLeft + cost - actual));
        if (service) current.keyInfoCost = Math.max(current.keyInfoCost ?? 0, actual);
        else if (baseCost > 0) current.quoteCreditUnit = Math.max(current.quoteCreditUnit ?? 1, Math.ceil(actual / baseCost));
        this.save(current);
      }
      this.active.delete(controller); if (!background) this.clients--;
      if (!this.stopped) this.onChange?.();
      if (!this.active.size) this.drained?.();
    }
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
