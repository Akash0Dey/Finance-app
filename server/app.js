import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { accountBalance, categories, categoryBudgetStatus, cents, money, csv, goalNetWorth, goalProgress, insights, suggestCategory } from './finance.js';
import { installAuth } from './auth.js';

const text = z.string().trim().min(1).max(120);
const amount = z.number().finite().positive().max(1_000_000_000).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001, 'Use at most two decimal places');
const signedAmount = z.number().finite().min(-1_000_000_000).max(1_000_000_000).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001, 'Use at most two decimal places');
const signedProgress = signedAmount.refine((n) => n !== 0, 'Progress adjustment cannot be zero');
const date = z.iso.date().refine((d) => d >= '2000-01-01' && d <= '2100-12-31', 'Date must be between 2000 and 2100');
const month = z.string().regex(/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/);
const schemas = {
  accounts: z.object({ name: text, type: z.enum(['bank', 'cash', 'credit', 'savings']), openingBalance: signedAmount }),
  transactions: z.object({ type: z.enum(['income', 'expense']), date, amount, category: text, accountId: text, notes: z.string().trim().max(1000).default('') }),
  categoryBudgets: z.object({ name: text, month, amount, categories: z.array(text).min(1).max(50).refine((items) => new Set(items.map((item) => item.toLowerCase())).size === items.length, 'Choose each category only once').refine((items) => !items.some((item) => item.toLowerCase() === 'all') || items.length === 1 && items[0] === 'All', 'All must be the only selected category'), carryoverEnabled: z.boolean().default(true), includeInTotal: z.boolean().default(true) }),
  categories: z.object({ name: text }),
  goals: z.object({ name: text, type: z.enum(['monthly', 'deadline', 'unlimited']), purpose: z.enum(['savings', 'debt']), targetAmount: amount, deadline: date.nullable().default(null), status: z.enum(['active', 'achieved', 'abandoned']).default('active') }).refine((g) => g.type !== 'deadline' || g.deadline, 'Deadline goals need a target date'),
  investments: z.object({ name: text, type: z.enum(['asset', 'liability']), value: signedAmount.refine((v) => v >= 0, 'Value cannot be negative'), cost: signedAmount.refine((v) => v >= 0, 'Cost cannot be negative'), startDate: date.optional(), date, notes: z.string().trim().max(1000).default('') }),
};
const today = () => new Date().toLocaleDateString('en-CA');
const transferSchema = z.object({
  type: z.literal('transfer'), date, amount, receivedAmount: signedAmount.refine((n) => n >= 0, 'Received amount cannot be negative').optional(),
  fromType: z.enum(['account', 'investment']), fromId: text,
  toType: z.enum(['account', 'investment']), toId: text,
  notes: z.string().trim().max(1000).default(''),
});

