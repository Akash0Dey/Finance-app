import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function createStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(collection, id));');
  return {
    all(collection) { return db.prepare('SELECT body FROM records WHERE collection = ? ORDER BY rowid').all(collection).map((r) => JSON.parse(r.body)); },
    get(collection, id) { const row = db.prepare('SELECT body FROM records WHERE collection = ? AND id = ?').get(collection, id); return row ? JSON.parse(row.body) : null; },
    put(collection, value) { db.prepare('INSERT INTO records VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET body = excluded.body').run(collection, value.id, JSON.stringify(value)); return value; },
    delete(collection, id) { db.prepare('DELETE FROM records WHERE collection = ? AND id = ?').run(collection, id); },
    atomic(fn) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    close() { db.close(); },
  };
}