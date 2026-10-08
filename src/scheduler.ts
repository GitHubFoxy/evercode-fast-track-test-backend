import { listTrackedCryptocurrencies, getTrackingSnapshot, saveTrackedQuotes } from './database';
import type { Database, TrackingSnapshot } from './database';
import { getUsdQuotes } from './coinmarketcap';
import type { ApplicationConfig } from './app';

export interface Scheduler {
  changed: () => void;
  stop: () => void;
}

export function createScheduler(database: Database, config: ApplicationConfig): Scheduler {
  let timer: NodeJS.Timeout | undefined;
  let running = false, stopped = false;
  const now = config.clock?.now ?? Date.now;
  const later = config.clock?.setTimeout ?? setTimeout;
  const cancel = config.clock?.clearTimeout ?? clearTimeout;
  const size = config.batchSize ?? 250;
  const sourceInterval = Math.max(60000, config.syncIntervalMs ?? 60000);
  const changed = (): void => {
    if (stopped || running || config.syncIntervalMs === undefined) return;
    if (timer) cancel(timer);
    const count = listTrackedCryptocurrencies(database).length;
    const batches = Math.ceil(count / size);
    const cost = Math.floor(count / size) * Math.ceil(size / 250) + Math.ceil((count % size) / 250);
    const interval = count ? config.budget!.interval(cost, batches, sourceInterval) : sourceInterval;
    timer = later(cycle, Math.min(2147483647, interval));
    timer?.unref?.();
  };
  const cycle = async (): Promise<void> => {
    timer = undefined;
    if (stopped || running) return;
    running = true;
    try {
      await config.budget!.reconcile();
      if (stopped) return;
      const snapshots = listTrackedCryptocurrencies(database)
        .map(item => getTrackingSnapshot(database, item.id))
        .filter((snapshot): snapshot is TrackingSnapshot => snapshot !== undefined);
      for (let offset = 0; offset < snapshots.length && !stopped; offset += size) {
        const batch = snapshots.slice(offset, offset + size);
        try {
          const quotes = await getUsdQuotes({ apiKey: config.coinMarketCapApiKey, timeoutMs: config.coinMarketCapTimeoutMs,
            baseUrl: config.coinMarketCapBaseUrl, budget: config.budget, background: true, batchSize: size }, batch.map(item => item.cmcId));
          if (!stopped) saveTrackedQuotes(database, batch, quotes, new Date(now()).toISOString());
        } catch { /* Keep successful batches; retry only at the next budgeted cycle. */ }
      }
    } catch { /* Quota discovery failure must not terminate scheduling. */ }
    finally { running = false; changed(); }
  };
  changed();
  return { changed, stop: () => { stopped = true; if (timer) cancel(timer); timer = undefined; } };
}
