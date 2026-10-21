import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createPostgresStore } from './postgres-store.js';
import { createStore } from './store.js';
import { openStore } from './database.js';
import { createApp } from './app.js';
import { setOwner } from './auth.js';

// PGlite runs real PostgreSQL in-process. Its single connection is checked out
// exclusively like a pool client. No test reads DATABASE_URL or personal data.
async function postgresFixture(t) {
  const db = new PGlite();
  let pending = Promise.resolve();
  const pool = {
    query: (...args) => db.query(...args),
    end: () => db.close(),
    async connect() {
      const previous = pending;
      let release;
      pending = new Promise((resolve) => { release = resolve; });
      await previous;
      return { query: (...args) => db.query(...args), release };
    },
  };
  const store = await createPostgresStore(undefined, { pool });
  t.after(() => store.close());
  return store;
}

for (const backend of ['SQLite', 'PostgreSQL']) {
  test(`${backend}: empty storage, CRUD, ordering, async rollback and serialized updates`, async (t) => {
    const store = backend === 'PostgreSQL' ? await postgresFixture(t) : createStore(':memory:');
    if (backend === 'SQLite') t.after(() => store.close());
    assert.deepEqual(await store.all('accounts'), []);
    assert.equal(await store.get('auth', 'owner'), null);
    await store.put('accounts', { id: 'one', name: 'First', value: 0 });
    await store.put('accounts', { id: 'two', name: '₹ savings' });
    await store.put('accounts', { id: 'one', name: 'Updated', value: 0 });
    assert.deepEqual((await store.all('accounts')).map((row) => row.id), ['one', 'two']);
    await assert.rejects(store.atomic(async (tx) => {
      await tx.put('accounts', { id: 'rollback' });
      await tx.delete('accounts', 'two');
      throw new Error('Rollback test');
    }), /Rollback test/);
    assert.equal(await store.get('accounts', 'rollback'), null);
    assert.equal((await store.get('accounts', 'two')).name, '₹ savings');
    await Promise.all(Array.from({ length: 5 }, () => store.atomic(async (tx) => {
      const row = await tx.get('accounts', 'one');
      await tx.put('accounts', { ...row, value: row.value + 1 });
    })));
    assert.equal((await store.get('accounts', 'one')).value, 5);
    await store.delete('accounts', 'two');
    assert.equal(await store.get('accounts', 'two'), null);
    await store.put("quotes'--", { id: "id'--", name: 'Safe parameter' });
    assert.equal((await store.get("quotes'--", "id'--")).name, 'Safe parameter');
  });
}

