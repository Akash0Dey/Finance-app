import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { createApp } from './app.js';
import { createStore } from './store.js';

const testSalt = 'finance-tests-only';
const testHash = `scrypt:${testSalt}:${scryptSync('test-only-passphrase', testSalt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  store.put('auth', { id: 'owner', username: 'test-owner', passwordHash: testHash });
  const token = randomBytes(32).toString('hex');
  store.put('sessions', { id: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 60_000 });
  return { store, api: request.agent(createApp(store)).set('Cookie', `pocket_session=${token}`) };
}
const account = { name: 'HDFC Bank', type: 'bank', openingBalance: 1000 };
const transaction = (id) => ({ accountId: id, date: '2026-10-01', type: 'expense', amount: 125.5, category: 'Food', notes: 'Groceries' });

test('transactions create, edit, filter, export, delete and recalculate balances', async (t) => {
  const { api } = fixture(t);
  const { body: a } = await api.post('/api/accounts').send(account).expect(201);
  const { body: tx } = await api.post('/api/transactions').send(transaction(a.id)).expect(201);
  await api.delete(`/api/accounts/${a.id}`).send({}).expect(400);
  let state = (await api.get('/api/state?month=2026-10').expect(200)).body;
  assert.equal(state.balances[a.id], 874.5);
  await api.put(`/api/transactions/${tx.id}`).send({ ...tx, amount: 200, category: 'My custom category' }).expect(200);
  state = (await api.get('/api/state?month=2026-10')).body;
  assert.ok(state.categories.includes('My custom category'));
  assert.equal(state.balances[a.id], 800);
  const exported = await api.get(`/api/export?month=2026-10&accountId=${a.id}`).expect(200);
  assert.match(exported.text, /Groceries/);
  assert.doesNotMatch((await api.get('/api/export?month=2026-09')).text, /Groceries/);
  await api.delete(`/api/transactions/${tx.id}`).send({}).expect(200);
  assert.equal((await api.get('/api/state')).body.balances[a.id], 1000);
  await api.delete(`/api/accounts/${a.id}`).send({}).expect(200);
});
test('invalid amounts, invalid dates, missing accounts and malformed months rejected', async (t) => {
  const { api } = fixture(t);
  const { body: a } = await api.post('/api/accounts').send(account);
  for (const amount of [-5, 0, 1.234, 1000000001]) await api.post('/api/transactions').send({ ...transaction(a.id), amount }).expect(400);
  await api.post('/api/transactions').send({ ...transaction(a.id), date: '2026-02-30' }).expect(400);
  await api.post('/api/transactions').send(transaction('missing')).expect(400);
  await api.get('/api/state?month=2026-99').expect(400);
  await api.put('/api/accounts/missing').send(account).expect(404);
});
test('custom categories persist and named budgets cover selected categories', async (t) => {
  const { api } = fixture(t);
  const { body: category } = await api.post('/api/categories').send({ name: 'Childcare' }).expect(201);
  await api.post('/api/categories').send({ name: 'childcare' }).expect(400);
  await api.post('/api/categories').send({ name: 'All' }).expect(400);
  const { body: a } = await api.post('/api/accounts').send(account);
  await api.post('/api/transactions').send({ ...transaction(a.id), category: 'Childcare', amount: 75 }).expect(201);
  const { body: budget } = await api.post('/api/categoryBudgets').send({ name: 'Family essentials', month: '2026-09', amount: 200, categories: ['Food', 'Rent', 'Childcare'] }).expect(201);
  await api.post('/api/categoryBudgets').send({ name: 'Food plan', month: '2026-09', amount: 100, categories: ['Food'] }).expect(201);
  const state = (await api.get('/api/state?month=2026-10')).body;
  assert.ok(state.categories.includes('Childcare'));
  assert.equal(state.categoryBudgetStatus.find((item) => item.id === budget.id).spent, 75);
  assert.equal(state.categoryBudgetStatus.find((item) => item.id === budget.id).remaining, 325);
  await api.delete(`/api/categories/${category.id}`).send({}).expect(400);
});
test('All budget covers every expense and category overlap is allowed', async (t) => {
  const { api } = fixture(t);
  const { body: a } = await api.post('/api/accounts').send(account);
  await api.post('/api/categories').send({ name: 'Pet care' }).expect(201);
  await api.post('/api/transactions').send({ ...transaction(a.id), category: 'Food', amount: 25 });
  await api.post('/api/transactions').send({ ...transaction(a.id), category: 'Pet care', amount: 40 });
  const { body: budget } = await api.post('/api/categoryBudgets').send({ name: 'Everything', month: '2026-10', amount: 100, categories: ['All'] }).expect(201);
  assert.equal(budget.carryoverEnabled, true);
  assert.equal(budget.includeInTotal, true);
  const { body: foodBudget } = await api.post('/api/categoryBudgets').send({ name: 'Food', month: '2026-10', amount: 50, categories: ['Food'] }).expect(201);
  await api.post('/api/categoryBudgets').send({ name: 'Overlap duplicate name', month: '2026-10', amount: 50, categories: ['Food'] }).expect(201);
  await api.put(`/api/categoryBudgets/${budget.id}`).send({ ...budget, categories: ['All', 'Food'] }).expect(400);
  const state = (await api.get('/api/state?month=2026-10')).body;
  assert.equal(state.categoryBudgetStatus.find((item) => item.id === budget.id).spent, 65);
  assert.equal(state.categoryBudgetStatus.find((item) => item.id === budget.id).remaining, 35);
  assert.equal(state.categoryBudgetStatus.find((item) => item.id === foodBudget.id).spent, 25);
  assert.equal('budgetHistory' in state, false);
  await api.post('/api/budgets').send({ month: '2026-10', amount: 100 }).expect(404);
});
test('budget total adjustments change available funds without changing monthly limit', async (t) => {
  const { api } = fixture(t);
  const { body: a } = await api.post('/api/accounts').send(account);
  const { body: budget } = await api.post('/api/categoryBudgets').send({ name: 'Shopping', month: '2026-08', amount: 3000, categories: ['Shopping'] }).expect(201);
  await api.post('/api/transactions').send({ ...transaction(a.id), date: '2026-08-15', category: 'Shopping', amount: 1000 });
  await api.post(`/api/categoryBudgets/${budget.id}/adjustments`).send({ month: '2026-09', amount: 5000, note: 'Add reserve' }).expect(201);
  await api.post(`/api/categoryBudgets/${budget.id}/adjustments`).send({ month: '2026-09', amount: -1000, note: 'Remove reserve' }).expect(201);
  await api.post(`/api/categoryBudgets/${budget.id}/adjustments`).send({ month: '2026-09', amount: 0 }).expect(400);
  await api.post(`/api/categoryBudgets/${budget.id}/adjustments`).send({ month: '2026-07', amount: 500 }).expect(400);
  const state = (await api.get('/api/state?month=2026-09')).body;
  const status = state.categoryBudgetStatus[0];
  assert.equal(status.base, 3000);
  assert.equal(status.carryover, 2000);
  assert.equal(status.adjustment, 4000);
  assert.equal(status.available, 9000);
  assert.equal(status.remaining, 9000);
  assert.deepEqual(status.adjustments.map(({ amount }) => amount), [5000, -1000]);
  const october = (await api.get('/api/state?month=2026-10')).body.categoryBudgetStatus[0];
  assert.equal(october.base, 3000);
  assert.equal(october.available, 12000);
});
test('goal contributions persist across edits, monthly reset and achieved status', async (t) => {
  const { api } = fixture(t);
  const { body: goal } = await api.post('/api/goals').send({ name: 'Rainy day', type: 'monthly', purpose: 'savings', targetAmount: 1000 }).expect(201);
  await api.post(`/api/goals/${goal.id}/contributions`).send({ date: '2026-09-01', amount: 100 }).expect(200);
  await api.post(`/api/goals/${goal.id}/contributions`).send({ date: '2026-10-01', amount: 200 }).expect(200);
  await api.post(`/api/goals/${goal.id}/contributions`).send({ date: '2026-10-02', amount: -50 }).expect(200);
  await api.put(`/api/goals/${goal.id}`).send({ ...goal, name: 'New name' }).expect(200);
  const october = (await api.get('/api/state?month=2026-10')).body;
  assert.equal(october.progress[goal.id], 150);
  assert.equal(october.totalProgress[goal.id], 250);
  assert.equal(october.goalNetWorth[goal.id], 250);
  assert.equal(october.goalNetWorthTotal, 250);
  const { body: debtGoal } = await api.post('/api/goals').send({ name: 'Loan', type: 'unlimited', purpose: 'debt', targetAmount: 1000 }).expect(201);
  await api.post(`/api/goals/${debtGoal.id}/contributions`).send({ date: '2026-10-02', amount: 300 }).expect(200);
  const afterDebtPayment = (await api.get('/api/state?month=2026-10')).body;
  assert.equal(afterDebtPayment.goalNetWorth[debtGoal.id], -700);
  assert.equal(afterDebtPayment.goalNetWorthTotal, -450);
  assert.equal((await api.get('/api/state?month=2026-11')).body.progress[goal.id], 0);
  await api.put(`/api/goals/${goal.id}`).send({ ...goal, status: 'achieved' }).expect(200);
  await api.post(`/api/goals/${goal.id}/contributions`).send({ date: '2026-10-01', amount: 100 }).expect(400);
  await api.post('/api/goals').send({ name: 'Missing date', type: 'deadline', purpose: 'debt', targetAmount: 100 }).expect(400);
  await api.post('/api/goals').send({ name: 'Negative target', type: 'unlimited', purpose: 'debt', targetAmount: -250 }).expect(400);
  await api.post(`/api/goals/${goal.id}/contributions`).send({ date: '2026-10-03', amount: 0 }).expect(400);
});
test('investment updates preserve manual valuation history', async (t) => {
  const { api } = fixture(t);
  const { body: holding } = await api.post('/api/investments').send({ name: 'Index fund', type: 'asset', value: 1000, cost: 900, startDate: '2026-01-15', date: '2026-09-01' }).expect(201);
  assert.equal(holding.startDate, '2026-01-15');
  await api.put(`/api/investments/${holding.id}`).send({ ...holding, value: 1100, date: '2026-10-01' }).expect(200);
  const investment = (await api.get('/api/state')).body.investments[0];
  assert.deepEqual(investment.history.map((h) => h.value), [1000, 1100]);
  assert.equal(investment.startDate, '2026-01-15');
  const { body: legacyHolding } = await api.post('/api/investments').send({ name: 'Older holding', type: 'asset', value: 50, cost: 40, date: '2025-03-01' }).expect(201);
  assert.equal(legacyHolding.startDate, '2025-03-01');
});
test('smart entry is a reviewable suggestion, not an automatic write', async (t) => {
  const { api } = fixture(t);
  const { body: a } = await api.post('/api/accounts').send(account);
  const { body: draft } = await api.post('/api/smart-entry').send({ input: 'Spent ₹450 on groceries from HDFC Bank on 2026-10-02' }).expect(200);
  assert.equal(draft.amount, 450);
  assert.equal(draft.date, '2026-10-02');
  assert.equal(draft.category, 'Food');
  assert.equal(draft.accountId, a.id);
  assert.equal((await api.get('/api/state')).body.transactions.length, 0);
});
test('cross-origin writes and non-JSON payloads rejected', async (t) => {
  const { api } = fixture(t);
  await api.post('/api/accounts').set('Origin', 'https://malicious.example').send(account).expect(403);
  await api.post('/api/accounts').type('form').send(account).expect(415);
  await api.get('/api/unknown').expect(404);
});
test('demo data is optional and cannot overwrite existing data', async (t) => {
  const { api } = fixture(t);
  assert.equal((await api.get('/api/state')).body.accounts.length, 0);
  await api.post('/api/demo').send({}).expect(201);
  const state = (await api.get('/api/state')).body;
  assert.equal(state.accounts.length, 2);
  assert.equal(state.transactions.length, 9);
  await api.post('/api/demo').send({}).expect(400);
});
test('demo data cannot be loaded in production', async (t) => {
  const store = createStore(':memory:');
  t.after(() => store.close());
  store.put('auth', { id: 'owner', username: 'test-owner', passwordHash: testHash });
  const token = randomBytes(32).toString('hex');
  store.put('sessions', { id: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 60_000 });
  const api = request.agent(createApp(store, { production: true, publicOrigin: 'https://pocket.example', trustProxy: 1 }))
    .set('Cookie', `__Host-pocket_session=${token}`)
    .set('Origin', 'https://pocket.example')
    .set('X-Forwarded-Proto', 'https');
  await api.post('/api/demo').send({}).expect(404);
  assert.equal((await api.get('/api/state')).body.accounts.length, 0);
});
test('SQLite records survive a database close and reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-test-'));
  const path = join(directory, 'pocket.sqlite');
  try {
    const first = createStore(path);
    first.put('accounts', { ...account, id: 'persistent' });
    first.close();
    const second = createStore(path);
    assert.equal(second.get('accounts', 'persistent').openingBalance, 1000);
    second.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});