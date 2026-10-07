const fs: any = require("node:fs");
const path: any = require("node:path");
const { DatabaseSync }: { DatabaseSync: new (location: string) => any } = require("node:sqlite");

export interface TrackedCryptocurrency {
  id: number;
  cmcId: number;
  symbol: string;
  name: string;
  lastUpdatedAt: string | null;
}

export function openDatabase(databasePath: string): any {
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
      id INTEGER PRIMARY KEY,
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
  return database;
}

export function listTrackedCryptocurrencies(database: any): TrackedCryptocurrency[] {
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
    ORDER BY tracked.id
  `).all() as TrackedCryptocurrency[];
}