test('PostgreSQL: fresh owner, finance workflows, concurrent contributions and reset', async (t) => {
  const store = await postgresFixture(t);
  const app = createApp(store);
  const api = request.agent(app);
  assert.deepEqual((await api.get('/api/auth/session')).body, { configured: false, authenticated: false });
  await api.get('/api/state').expect(401);
  await setOwner(store, 'neon-test', 'public-test-passphrase');
  await api.post('/api/auth/login').send({ username: 'neon-test', password: 'public-test-passphrase' }).expect(200);
  const fresh = (await api.get('/api/state').expect(200)).body;
  for (const key of ['accounts', 'transactions', 'goals', 'categoryBudgets', 'investments']) assert.deepEqual(fresh[key], []);
  const { body: account } = await api.post('/api/accounts').send({ name: 'Bank', type: 'bank', openingBalance: 1000 }).expect(201);
  const { body: transaction } = await api.post('/api/transactions').send({ accountId: account.id, type: 'expense', date: '2026-10-01', amount: 100, category: 'Food' }).expect(201);
  await api.delete(`/api/accounts/${account.id}`).send({}).expect(400);
  await api.post('/api/transactions').send({ accountId: 'missing', type: 'expense', date: '2026-10-01', amount: 100, category: 'Food' }).expect(400);
  const { body: category } = await api.post('/api/categories').send({ name: 'Pet care' }).expect(201);
  const { body: budget } = await api.post('/api/categoryBudgets').send({ name: 'Food plan', month: '2026-10', amount: 300, categories: ['Food'] }).expect(201);
  await api.post(`/api/categoryBudgets/${budget.id}/adjustments`).send({ month: '2026-10', amount: 50 }).expect(201);
  const { body: goal } = await api.post('/api/goals').send({ name: 'Savings', type: 'unlimited', purpose: 'savings', targetAmount: 1000 }).expect(201);
  await Promise.all(Array.from({ length: 4 }, () => api.post(`/api/goals/${goal.id}/contributions`).send({ date: '2026-10-01', amount: 25 }).expect(200)));
  await api.put(`/api/goals/${goal.id}`).send({ ...goal, name: 'Renamed' }).expect(200);
  const { body: holding } = await api.post('/api/investments').send({ name: 'Fund', type: 'asset', value: 200, cost: 150, date: '2026-10-01' }).expect(201);
  await api.put(`/api/investments/${holding.id}`).send({ ...holding, value: 250 }).expect(200);
  const state = (await api.get('/api/state?month=2026-10').expect(200)).body;
  assert.equal(state.balances[account.id], 900);
  assert.equal(state.totalProgress[goal.id], 100);
  assert.equal(state.goals[0].contributions.length, 4);
  assert.equal(state.categoryBudgetStatus[0].remaining, 250);
  assert.equal(state.investments[0].history.length, 2);
  assert.match((await api.get('/api/export').expect(200)).text, /Food/);
  await api.post('/api/smart-entry').send({ input: 'Spent 20 on groceries from Bank' }).expect(200);
  await api.delete(`/api/categories/${category.id}`).send({}).expect(200);
  await api.delete(`/api/transactions/${transaction.id}`).send({}).expect(200);
  await api.delete(`/api/accounts/${account.id}`).send({}).expect(200);
  await setOwner(store, 'new-owner', 'another-public-passphrase');
  await api.get('/api/state').expect(401);
  assert.equal((await store.all('goals')).length, 1);
  await api.post('/api/auth/login').send({ username: 'new-owner', password: 'another-public-passphrase' }).expect(200);
  await api.post('/api/auth/logout').send({}).expect(200);
  await api.get('/api/state').expect(401);
});

test('database selection rejects invalid URLs and unsafe production storage', async () => {
  for (const DATABASE_URL of ['', 'sqlite://file', 'not-a-url']) {
    await assert.rejects(openStore({ DATABASE_URL }), /DATABASE_URL must/);
  }
  await assert.rejects(openStore({ NODE_ENV: 'production' }), /Refusing temporary storage/);
  const store = await openStore({ DATABASE_PATH: ':memory:' });
  await store.close();
});

