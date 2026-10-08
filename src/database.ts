import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

/** Row shapes are fixed by the SELECT lists below; node:sqlite types rows loosely. */
type Row<T> = T | undefined;
interface IdRow { id: number }
const cast = <T>(rows: unknown): T => rows as T;

export interface TrackedCryptocurrency {
  id: number;
  cmcId: number;
  symbol: string;
  name: string;
  lastUpdatedAt: string | null;
}

export interface TrackingSnapshot {
  id: number;
  cmcId: number;
  revision: number;
}

export class TrackingChangedError extends Error {
  constructor() {
    super("Tracking record changed while the request was in progress");
    this.name = "TrackingChangedError";
  }
}

export interface StoredUsdQuote {
  cmcId: number;
  name: string;
  symbol: string;
  price: number;
  providerUpdatedAt: string;
}

export interface PriceHistoryEntry {
  id: number;
  cmcId: number;
  symbol: string;
  name: string;
  price: number;
  currency: "USD";
  fetchedAt: string;
  providerUpdatedAt: string;
}

export class DuplicateTrackingError extends Error {
  constructor() {
    super("Cryptocurrency is already tracked");
    this.name = "DuplicateTrackingError";
  }
}

export function openDatabase(databasePath: string): Database {
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS cryptocurrencies (
      id INTEGER PRIMARY KEY,
      cmc_id INTEGER NOT NULL UNIQUE,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      last_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS tracked_cryptocurrencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cryptocurrency_id INTEGER NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (cryptocurrency_id) REFERENCES cryptocurrencies(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY,
      cryptocurrency_id INTEGER NOT NULL,
      price REAL NOT NULL CHECK (price >= 0),
      fetched_at TEXT NOT NULL,
      provider_updated_at TEXT NOT NULL,
      FOREIGN KEY (cryptocurrency_id) REFERENCES cryptocurrencies(id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_price_history_cryptocurrency_fetched_at
      ON price_history (cryptocurrency_id, fetched_at, id);
  `);
  const trackingSchema = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tracked_cryptocurrencies'",
  ).get() as { sql: string };
  if (!trackingSchema.sql.includes("AUTOINCREMENT")) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE tracked_cryptocurrencies RENAME TO old_tracked_cryptocurrencies;
      CREATE TABLE tracked_cryptocurrencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cryptocurrency_id INTEGER NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (cryptocurrency_id) REFERENCES cryptocurrencies(id) ON DELETE RESTRICT
      );
      INSERT INTO tracked_cryptocurrencies SELECT * FROM old_tracked_cryptocurrencies;
      DROP TABLE old_tracked_cryptocurrencies;
      COMMIT;
    `);
  }
  if (!database.prepare("PRAGMA table_info(tracked_cryptocurrencies)").all()
      .some(column => column.name === "revision")) {
    database.exec("ALTER TABLE tracked_cryptocurrencies ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
  }
  return database;
}

export function listTrackedCryptocurrencies(database: Database, page?: { limit: number; offset: number }): TrackedCryptocurrency[] {
  return cast<TrackedCryptocurrency[]>(database.prepare(`
    SELECT
      tracked.id AS id,
      cryptocurrency.cmc_id AS cmcId,
      cryptocurrency.symbol AS symbol,
      cryptocurrency.name AS name,
      cryptocurrency.last_updated_at AS lastUpdatedAt
    FROM tracked_cryptocurrencies AS tracked
    INNER JOIN cryptocurrencies AS cryptocurrency
      ON cryptocurrency.id = tracked.cryptocurrency_id
    ORDER BY tracked.id
    LIMIT ? OFFSET ?
  `).all(page?.limit ?? -1, page?.offset ?? 0));
}

export function isCmcIdTracked(database: Database, cmcId: number): boolean {
  return Boolean(database.prepare(`
    SELECT 1
    FROM tracked_cryptocurrencies AS tracked
    INNER JOIN cryptocurrencies AS cryptocurrency
      ON cryptocurrency.id = tracked.cryptocurrency_id
    WHERE cryptocurrency.cmc_id = ?
  `).get(cmcId));
}

export function getTrackedCryptocurrency(
  database: Database,
  trackingId: number,
): TrackedCryptocurrency | undefined {
  return database.prepare(`
    SELECT
      tracked.id AS id,
      cryptocurrency.cmc_id AS cmcId,
      cryptocurrency.symbol AS symbol,
      cryptocurrency.name AS name,
      cryptocurrency.last_updated_at AS lastUpdatedAt
    FROM tracked_cryptocurrencies AS tracked
    INNER JOIN cryptocurrencies AS cryptocurrency
      ON cryptocurrency.id = tracked.cryptocurrency_id
    WHERE tracked.id = ?
  `).get(trackingId) as TrackedCryptocurrency | undefined;
}

export function createTrackedCryptocurrencyWithQuote(
  database: Database,
  quote: StoredUsdQuote,
  fetchedAt: string,
): TrackedCryptocurrency {
  database.exec("BEGIN IMMEDIATE");
  try {
    const alreadyTracked = database.prepare(`
      SELECT 1
      FROM tracked_cryptocurrencies AS tracked
      INNER JOIN cryptocurrencies AS cryptocurrency
        ON cryptocurrency.id = tracked.cryptocurrency_id
      WHERE cryptocurrency.cmc_id = ?
    `).get(quote.cmcId);
    if (alreadyTracked) throw new DuplicateTrackingError();

    const cryptocurrency = database.prepare(
      "SELECT id FROM cryptocurrencies WHERE cmc_id = ?",
    ).get(quote.cmcId) as Row<IdRow>;
    let cryptocurrencyId: number;
    if (cryptocurrency) {
      cryptocurrencyId = Number(cryptocurrency.id);
      database.prepare(`
        UPDATE cryptocurrencies
        SET symbol = ?, name = ?, last_updated_at = ?
        WHERE id = ?
      `).run(quote.symbol, quote.name, fetchedAt, cryptocurrencyId);
    } else {
      const inserted = database.prepare(`
        INSERT INTO cryptocurrencies (cmc_id, symbol, name, last_updated_at)
        VALUES (?, ?, ?, ?)
      `).run(quote.cmcId, quote.symbol, quote.name, fetchedAt);
      cryptocurrencyId = Number(inserted.lastInsertRowid);
    }

    const insertedTracking = database.prepare(`
      INSERT INTO tracked_cryptocurrencies (cryptocurrency_id) VALUES (?)
    `).run(cryptocurrencyId);
    database.prepare(`
      INSERT INTO price_history (cryptocurrency_id, price, fetched_at, provider_updated_at)
      VALUES (?, ?, ?, ?)
    `).run(cryptocurrencyId, quote.price, fetchedAt, quote.providerUpdatedAt);

    const tracked = getTrackedCryptocurrency(database, Number(insertedTracking.lastInsertRowid));
    if (!tracked) throw new Error("Created tracking record could not be read");
    database.exec("COMMIT");
    return tracked;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export function saveTrackedQuotes(
  database: Database,
  snapshot: TrackingSnapshot[],
  quotes: StoredUsdQuote[],
  fetchedAt: string,
): PriceHistoryEntry[] {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const tracked of snapshot) {
      assertTrackingSnapshotCurrent(database, tracked);
    }
    const saved: PriceHistoryEntry[] = snapshot.map((tracked) => {
      const quote = quotes.find((item) => item.cmcId === tracked.cmcId);
      if (!quote) throw new Error("Missing validated quote");
      const cryptocurrency = cast<IdRow>(database.prepare("SELECT id FROM cryptocurrencies WHERE cmc_id = ?").get(tracked.cmcId));
      database.prepare(`UPDATE cryptocurrencies SET symbol = ?, name = ?, last_updated_at = ? WHERE id = ?`)
        .run(quote.symbol, quote.name, fetchedAt, cryptocurrency.id);
      const inserted = database.prepare(`INSERT INTO price_history (cryptocurrency_id, price, fetched_at, provider_updated_at)
        VALUES (?, ?, ?, ?)`).run(cryptocurrency.id, quote.price, fetchedAt, quote.providerUpdatedAt);
      return { id: Number(inserted.lastInsertRowid), ...quote, currency: "USD" as const, fetchedAt };
    });
    database.exec("COMMIT");
    return saved;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getTrackingSnapshot(database: Database, trackingId: number): TrackingSnapshot | undefined {
  return database.prepare(`
    SELECT tracked.id AS id, coin.cmc_id AS cmcId, tracked.revision AS revision
    FROM tracked_cryptocurrencies AS tracked
    JOIN cryptocurrencies AS coin ON coin.id = tracked.cryptocurrency_id
    WHERE tracked.id = ?
  `).get(trackingId) as TrackingSnapshot | undefined;
}

// Call inside the same write transaction as quote/history persistence, after external I/O.
export function assertTrackingSnapshotCurrent(database: Database, snapshot: TrackingSnapshot): void {
  const current = getTrackingSnapshot(database, snapshot.id);
  if (!current || current.revision !== snapshot.revision || current.cmcId !== snapshot.cmcId) {
    throw new TrackingChangedError();
  }
}

export function deleteTrackedCryptocurrency(database: Database, trackingId: number): boolean {
  return database.prepare("DELETE FROM tracked_cryptocurrencies WHERE id = ?").run(trackingId).changes > 0;
}

export function replaceTrackedCryptocurrencyWithQuote(
  database: Database,
  snapshot: TrackingSnapshot,
  quote: StoredUsdQuote,
  fetchedAt: string,
): TrackedCryptocurrency {
  database.exec("BEGIN IMMEDIATE");
  try {
    assertTrackingSnapshotCurrent(database, snapshot);
    const trackingId = snapshot.id;
    const duplicate = database.prepare(`
      SELECT tracked.id FROM tracked_cryptocurrencies AS tracked
      JOIN cryptocurrencies AS coin ON coin.id = tracked.cryptocurrency_id
      WHERE coin.cmc_id = ? AND tracked.id != ?
    `).get(quote.cmcId, trackingId);
    if (duplicate) throw new DuplicateTrackingError();
    database.prepare(`
      INSERT INTO cryptocurrencies (cmc_id, symbol, name, last_updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cmc_id) DO UPDATE SET
        symbol = excluded.symbol, name = excluded.name, last_updated_at = excluded.last_updated_at
    `).run(quote.cmcId, quote.symbol, quote.name, fetchedAt);
    const coin = cast<IdRow>(database.prepare("SELECT id FROM cryptocurrencies WHERE cmc_id = ?").get(quote.cmcId));
    database.prepare("UPDATE tracked_cryptocurrencies SET cryptocurrency_id = ?, revision = revision + 1 WHERE id = ?")
      .run(coin.id, trackingId);
    database.prepare(`
      INSERT INTO price_history (cryptocurrency_id, price, fetched_at, provider_updated_at)
      VALUES (?, ?, ?, ?)
    `).run(coin.id, quote.price, fetchedAt, quote.providerUpdatedAt);
    const tracked = getTrackedCryptocurrency(database, trackingId);
    if (!tracked) throw new Error("Tracking record was not found");
    database.exec("COMMIT");
    return tracked;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

export function getCryptocurrencyHistory(
  database: Database,
  cmcId: number,
  page: { limit: number; offset: number; from?: string; to?: string } = { limit: 50, offset: 0 },
): PriceHistoryEntry[] | undefined {
  const cryptocurrency = database.prepare(
    "SELECT id FROM cryptocurrencies WHERE cmc_id = ?",
  ).get(cmcId) as Row<IdRow>;
  if (!cryptocurrency) return undefined;

  return cast<PriceHistoryEntry[]>(database.prepare(`
    SELECT
      history.id AS id,
      cryptocurrency.cmc_id AS cmcId,
      cryptocurrency.symbol AS symbol,
      cryptocurrency.name AS name,
      history.price AS price,
      'USD' AS currency,
      history.fetched_at AS fetchedAt,
      history.provider_updated_at AS providerUpdatedAt
    FROM price_history AS history
    INNER JOIN cryptocurrencies AS cryptocurrency
      ON cryptocurrency.id = history.cryptocurrency_id
    WHERE cryptocurrency.cmc_id = ?
      AND (? IS NULL OR history.fetched_at >= ?)
      AND (? IS NULL OR history.fetched_at <= ?)
    ORDER BY history.fetched_at, history.id
    LIMIT ? OFFSET ?
  `).all(cmcId, page.from ?? null, page.from ?? null, page.to ?? null, page.to ?? null, page.limit, page.offset));
}
