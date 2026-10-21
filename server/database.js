import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createStore } from './store.js';
import { createPostgresStore } from './postgres-store.js';

export async function openStore(env = process.env) {
  if (env.DATABASE_URL !== undefined) {
    const url = env.DATABASE_URL.trim();
    if (!/^postgres(?:ql)?:\/\//.test(url)) throw new Error('DATABASE_URL must be a PostgreSQL connection string. Remove it to use local SQLite.');
    return createPostgresStore(url);
  }
  if (env.NODE_ENV === 'production' && !env.DATABASE_PATH) {
    throw new Error('Production requires DATABASE_URL (Neon) or DATABASE_PATH on a persistent disk. Refusing temporary storage.');
  }
  return createStore(env.DATABASE_PATH === ':memory:' ? ':memory:' : env.DATABASE_PATH ? resolve(env.DATABASE_PATH) : fileURLToPath(new URL('../data/pocket.sqlite', import.meta.url)));
}