test('PostgreSQL: all transfer directions update balances, holdings and export atomically', async (t) => {
  const store = await postgresFixture(t);
  await setOwner(store, 'transfer-owner', 'public-transfer-passphrase');
  const api = request.agent(createApp(store));
  await api.post('/api/auth/login').send({ username: 'transfer-owner', password: 'public-transfer-passphrase' }).expect(200);
  const { body: first } = await api.post('/api/accounts').send({ name: 'Bank A', type: 'bank', openingBalance: 1000 }).expect(201);
  const { body: second } = await api.post('/api/accounts').send({ name: 'Bank B', type: 'bank', openingBalance: 0 }).expect(201);
  const { body: holding } = await api.post('/api/investments').send({ name: 'Fund', type: 'asset', value: 200, cost: 100, date: '2026-10-01' }).expect(201);
  const base = { type: 'transfer', date: '2026-10-02', fromType: 'account', fromId: first.id, toType: 'account', toId: second.id, amount: 100 };
  await api.post('/api/transactions').send(base).expect(201);
  await api.post('/api/transactions').send({ ...base, toType: 'investment', toId: holding.id }).expect(201);
  const { body: withdrawal } = await api.post('/api/transactions').send({ ...base, fromType: 'investment', fromId: holding.id, toId: second.id, amount: 150, receivedAmount: 140 }).expect(201);
  let state = (await api.get('/api/state?month=2026-10').expect(200)).body;
  assert.equal(state.balances[first.id], 800);
  assert.equal(state.balances[second.id], 240);
  assert.equal(state.investments[0].value, 150);
  assert.equal(state.investments[0].cost, 100);
  assert.equal(withdrawal.costBasisRemoved, 100);
  assert.equal(state.transactions.length, 3);
  assert.match((await api.get(`/api/export?type=transfer&investmentId=${holding.id}`).expect(200)).text, /Received amount/);
  // Competing withdrawals are serialized; one must fail without a partial credit.
  const results = await Promise.all([1, 2].map(() => api.post('/api/transactions').send({ ...base, fromType: 'investment', fromId: holding.id, toId: second.id, amount: 100, receivedAmount: 99 })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
  state = (await api.get('/api/state').expect(200)).body;
  assert.equal(state.investments[0].value, 50);
  assert.equal(state.balances[second.id], 339);
  assert.equal(state.transactions.length, 4);
  const latest = state.transactions.at(-1);
  const { body: edited } = await api.put(`/api/transactions/${latest.id}`).send({ ...latest, amount: 50, receivedAmount: 48 }).expect(200);
  assert.equal(edited.id, latest.id);
  state = (await api.get('/api/state').expect(200)).body;
  assert.equal(state.investments[0].value, 100);
  assert.equal(state.investments[0].cost, 66.67);
  assert.equal(state.balances[second.id], 288);
  assert.equal(state.transactions.length, 4);
  const before = state;
  await api.put(`/api/transactions/${latest.id}`).send({ ...edited, amount: 1000 }).expect(400);
  assert.deepEqual((await api.get('/api/state').expect(200)).body, before);
  // Delete newest-first, including an edited withdrawal, restoring the baseline.
  for (const record of [...state.transactions].reverse()) {
    await api.delete(`/api/transactions/${record.id}`).send({}).expect(200);
  }
  state = (await api.get('/api/state').expect(200)).body;
  assert.deepEqual(state.transactions, []);
  assert.equal(state.balances[first.id], 1000);
  assert.equal(state.balances[second.id], 0);
  assert.equal(state.investments[0].value, 200);
  assert.equal(state.investments[0].cost, 100);
});

test('PostgreSQL: failed commit rolls back, preserves errors and releases connections', async () => {
  const original = new Error('Commit failed');
  const rollbackError = new Error('Connection lost');
  const statements = [];
  let releasedWith;
  const store = await createPostgresStore(undefined, { pool: {
    query: async () => ({ rows: [] }),
    end: async () => {},
    connect: async () => ({
      async query(sql) {
        statements.push(sql);
        if (sql === 'COMMIT') throw original;
        if (sql === 'ROLLBACK') throw rollbackError;
        return { rows: [] };
      },
      release(error) { releasedWith = error; },
    }),
  } });
  await assert.rejects(store.atomic(async () => 'uncommitted'), (error) => error === original);
  assert.deepEqual(statements, ['BEGIN', 'SELECT pg_advisory_xact_lock(734901, 1)', 'COMMIT', 'ROLLBACK']);
  assert.equal(releasedWith, rollbackError);
  await store.close();
});

test('PostgreSQL: initialization failures close the pool without exposing credentials', async () => {
  let ended = false;
  await assert.rejects(createPostgresStore(undefined, { pool: {
    async query() { throw new Error('private-connection-details'); },
    async end() { ended = true; throw new Error('private-cleanup-details'); },
  } }), (error) => {
    assert.match(error.message, /Could not initialize PostgreSQL/);
    assert.doesNotMatch(error.message, /private-/);
    return true;
  });
  assert.ok(ended);
});