import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { accountBalance, categories, categoryBudgetStatus, csv, goalNetWorth, goalProgress, insights, suggestCategory } from './finance.js';
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
  const allCategories = () => [...new Set([...categories, ...store.all('categories').map((category) => category.name), ...store.all('transactions').map((transaction) => transaction.category)])];

  app.get('/api/state', (req, res) => {
    const selected = month.parse(req.query.month ?? today().slice(0, 7));
    const data = Object.fromEntries(Object.keys(schemas).map((key) => [key, store.all(key)]));
    res.json({ ...data, categories: allCategories(), balances: Object.fromEntries(data.accounts.map((a) => [a.id, accountBalance(a, data.transactions)])), categoryBudgetStatus: categoryBudgetStatus(data.categoryBudgets, data.transactions, selected), progress: Object.fromEntries(data.goals.map((g) => [g.id, goalProgress(g, selected)])), totalProgress: Object.fromEntries(data.goals.map((g) => [g.id, goalProgress(g)])), goalNetWorth: Object.fromEntries(data.goals.map((g) => [g.id, goalNetWorth(g)])), goalNetWorthTotal: data.goals.reduce((total, goal) => total + goalNetWorth(goal), 0), insights: insights(data.transactions, selected) });
  });

  app.get('/api/export', (req, res) => {
    const accounts = store.all('accounts');
    const rows = store.all('transactions').filter((t) => (!req.query.month || t.date.startsWith(String(req.query.month))) && (!req.query.accountId || t.accountId === req.query.accountId) && (!req.query.category || t.category === req.query.category) && (!req.query.search || `${t.notes} ${t.category}`.toLowerCase().includes(String(req.query.search).toLowerCase())));
    res.type('text/csv').attachment('pocket-transactions.csv').send(csv([['Date', 'Type', 'Amount', 'Category', 'Account', 'Notes'], ...rows.map((t) => [t.date, t.type, t.amount, t.category, accounts.find((a) => a.id === t.accountId)?.name, t.notes])]));
  });

  app.post('/api/smart-entry', (req, res) => {
    const { input } = z.object({ input: z.string().trim().min(1).max(500) }).parse(req.body);
    const number = input.match(/(?:₹|\$|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)/i);
    const account = store.all('accounts').find((a) => input.toLowerCase().includes(a.name.toLowerCase()));
    const explicitDate = input.match(/\b20\d{2}-\d{2}-\d{2}\b/);
    const category = suggestCategory(input);
    res.json({ type: /salary|received|income|paycheck/i.test(input) ? 'income' : 'expense', amount: number ? Number(number[1].replaceAll(',', '')) : '', category, accountId: account?.id ?? '', date: explicitDate && date.safeParse(explicitDate[0]).success ? explicitDate[0] : today(), notes: input });
  });

  app.post('/api/goals/:id/contributions', (req, res) => {
    const goal = store.get('goals', req.params.id) ?? fail('Goal not found', 404);
    if (goal.status !== 'active') fail('Only active goals accept contributions');
    const contribution = z.object({ amount: signedProgress, date }).parse(req.body);
    res.json(store.put('goals', { ...goal, contributions: [...(goal.contributions ?? []), { ...contribution, id: randomUUID() }] }));
  });

  app.post('/api/categoryBudgets/:id/adjustments', (req, res) => {
    const budget = store.get('categoryBudgets', req.params.id) ?? fail('Budget not found', 404);
    const adjustment = z.object({ amount: signedProgress, month, note: z.string().trim().max(240).default('') }).parse(req.body);
    if (adjustment.month < budget.month) fail('An adjustment cannot be dated before the budget starts');
    res.status(201).json(store.put('categoryBudgets', { ...budget, adjustments: [...(budget.adjustments ?? []), { ...adjustment, id: randomUUID() }] }));
  });

  app.post('/api/demo', (req, res) => {
    if (production) fail('Demo data is unavailable in production', 404);
    if (Object.keys(schemas).some((key) => store.all(key).length)) fail('Demo data can only be loaded into an empty app');
    store.atomic(() => {
      const current = today().slice(0, 7);
      const account = store.put('accounts', { id: randomUUID(), name: 'HDFC Bank', type: 'bank', openingBalance: 85000 });
      const savings = store.put('accounts', { id: randomUUID(), name: 'Savings account', type: 'savings', openingBalance: 140000 });
      for (const [day, value, category, notes, type] of [[1, 95000, 'Salary', 'October salary', 'income'], [2, 18000, 'Rent', 'A place to call home', 'expense'], [4, 2400, 'Food', 'Weekly groceries', 'expense'], [6, 850, 'Transport', 'Fuel & a weekend drive', 'expense'], [8, 1499, 'Utilities', 'Internet subscription', 'expense'], [10, 1800, 'Food', 'Dinner with friends', 'expense'], [12, 3200, 'Shopping', 'A little something for home', 'expense'], [14, 599, 'Entertainment', 'Netflix subscription', 'expense'], [16, 1250, 'Food', 'Groceries & coffee', 'expense']]) {
        store.put('transactions', { id: randomUUID(), date: `${current}-${String(day).padStart(2, '0')}`, type, amount: value, category, notes: notes.replace('October', new Date().toLocaleString('en', { month: 'long' })), accountId: account.id });
      }
      for (const [name, targetAmount, saved, purpose] of [['Emergency fund', 300000, 126000, 'savings'], ['Japan, here I come', 180000, 72000, 'savings'], ['Student loan', 200000, 45000, 'debt']]) store.put('goals', { id: randomUUID(), name, type: 'unlimited', purpose, targetAmount, deadline: null, status: 'active', contributions: [{ id: randomUUID(), amount: saved, date: today() }] });
      store.put('investments', { id: randomUUID(), name: 'Index fund portfolio', type: 'asset', value: 275000, cost: 240000, date: today(), notes: 'Long-term investing', history: [{ date: today(), value: 275000 }] });
      void savings;
    });
    res.status(201).json({ ok: true });
  });

  for (const [collection, schema] of Object.entries(schemas)) {
    if (collection === 'categories') continue;
    const save = (req, res) => {
      const old = req.params.id ? store.get(collection, req.params.id) : null;
      if (req.params.id && !old) fail('Record not found', 404);
      const body = schema.parse(req.body);
      if (collection === 'transactions' && !store.get('accounts', body.accountId)) fail('Choose an existing account');
      if (collection === 'categoryBudgets') {
        const unknown = body.categories.find((name) => name !== 'All' && !allCategories().some((category) => category.toLowerCase() === name.toLowerCase()));
        if (unknown) fail(`Create the category “${unknown}” before using it in a budget`);
        if (store.all('categoryBudgets').some((budget) => budget.id !== old?.id && budget.name.toLowerCase() === body.name.toLowerCase())) fail('A category budget with this name already exists');
      }
      const value = { ...body, id: old?.id ?? randomUUID() };
      if (collection === 'goals') value.contributions = old?.contributions ?? [];
      if (collection === 'categoryBudgets') value.adjustments = old?.adjustments ?? [];
      if (collection === 'investments') value.startDate = body.startDate ?? old?.startDate ?? body.date;
      if (collection === 'investments') value.history = [...(old?.history ?? []), ...(old?.value !== body.value ? [{ date: body.date, value: body.value }] : [])];
      res.status(old ? 200 : 201).json(store.put(collection, value));
    };
    app.post(`/api/${collection}`, save);
    app.put(`/api/${collection}/:id`, save);
    app.delete(`/api/${collection}/:id`, (req, res) => {
      if (!store.get(collection, req.params.id)) fail('Record not found', 404);
      if (collection === 'accounts' && store.all('transactions').some((t) => t.accountId === req.params.id)) fail('Delete or reassign this account’s transactions first');
      store.delete(collection, req.params.id);
      res.json({ ok: true });
    });
  }
  app.post('/api/categories', (req, res) => {
    const { name } = schemas.categories.parse(req.body);
    if (name.toLowerCase() === 'all') fail('“All” is reserved for budgets');
    if (allCategories().some((category) => category.toLowerCase() === name.toLowerCase())) fail('That category already exists');
    res.status(201).json(store.put('categories', { id: randomUUID(), name }));
  });
  app.delete('/api/categories/:id', (req, res) => {
    const category = store.get('categories', req.params.id) ?? fail('Category not found', 404);
    if (store.all('transactions').some((transaction) => transaction.category.toLowerCase() === category.name.toLowerCase())) fail('This category is used by transactions and cannot be deleted');
    if (store.all('categoryBudgets').some((budget) => budget.categories.some((name) => name.toLowerCase() === category.name.toLowerCase()))) fail('Remove this category from its budget before deleting it');
    store.delete('categories', category.id);
    res.json({ ok: true });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));
  app.use((error, req, res, next) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map((i) => `${i.path.join('.') || 'Input'}: ${i.message}`).join('; ') });
    const status = error.status ?? 500;
    if (status === 500) console.error(error);
    res.status(status).json({ error: status === 500 ? 'An unexpected error occurred' : error.message });
  });
  return app;
}