export function createApp(store, { production = false, publicOrigin, trustProxy = false } = {}) {
  if (production && (!publicOrigin || new URL(publicOrigin).protocol !== 'https:' || new URL(publicOrigin).origin !== publicOrigin)) throw new Error('Production requires PUBLIC_ORIGIN as an exact HTTPS origin, without a trailing slash.');
  const app = express();
  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    if (production) {
      res.set('Strict-Transport-Security', 'max-age=31536000');
      res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    }
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-origin writes are not allowed' });
      if (production && origin !== publicOrigin) return res.status(403).json({ error: 'Cross-origin writes are not allowed' });
      if (origin) {
        let hostname;
        try { hostname = new URL(origin).host; } catch { return res.status(403).json({ error: 'Invalid origin' }); }
        if (!production && hostname !== req.get('host')) return res.status(403).json({ error: 'Cross-origin writes are not allowed' });
      }
      if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON data' });
    }
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  installAuth(app, store, { production });
  const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
  const allCategories = async (db) => [...new Set([...categories, ...(await db.all('categories')).map((category) => category.name), ...(await db.all('transactions')).filter((t) => t.type !== 'transfer').map((transaction) => transaction.category)])];
  const write = (handler) => async (req, res) => {
    const { body, status = 200 } = await store.atomic((tx) => handler(req, tx));
    res.status(status).json(body);
  };
  const reverseTransfer = async (tx, record, action) => {
    const holdingId = record.fromType === 'investment' ? record.fromId : record.toType === 'investment' ? record.toId : null;
    if (!holdingId) return;
    const holding = await tx.get('investments', holdingId);
    if (!holding) fail('The original investment no longer exists');
    let latest;
    for (const entry of [...(holding.history ?? [])].reverse()) {
      if (entry.action) continue;
      if (entry.transferId) {
        const active = await tx.get('transactions', entry.transferId);
        if (!active || !(active.fromType === 'investment' && active.fromId === holdingId || active.toType === 'investment' && active.toId === holdingId)) continue;
      }
      latest = entry;
      break;
    }
    const current = holding.history?.at(-1);
    if (latest?.transferId !== record.id || cents(current?.value) !== cents(holding.value) || cents(current?.cost) !== cents(holding.cost)) fail('This investment has later activity. Remove or correct its most recent activity first.');
    const withdrawing = record.fromType === 'investment';
    const value = money(cents(holding.value) + (withdrawing ? 1 : -1) * cents(record.amount));
    const cost = money(cents(holding.cost) + (withdrawing ? cents(record.costBasisRemoved) : -cents(record.amount)));
    if (![value, cost].every((n) => Number.isFinite(n) && n >= 0 && n <= 1_000_000_000)) fail('Cannot safely reverse this transfer with the current investment value and cost');
    await tx.put('investments', { ...holding, value, cost, date: today(), history: [...holding.history, { date: today(), value, cost, transferId: record.id, action }] });
  };

  app.get('/api/state', async (req, res) => {
    const selected = month.parse(req.query.month ?? today().slice(0, 7));
    const { data, names } = await store.atomic(async (tx) => ({
      data: Object.fromEntries(await Promise.all(Object.keys(schemas).map(async (key) => [key, await tx.all(key)]))),
      names: await allCategories(tx),
    }));
    res.json({ ...data, categories: names, balances: Object.fromEntries(data.accounts.map((a) => [a.id, accountBalance(a, data.transactions)])), categoryBudgetStatus: categoryBudgetStatus(data.categoryBudgets, data.transactions, selected), progress: Object.fromEntries(data.goals.map((g) => [g.id, goalProgress(g, selected)])), totalProgress: Object.fromEntries(data.goals.map((g) => [g.id, goalProgress(g)])), goalNetWorth: Object.fromEntries(data.goals.map((g) => [g.id, goalNetWorth(g)])), goalNetWorthTotal: data.goals.reduce((total, goal) => total + goalNetWorth(goal), 0), insights: insights(data.transactions, selected) });
  });

  app.get('/api/export', async (req, res) => {
    const [accounts, transactions] = await store.atomic(async (tx) => [await tx.all('accounts'), await tx.all('transactions')]);
    const rows = transactions.filter((t) => (!req.query.month || t.date.startsWith(String(req.query.month))) && (!req.query.type || t.type === req.query.type) && (!req.query.accountId || t.accountId === req.query.accountId || t.fromType === 'account' && t.fromId === req.query.accountId || t.toType === 'account' && t.toId === req.query.accountId) && (!req.query.investmentId || t.fromType === 'investment' && t.fromId === req.query.investmentId || t.toType === 'investment' && t.toId === req.query.investmentId) && (!req.query.category || t.category === req.query.category) && (!req.query.search || `${t.notes} ${t.category} ${t.fromName ?? ''} ${t.toName ?? ''}`.toLowerCase().includes(String(req.query.search).toLowerCase())));
    res.type('text/csv').attachment('pocket-transactions.csv').send(csv([['Date', 'Type', 'Amount', 'Category', 'Account', 'Notes', 'From', 'To', 'Received amount', 'Cost basis removed'], ...rows.map((t) => [t.date, t.type, t.amount, t.category, accounts.find((a) => a.id === t.accountId)?.name, t.notes, t.fromName, t.toName, t.receivedAmount, t.costBasisRemoved])]));
  });

  app.post('/api/smart-entry', async (req, res) => {
    const { input } = z.object({ input: z.string().trim().min(1).max(500) }).parse(req.body);
    const number = input.match(/(?:₹|\$|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
    const account = (await store.all('accounts')).find((a) => input.toLowerCase().includes(a.name.toLowerCase()));
    const explicitDate = input.match(/\b20\d{2}-\d{2}-\d{2}\b/);
    const category = suggestCategory(input);
    res.json({ type: /salary|received|income|paycheck/i.test(input) ? 'income' : 'expense', amount: number ? Number(number[1].replaceAll(',', '')) : '', category, accountId: account?.id ?? '', date: explicitDate && date.safeParse(explicitDate[0]).success ? explicitDate[0] : today(), notes: input });
  });

  app.post('/api/goals/:id/contributions', write(async (req, tx) => {
    const goal = await tx.get('goals', req.params.id) ?? fail('Goal not found', 404);
    if (goal.status !== 'active') fail('Only active goals accept contributions');
    const contribution = z.object({ amount: signedProgress, date }).parse(req.body);
    return { body: await tx.put('goals', { ...goal, contributions: [...(goal.contributions ?? []), { ...contribution, id: randomUUID() }] }) };
  }));

  app.post('/api/categoryBudgets/:id/adjustments', write(async (req, tx) => {
    const budget = await tx.get('categoryBudgets', req.params.id) ?? fail('Budget not found', 404);
    const adjustment = z.object({ amount: signedProgress, month, note: z.string().trim().max(240).default('') }).parse(req.body);
    if (adjustment.month < budget.month) fail('An adjustment cannot be dated before the budget starts');
    return { status: 201, body: await tx.put('categoryBudgets', { ...budget, adjustments: [...(budget.adjustments ?? []), { ...adjustment, id: randomUUID() }] }) };
  }));

  app.post('/api/demo', write(async (req, tx) => {
    if (production) fail('Demo data is unavailable in production', 404);
    for (const key of Object.keys(schemas)) if ((await tx.all(key)).length) fail('Demo data can only be loaded into an empty app');
      const current = today().slice(0, 7);
      const account = await tx.put('accounts', { id: randomUUID(), name: 'HDFC Bank', type: 'bank', openingBalance: 85000 });
      await tx.put('accounts', { id: randomUUID(), name: 'Savings account', type: 'savings', openingBalance: 140000 });
      for (const [day, value, category, notes, type] of [[1, 95000, 'Salary', 'October salary', 'income'], [2, 18000, 'Rent', 'A place to call home', 'expense'], [4, 2400, 'Food', 'Weekly groceries', 'expense'], [6, 850, 'Transport', 'Fuel & a weekend drive', 'expense'], [8, 1499, 'Utilities', 'Internet subscription', 'expense'], [10, 1800, 'Food', 'Dinner with friends', 'expense'], [12, 3200, 'Shopping', 'A little something for home', 'expense'], [14, 599, 'Entertainment', 'Netflix subscription', 'expense'], [16, 1250, 'Food', 'Groceries & coffee', 'expense']]) {
        await tx.put('transactions', { id: randomUUID(), date: `${current}-${String(day).padStart(2, '0')}`, type, amount: value, category, notes: notes.replace('October', new Date().toLocaleString('en', { month: 'long' })), accountId: account.id });
      }
      for (const [name, targetAmount, saved, purpose] of [['Emergency fund', 300000, 126000, 'savings'], ['Japan, here I come', 180000, 72000, 'savings'], ['Student loan', 200000, 45000, 'debt']]) await tx.put('goals', { id: randomUUID(), name, type: 'unlimited', purpose, targetAmount, deadline: null, status: 'active', contributions: [{ id: randomUUID(), amount: saved, date: today() }] });
      await tx.put('investments', { id: randomUUID(), name: 'Index fund portfolio', type: 'asset', value: 275000, cost: 240000, date: today(), notes: 'Long-term investing', history: [{ date: today(), value: 275000 }] });
    return { status: 201, body: { ok: true } };
  }));

  for (const [collection, schema] of Object.entries(schemas)) {
    if (collection === 'categories') continue;
    const save = write(async (req, tx) => {
      const old = req.params.id ? await tx.get(collection, req.params.id) : null;
      if (req.params.id && !old) fail('Record not found', 404);
      if (collection === 'transactions' && old?.type === 'transfer' && req.body.type !== 'transfer') fail('A transfer must remain a transfer');
      if (collection === 'transactions' && req.body.type === 'transfer') {
        if (old && old.type !== 'transfer') fail('Create a new transfer instead of converting an existing transaction');
        const transfer = transferSchema.parse(req.body);
        if (transfer.fromType === transfer.toType && transfer.fromId === transfer.toId) fail('Choose different source and destination');
        if (transfer.fromType === 'investment' && transfer.toType !== 'account') fail('Investment transfers must go to an account');
        if (transfer.fromType === 'account' && transfer.receivedAmount !== undefined && cents(transfer.receivedAmount) !== cents(transfer.amount)) fail('Account transfers must send and receive the same amount');
        const receivedAmount = transfer.fromType === 'account' ? transfer.amount : transfer.receivedAmount;
        const sameMovement = old && ['fromType', 'fromId', 'toType', 'toId', 'amount'].every((key) => transfer[key] === old[key]) && receivedAmount === old.receivedAmount;
        if (sameMovement) {
          // Metadata-only edits must not recalculate an earlier withdrawal's basis.
          return { body: await tx.put('transactions', { ...old, date: transfer.date, notes: transfer.notes }) };
        }
        if (old) await reverseTransfer(tx, old, 'edit-reversal');
        const source = await tx.get(transfer.fromType === 'account' ? 'accounts' : 'investments', transfer.fromId);
        const destination = await tx.get(transfer.toType === 'account' ? 'accounts' : 'investments', transfer.toId);
        if (!source || !destination) fail('Choose an existing source and destination');
        const holding = transfer.fromType === 'investment' ? source : transfer.toType === 'investment' ? destination : null;
        if (holding && holding.type !== 'asset') fail('Only investment assets support transfers');
        if (transfer.fromType === 'investment' && transfer.receivedAmount === undefined) fail('Enter the amount received in the bank');
        if (transfer.fromType === 'account' && transfer.receivedAmount !== undefined && cents(transfer.receivedAmount) !== cents(transfer.amount)) fail('Account transfers must send and receive the same amount');
        const record = { ...transfer, id: old?.id ?? randomUUID(), receivedAmount: transfer.fromType === 'account' ? transfer.amount : transfer.receivedAmount, category: 'Transfer', fromName: source.name, toName: destination.name };
        if (holding) {
          const withdrawing = transfer.fromType === 'investment';
          if (withdrawing && cents(transfer.amount) > cents(holding.value)) fail('Deducted amount exceeds the investment value');
          // BigInt avoids precision loss when multiplying large minor-unit amounts.
          const removed = withdrawing ? Number((2n * BigInt(cents(holding.cost)) * BigInt(cents(transfer.amount)) + BigInt(cents(holding.value))) / (2n * BigInt(cents(holding.value)))) : 0;
          const value = money(cents(holding.value) + (withdrawing ? -1 : 1) * cents(transfer.amount));
          const cost = money(cents(holding.cost) + (withdrawing ? -removed : cents(transfer.amount)));
          if (value > 1_000_000_000 || cost > 1_000_000_000) fail('Investment value or cost exceeds the supported limit');
          record.costBasisRemoved = money(removed);
          await tx.put('investments', { ...holding, value, cost, date: transfer.date, history: [...(holding.history ?? []), { date: transfer.date, value, cost, transferId: record.id }] });
        }
        return { status: old ? 200 : 201, body: await tx.put('transactions', record) };
      }
      const body = schema.parse(req.body);
      if (collection === 'investments' && old?.type !== body.type && (await tx.all('transactions')).some((t) => t.type === 'transfer' && (t.fromType === 'investment' && t.fromId === old?.id || t.toType === 'investment' && t.toId === old?.id))) fail('An investment with transfer history must remain an asset');
      if (collection === 'transactions' && !await tx.get('accounts', body.accountId)) fail('Choose an existing account');
      if (collection === 'categoryBudgets') {
        const names = await allCategories(tx);
        const unknown = body.categories.find((name) => name !== 'All' && !names.some((category) => category.toLowerCase() === name.toLowerCase()));
        if (unknown) fail(`Create the category “${unknown}” before using it in a budget`);
        if ((await tx.all('categoryBudgets')).some((budget) => budget.id !== old?.id && budget.name.toLowerCase() === body.name.toLowerCase())) fail('A category budget with this name already exists');
      }
      const value = { ...body, id: old?.id ?? randomUUID() };
      if (collection === 'goals') value.contributions = old?.contributions ?? [];
      if (collection === 'categoryBudgets') value.adjustments = old?.adjustments ?? [];
      if (collection === 'investments') value.startDate = body.startDate ?? old?.startDate ?? body.date;
      if (collection === 'investments') value.history = [...(old?.history ?? []), ...(old?.value !== body.value ? [{ date: body.date, value: body.value }] : [])];
      return { status: old ? 200 : 201, body: await tx.put(collection, value) };
    });
    app.post(`/api/${collection}`, save);
    app.put(`/api/${collection}/:id`, save);
    app.delete(`/api/${collection}/:id`, write(async (req, tx) => {
      const record = await tx.get(collection, req.params.id);
      if (!record) fail('Record not found', 404);
      if (collection === 'transactions' && record.type === 'transfer') await reverseTransfer(tx, record, 'delete-reversal');
      const linkedType = collection === 'accounts' ? 'account' : collection === 'investments' ? 'investment' : null;
      if (linkedType && (await tx.all('transactions')).some((t) => t.type === 'transfer' && (t.fromType === linkedType && t.fromId === record.id || t.toType === linkedType && t.toId === record.id))) fail('This record has transfer history and cannot be deleted');
      if (collection === 'accounts' && (await tx.all('transactions')).some((t) => t.accountId === req.params.id)) fail('Delete or reassign this account’s transactions first');
      await tx.delete(collection, req.params.id);
      return { body: { ok: true } };
    }));
  }
  app.post('/api/categories', write(async (req, tx) => {
    const { name } = schemas.categories.parse(req.body);
    if (name.toLowerCase() === 'all') fail('“All” is reserved for budgets');
    if ((await allCategories(tx)).some((category) => category.toLowerCase() === name.toLowerCase())) fail('That category already exists');
    return { status: 201, body: await tx.put('categories', { id: randomUUID(), name }) };
  }));
  app.delete('/api/categories/:id', write(async (req, tx) => {
    const category = await tx.get('categories', req.params.id) ?? fail('Category not found', 404);
    if ((await tx.all('transactions')).some((transaction) => transaction.category.toLowerCase() === category.name.toLowerCase())) fail('This category is used by transactions and cannot be deleted');
    if ((await tx.all('categoryBudgets')).some((budget) => budget.categories.some((name) => name.toLowerCase() === category.name.toLowerCase()))) fail('Remove this category from its budget before deleting it');
    await tx.delete('categories', category.id);
    return { body: { ok: true } };
  }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));
  app.use((error, req, res, next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map((i) => `${i.path.join('.') || 'Input'}: ${i.message}`).join('; ') });
    const status = error.status ?? 500;
    if (status === 500) console.error('API request failed. Check database connectivity and server configuration.');
    res.status(status).json({ error: status === 500 ? 'An unexpected error occurred' : error.message });
  });
  return app;
}