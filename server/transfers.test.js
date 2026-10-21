import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { createApp } from './app.js';
import { createStore } from './store.js';

const testSalt = 'transfer-tests-only';
const testHash = `scrypt:${testSalt}:${scryptSync('test-only-passphrase', testSalt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
const date = '2026-10-15';

function fixture(t) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  store.put('auth', { id: 'owner', username: 'test-owner', passwordHash: testHash });
  const token = randomBytes(32).toString('hex');
  store.put('sessions', { id: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 60_000 });
  return { store, api: request.agent(createApp(store)).set('Cookie', `pocket_session=${token}`) };
}

async function account(api, overrides = {}) {
  return (await api.post('/api/accounts').send({ name: 'Bank', type: 'bank', openingBalance: 1000, ...overrides }).expect(201)).body;
}

async function investment(api, overrides = {}) {
  return (await api.post('/api/investments').send({ name: 'Index fund', type: 'asset', value: 300, cost: 200, startDate: '2026-01-01', date: '2026-09-01', notes: 'Original holding', ...overrides }).expect(201)).body;
}

function transfer(from, to, overrides = {}) {
  return {
    type: 'transfer', fromType: from.type === 'asset' || from.type === 'liability' ? 'investment' : 'account', fromId: from.id,
    toType: to.type === 'asset' || to.type === 'liability' ? 'investment' : 'account', toId: to.id,
    amount: 100, date, notes: 'Move funds', ...overrides,
  };
}

async function state(api) {
  return (await api.get('/api/state').query({ month: '2026-10' }).expect(200)).body;
}

// Calculate net worth independently from the API's balances and holding values.
function netWorth(snapshot) {
  const balances = Object.values(snapshot.balances).reduce((sum, value) => sum + Math.round(value * 100), 0);
  const holdings = snapshot.investments.reduce((sum, holding) => sum + (holding.type === 'asset' ? 1 : -1) * Math.round(holding.value * 100), 0);
  return (balances + holdings + Math.round(snapshot.goalNetWorthTotal * 100)) / 100;
}

async function rejectedWithoutChanges(api, operation, errorPattern) {
  const before = await state(api);
  const response = await operation().expect(400);
  assert.equal(typeof response.body.error, 'string');
  assert.ok(response.body.error.length > 0);
  if (errorPattern) assert.match(response.body.error, errorPattern);
  assert.deepEqual(await state(api), before, 'a rejected operation must not change any finance state');
}

async function exportRows(api, filters = {}) {
  const response = await api.get('/api/export').query(filters).expect(200).expect('Content-Type', /text\/csv/);
  assert.match(response.headers['content-disposition'], /pocket-transactions\.csv/);
  // Fixtures here have single-line cells; decode quotes without splitting commas inside cells.
  const rows = response.text.replace(/^\ufeff/, '').split('\r\n').map((line) =>
    [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map((match) => match[1].replaceAll('""', '"')));
  const [headers, ...values] = rows;
  assert.deepEqual(headers, ['Date', 'Type', 'Amount', 'Category', 'Account', 'Notes', 'From', 'To', 'Received amount', 'Cost basis removed']);
  for (const row of values) assert.equal(row.length, headers.length);
  return values.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
}

test('account transfers debit and credit equal amounts without changing net worth', async (t) => {
  const { api, store } = fixture(t);
  const source = await account(api, { openingBalance: 1000.1 });
  const destination = await account(api, { name: 'Savings', type: 'savings', openingBalance: 25.2 });
  const before = await state(api);
  const payload = transfer(source, destination, { amount: 123.45, notes: '  Rainy day reserve  ' });
  const { body: record } = await api.post('/api/transactions').send(payload).expect(201);
  assert.deepEqual(record, { ...payload, notes: 'Rainy day reserve', id: record.id, receivedAmount: 123.45, category: 'Transfer', fromName: source.name, toName: destination.name });
  assert.equal(typeof record.id, 'string');
  assert.ok(record.id.length > 0);
  assert.equal('accountId' in record, false);
  let after = await state(api);
  assert.deepEqual(after.transactions, [record]);
  assert.equal(after.balances[source.id], 876.65);
  assert.equal(after.balances[destination.id], 148.65);
  assert.equal(netWorth(after), netWorth(before));
  assert.deepEqual(store.all('accounts'), [source, destination]);
  assert.deepEqual(after.investments, before.investments);
  await api.post('/api/transactions').send(transfer(destination, source, { amount: 0.01, receivedAmount: 0.01 })).expect(201);
  after = await state(api);
  assert.equal(after.balances[source.id], 876.66);
  assert.equal(after.balances[destination.id], 148.64);
  assert.equal(netWorth(after), netWorth(before));
});

test('bank-to-asset deposits increase value and cost and append linked history', async (t) => {
  const { api } = fixture(t);
  const bank = await account(api);
  const holding = await investment(api);
  const before = await state(api);
  const { body: record } = await api.post('/api/transactions').send(transfer(bank, holding, { amount: 25.55, receivedAmount: 25.55 })).expect(201);
  assert.equal(record.receivedAmount, 25.55);
  assert.equal(record.costBasisRemoved, 0);
  assert.equal(record.fromName, bank.name);
  assert.equal(record.toName, holding.name);
  const after = await state(api);
  assert.equal(after.balances[bank.id], 974.45);
  assert.deepEqual(after.investments[0], {
    ...holding, value: 325.55, cost: 225.55, date,
    history: [...holding.history, { date, value: 325.55, cost: 225.55, transferId: record.id }],
  });
  assert.deepEqual(after.transactions, [record]);
  assert.equal(netWorth(after), netWorth(before));
});

test('asset withdrawals separate deducted value from proceeds, round cost proportionally and clear full cost', async (t) => {
  const { api } = fixture(t);
  const bank = await account(api);
  const holding = await investment(api, { value: 3, cost: 1 });
  const before = await state(api);
  const { body: first } = await api.post('/api/transactions').send(transfer(holding, bank, { amount: 1, receivedAmount: 1.25 })).expect(201);
  assert.equal(first.amount, 1);
  assert.equal(first.receivedAmount, 1.25);
  assert.equal(first.costBasisRemoved, 0.33);
  let after = await state(api);
  assert.equal(after.balances[bank.id], 1001.25);
  assert.deepEqual(after.investments[0], { ...holding, value: 2, cost: 0.67, date, history: [...holding.history, { date, value: 2, cost: 0.67, transferId: first.id }] });
  assert.equal(netWorth(after), netWorth(before) + 0.25);
  const { body: second } = await api.post('/api/transactions').send(transfer(holding, bank, { amount: 1, receivedAmount: 0.75, date: '2026-10-16' })).expect(201);
  assert.equal(second.costBasisRemoved, 0.34, 'half a cent rounds up');
  after = await state(api);
  assert.equal(after.investments[0].cost, 0.33);
  assert.equal(after.investments[0].value, 1);
  assert.equal(after.balances[bank.id], 1002);
  const { body: final } = await api.post('/api/transactions').send(transfer(holding, bank, { amount: 1, receivedAmount: 0.5, date: '2026-10-17' })).expect(201);
  assert.equal(final.costBasisRemoved, 0.33);
  after = await state(api);
  assert.equal(after.balances[bank.id], 1002.5);
  assert.equal(after.investments[0].value, 0);
  assert.equal(after.investments[0].cost, 0);
  assert.equal(after.investments[0].startDate, holding.startDate);
  assert.deepEqual(after.investments[0].history, [
    ...holding.history,
    { date, value: 2, cost: 0.67, transferId: first.id },
    { date: '2026-10-16', value: 1, cost: 0.33, transferId: second.id },
    { date: '2026-10-17', value: 0, cost: 0, transferId: final.id },
  ]);
  assert.equal(netWorth(after), netWorth(before) - 0.5);
  assert.equal(after.transactions.length, 3);
  await rejectedWithoutChanges(api, () => api.post('/api/transactions').send(transfer(holding, bank, { amount: 0.01, receivedAmount: 0 })), /exceeds the investment value/);
});

test('a full asset withdrawal permits zero proceeds without crediting the bank', async (t) => {
  const { api } = fixture(t);
  const bank = await account(api);
  const holding = await investment(api, { value: 100, cost: 120 });
  const before = await state(api);
  const { body: record } = await api.post('/api/transactions').send(transfer(holding, bank, { amount: 100, receivedAmount: 0 })).expect(201);
  assert.equal(record.receivedAmount, 0);
  assert.equal(record.costBasisRemoved, 120);
  const after = await state(api);
  assert.equal(after.balances[bank.id], before.balances[bank.id]);
  assert.equal(after.investments[0].value, 0);
  assert.equal(after.investments[0].cost, 0);
  assert.deepEqual(after.investments[0].history.at(-1), { date, value: 0, cost: 0, transferId: record.id });
  assert.equal(netWorth(after), netWorth(before) - 100);
});

test('transfers do not enter category budgets, insights, income or expense totals', async (t) => {
  const { api } = fixture(t);
  const bank = await account(api, { openingBalance: 10000 });
  const savings = await account(api, { name: 'Savings' });
  const holding = await investment(api, { value: 1000, cost: 800 });
  for (const day of ['01', '02', '03']) {
    await api.post('/api/transactions').send({ type: 'expense', accountId: bank.id, date: `2026-09-${day}`, amount: 10, category: 'Food' }).expect(201);
  }
  await api.post('/api/transactions').send({ type: 'expense', accountId: bank.id, date, amount: 50, category: 'Food' }).expect(201);
  await api.post('/api/transactions').send({ type: 'income', accountId: bank.id, date, amount: 500, category: 'Salary' }).expect(201);
  for (const [name, categories] of [['Everything', ['All']], ['Food only', ['Food']]]) {
    await api.post('/api/categoryBudgets').send({ name, categories, month: '2026-09', amount: 100 }).expect(201);
  }
  const before = await state(api);
  for (const transferDate of ['2026-09-20', date]) {
    for (const payload of [transfer(bank, savings), transfer(bank, holding), transfer(holding, bank, { receivedAmount: 150 })]) {
      await api.post('/api/transactions').send({ ...payload, date: transferDate }).expect(201);
    }
  }
  const after = await state(api);
  assert.deepEqual(after.categoryBudgetStatus, before.categoryBudgetStatus);
  assert.deepEqual(after.categoryBudgetStatus.map(({ spent, carryover, remaining }) => ({ spent, carryover, remaining })), [
    { spent: 50, carryover: 70, remaining: 120 }, { spent: 50, carryover: 70, remaining: 120 },
  ]);
  assert.deepEqual(after.insights, before.insights);
  assert.equal(after.insights.suggestedBudget, 100);
  assert.equal(after.insights.anomalies.length, 1);
  assert.deepEqual(after.categories, before.categories);
  assert.equal(after.categories.includes('Transfer'), false);
  for (const [type, expected] of [['income', 500], ['expense', 50]]) {
    const transactions = after.transactions.filter((item) => item.type === type && item.date.startsWith('2026-10'));
    assert.equal(transactions.reduce((sum, item) => sum + item.amount, 0), expected);
    const rows = await exportRows(api, { type, month: '2026-10' });
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].Amount), expected);
    assert.equal(rows[0].Type, type);
  }
});

test('CSV includes transfer fields and filters both endpoints, type, month and case-insensitive search', async (t) => {
  const { api } = fixture(t);
  const bank = await account(api, { name: 'Primary Bank' });
  const savings = await account(api, { name: 'Savings Vault', type: 'savings' });
  const unrelated = await account(api, { name: 'Unrelated' });
  const holding = await investment(api, { name: 'Index "Growth", Fund' });
  const otherHolding = await investment(api, { name: 'Other holding' });
  for (const payload of [
    transfer(bank, savings, { amount: 12.34, notes: 'reserve movement' }),
    transfer(bank, holding, { amount: 20, notes: 'purchase movement' }),
    transfer(holding, savings, { amount: 30, receivedAmount: 35, notes: 'redemption movement' }),
    transfer(savings, bank, { date: '2026-09-01', notes: 'prior movement' }),
  ]) await api.post('/api/transactions').send(payload).expect(201);
  await api.post('/api/transactions').send({ type: 'expense', accountId: unrelated.id, date, amount: 5, category: 'Food', notes: 'ordinary spending' }).expect(201);
  const rows = await exportRows(api, { type: 'transfer', month: '2026-10' });
  assert.deepEqual(rows, [
    { Date: date, Type: 'transfer', Amount: '12.34', Category: 'Transfer', Account: '', Notes: 'reserve movement', From: bank.name, To: savings.name, 'Received amount': '12.34', 'Cost basis removed': '' },
    { Date: date, Type: 'transfer', Amount: '20', Category: 'Transfer', Account: '', Notes: 'purchase movement', From: bank.name, To: holding.name, 'Received amount': '20', 'Cost basis removed': '0' },
    { Date: date, Type: 'transfer', Amount: '30', Category: 'Transfer', Account: '', Notes: 'redemption movement', From: holding.name, To: savings.name, 'Received amount': '35', 'Cost basis removed': '20.63' },
  ]);
  const checks = [
    [{ accountId: bank.id }, ['reserve movement', 'purchase movement']],
    [{ accountId: savings.id }, ['reserve movement', 'redemption movement']],
    [{ accountId: unrelated.id }, []],
    [{ investmentId: holding.id }, ['purchase movement', 'redemption movement']],
    [{ investmentId: otherHolding.id }, []],
    [{ search: 'PRIMARY BANK' }, ['reserve movement', 'purchase movement']],
    [{ search: 'sAvInGs VaUlT' }, ['reserve movement', 'redemption movement']],
    [{ search: 'GROWTH' }, ['purchase movement', 'redemption movement']],
    [{ search: 'REDEMPTION' }, ['redemption movement']],
    [{ search: 'transfer' }, ['reserve movement', 'purchase movement', 'redemption movement']],
    [{ search: 'not present' }, []],
    [{ accountId: savings.id, investmentId: holding.id, search: 'redemption' }, ['redemption movement']],
    [{ accountId: bank.id, investmentId: holding.id, search: 'redemption' }, []],
    [{ category: 'Food' }, []],
    [{ month: '2026-09' }, ['prior movement']],
    [{ month: '2026-08' }, []],
  ];
  for (const [filters, expectedNotes] of checks) {
    const exported = await exportRows(api, { type: 'transfer', month: '2026-10', ...filters });
    assert.deepEqual(exported.map((row) => row.Notes), expectedNotes, JSON.stringify(filters));
  }
});

test('invalid transfer endpoints, payloads and amounts leave all state unchanged', async (t) => {
  const { api } = fixture(t);
  const bank = await account(api);
  const savings = await account(api, { name: 'Savings' });
  const holding = await investment(api);
  const otherHolding = await investment(api, { name: 'Other fund' });
  const liability = await investment(api, { name: 'Loan', type: 'liability' });
  const valid = transfer(bank, savings);
  const withdrawal = transfer(holding, bank, { receivedAmount: 90 });
  const cases = [
    ['same account', transfer(bank, bank), /different source and destination/],
    ['same investment', transfer(holding, holding, { receivedAmount: 100 }), /different source and destination/],
    ['missing source account', { ...valid, fromId: 'missing' }, /existing source and destination/],
    ['missing destination account', { ...valid, toId: 'missing' }, /existing source and destination/],
    ['missing source asset', { ...withdrawal, fromId: 'missing' }, /existing source and destination/],
    ['missing destination asset', transfer(bank, { ...holding, id: 'missing' }), /existing source and destination/],
    ['liability destination', transfer(bank, liability), /Only investment assets/],
    ['liability source', transfer(liability, bank, { receivedAmount: 90 }), /Only investment assets/],
    ['investment to investment', transfer(holding, otherHolding, { receivedAmount: 90 }), /must go to an account/],
    ['missing received amount on withdrawal', transfer(holding, bank), /amount received/],
    ['mismatched account proceeds', { ...valid, receivedAmount: 99 }, /same amount/],
    ['zero account proceeds', { ...valid, receivedAmount: 0 }, /same amount/],
    ['mismatched deposit proceeds', transfer(bank, holding, { receivedAmount: 99 }), /same amount/],
    ['over withdrawal', { ...withdrawal, amount: 300.01 }, /exceeds the investment value/],
  ];
  for (const field of ['fromType', 'fromId', 'toType', 'toId', 'amount', 'date']) {
    const payload = { ...valid };
    delete payload[field];
    cases.push([`missing ${field}`, payload]);
  }
  for (const amount of [-1, 0, 0.001, 1.234, 1_000_000_000.01, '100', null]) {
    cases.push([`invalid deducted amount ${JSON.stringify(amount)}`, { ...withdrawal, amount }]);
  }
  for (const receivedAmount of [-1, 0.001, 1.234, 1_000_000_000.01, '90', null]) {
    cases.push([`invalid proceeds ${JSON.stringify(receivedAmount)}`, { ...withdrawal, receivedAmount }]);
  }
  for (const overrides of [
    { fromType: 'liability' }, { toType: 'bank' }, { fromId: '' }, { toId: ' ' },
    { date: '2026-02-30' }, { date: '1999-12-31' }, { date: '2101-01-01' },
    { notes: 'x'.repeat(1001) },
  ]) cases.push([`invalid fields ${JSON.stringify(overrides).slice(0, 100)}`, { ...valid, ...overrides }]);
  for (const [name, payload, errorPattern] of cases) {
    await t.test(name, async () => rejectedWithoutChanges(api, () => api.post('/api/transactions').send(payload), errorPattern));
  }
  assert.deepEqual((await state(api)).transactions, []);
  // An earlier rejected atomic write must not poison the queue for future writes.
  await api.post('/api/transactions').send(valid).expect(201);
});

test('deposits exceeding supported investment value or cost fail atomically', async (t) => {
  const { api } = fixture(t);
  const bank = await account(api);
  for (const overrides of [{ value: 1_000_000_000, cost: 10 }, { value: 10, cost: 1_000_000_000 }]) {
    const holding = await investment(api, overrides);
    await rejectedWithoutChanges(api, () => api.post('/api/transactions').send(transfer(bank, holding, { amount: 0.01 })), /exceeds the supported limit/);
  }
});

test('transfer records are immutable and linked accounts and assets cannot be deleted or converted to liabilities', async (t) => {
  const { api } = fixture(t);
  const bank = await account(api);
  const savings = await account(api, { name: 'Savings' });
  const holding = await investment(api);
  const records = [];
  for (const payload of [transfer(bank, savings), transfer(bank, holding), transfer(holding, savings, { receivedAmount: 80 })]) {
    records.push((await api.post('/api/transactions').send(payload).expect(201)).body);
  }
  for (const record of records) {
    await rejectedWithoutChanges(api, () => api.put(`/api/transactions/${record.id}`).send({ ...record, amount: 1 }), /read-only/);
    await rejectedWithoutChanges(api, () => api.put(`/api/transactions/${record.id}`).send({ type: 'expense', accountId: bank.id, date, amount: 1, category: 'Food' }), /read-only/);
    await rejectedWithoutChanges(api, () => api.delete(`/api/transactions/${record.id}`).send({}), /read-only/);
  }
  for (const endpoint of [`accounts/${bank.id}`, `accounts/${savings.id}`, `investments/${holding.id}`]) {
    await rejectedWithoutChanges(api, () => api.delete(`/api/${endpoint}`).send({}), /transfer history.*cannot be deleted/);
  }
  const current = (await state(api)).investments[0];
  await rejectedWithoutChanges(api, () => api.put(`/api/investments/${holding.id}`).send({ ...current, type: 'liability' }), /must remain an asset/);
});

test('an ordinary transaction cannot be converted into a transfer', async (t) => {
  const { api } = fixture(t);
  const bank = await account(api);
  const holding = await investment(api);
  const { body: record } = await api.post('/api/transactions').send({ type: 'income', accountId: bank.id, date, amount: 20, category: 'Salary' }).expect(201);
  await rejectedWithoutChanges(api, () => api.put(`/api/transactions/${record.id}`).send(transfer(bank, holding)), /instead of converting/);
});

test('a transaction write failure rolls back an already updated investment and its history', async (t) => {
  const { api, store } = fixture(t);
  const bank = await account(api);
  const holding = await investment(api);
  const originalPut = store.put;
  for (const payload of [transfer(bank, holding), transfer(holding, bank, { receivedAmount: 90 })]) {
    const before = await state(api);
    let holdingWasWritten = false;
    store.put = (collection, value) => {
      if (collection === 'investments') holdingWasWritten = true;
      if (collection === 'transactions') {
        const error = new Error('Simulated transaction write failure');
        error.status = 409;
        throw error;
      }
      return originalPut(collection, value);
    };
    try {
      const response = await api.post('/api/transactions').send(payload).expect(409);
      assert.equal(response.body.error, 'Simulated transaction write failure');
      assert.equal(holdingWasWritten, true, 'failure must happen after the holding write');
    } finally {
      store.put = originalPut;
    }
    assert.deepEqual(await state(api), before);
  }
  await api.post('/api/transactions').send(transfer(bank, holding)).expect(201);
  assert.equal((await state(api)).investments[0].value, 400);
});

test('concurrent bank-to-asset contributions preserve every deposit and history entry', async (t) => {
  const { api } = fixture(t);
  const bank = await account(api);
  const holding = await investment(api);
  const before = await state(api);
  const amounts = [0.1, 0.2, 25, 75.05];
  const results = await Promise.all(amounts.map((amount, index) => api.post('/api/transactions').send(transfer(bank, holding, { amount, notes: `Concurrent deposit ${index}` })).expect(201)));
  const after = await state(api);
  assert.equal(after.balances[bank.id], 899.65);
  assert.equal(after.investments[0].value, 400.35);
  assert.equal(after.investments[0].cost, 300.35);
  assert.equal(after.transactions.length, amounts.length);
  assert.equal(after.investments[0].history.length, holding.history.length + amounts.length);
  assert.equal(netWorth(after), netWorth(before));
  assert.deepEqual(after.investments[0].history.slice(0, holding.history.length), holding.history);
  const ids = results.map(({ body }) => body.id);
  assert.equal(new Set(ids).size, amounts.length);
  assert.deepEqual(after.investments[0].history.slice(holding.history.length).map((entry) => entry.transferId).sort(), [...ids].sort());
  let valueCents = 30000;
  let costCents = 20000;
  for (const entry of after.investments[0].history.slice(holding.history.length)) {
    const record = after.transactions.find((item) => item.id === entry.transferId);
    valueCents += Math.round(record.amount * 100);
    costCents += Math.round(record.amount * 100);
    assert.deepEqual(entry, { date, value: valueCents / 100, cost: costCents / 100, transferId: record.id });
  }
});

test('competing asset withdrawals permit only one when combined deductions exceed available value', async (t) => {
  const { api } = fixture(t);
  const bank = await account(api);
  const savings = await account(api, { name: 'Savings', openingBalance: 0 });
  const holding = await investment(api, { value: 100, cost: 80 });
  const before = await state(api);
  const results = await Promise.all([
    api.post('/api/transactions').send(transfer(holding, bank, { amount: 60, receivedAmount: 55, notes: 'First contender' })),
    api.post('/api/transactions').send(transfer(holding, savings, { amount: 60, receivedAmount: 70, notes: 'Second contender' })),
  ]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 400]);
  assert.match(results.find((response) => response.status === 400).body.error, /exceeds the investment value/);
  const winner = results.find((response) => response.status === 201).body;
  assert.equal(winner.costBasisRemoved, 48);
  const after = await state(api);
  assert.deepEqual(after.transactions, [winner]);
  assert.equal(after.balances[bank.id], before.balances[bank.id] + (winner.toId === bank.id ? winner.receivedAmount : 0));
  assert.equal(after.balances[savings.id], winner.toId === savings.id ? winner.receivedAmount : 0);
  assert.deepEqual(after.investments[0], { ...holding, value: 40, cost: 32, date, history: [...holding.history, { date, value: 40, cost: 32, transferId: winner.id }] });
  assert.equal(netWorth(after), netWorth(before) - 60 + winner.receivedAmount);
  // Exhaust the exact remainder to prove the failed contender left no partial deduction.
  await api.post('/api/transactions').send(transfer(holding, bank, { amount: 40, receivedAmount: 40 })).expect(201);
  const final = await state(api);
  assert.equal(final.investments[0].value, 0);
  assert.equal(final.investments[0].cost, 0);
  assert.equal(final.transactions.length, 2);
});