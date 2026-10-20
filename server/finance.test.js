import test from 'node:test';
import assert from 'node:assert/strict';
import { accountBalance, budgetHistory, categoryBudgetStatus, csv, goalNetWorth, goalProgress, insights, monthsBetween, suggestCategory } from './finance.js';

test('month ranges cross year boundaries and include months without transactions', () => {
  assert.deepEqual(monthsBetween('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
});
test('budget surplus and deficit carry forward with repeating budget and effective changes', () => {
  const budgets = [{ month: '2026-01', amount: 100 }, { month: '2026-03', amount: 200 }];
  const transactions = [{ date: '2026-01-01', type: 'expense', amount: 150 }, { date: '2026-02-01', type: 'expense', amount: 20 }, { date: '2026-02-02', type: 'income', amount: 1000 }];
  const history = budgetHistory(budgets, transactions, '2026-03');
  assert.equal(history[0].remaining, -50);
  assert.equal(history[1].available, 50);
  assert.equal(history[1].remaining, 30);
  assert.equal(history[2].available, 230);
  assert.equal(history[2].remaining, 230);
  assert.deepEqual(budgetHistory(budgets, transactions, '2025-12'), []);
});
test('money math avoids decimal drift and supports negative balances', () => {
  const transactions = [{ date: '2026-01-01', accountId: 'a', type: 'expense', amount: 0.1 }, { date: '2026-01-02', accountId: 'a', type: 'expense', amount: 0.2 }];
  assert.equal(budgetHistory([{ month: '2026-01', amount: 0.3 }], transactions, '2026-01')[0].remaining, 0);
  assert.equal(accountBalance({ id: 'a', openingBalance: 0 }, transactions), -0.3);
});
test('category budgets total selected categories and carry over month to month', () => {
  const budgets = [{ id: 'essentials', name: 'Essentials', month: '2026-01', amount: 300, categories: ['Food', 'Rent', 'Utilities'] }];
  const transactions = [
    { date: '2026-01-01', type: 'expense', amount: 200, category: 'Food' },
    { date: '2026-01-02', type: 'expense', amount: 150, category: 'Rent' },
    { date: '2026-01-03', type: 'expense', amount: 900, category: 'Travel' },
    { date: '2026-02-01', type: 'expense', amount: 100, category: 'Utilities' },
  ];
  const status = categoryBudgetStatus(budgets, transactions, '2026-02');
  assert.equal(status[0].spent, 100);
  assert.equal(status[0].available, 250);
  assert.equal(status[0].remaining, 150);
});
test('All category budgets include expenses in every category', () => {
  const status = categoryBudgetStatus([{ id: 'all', name: 'All', month: '2026-01', amount: 100, categories: ['All'] }], [
    { date: '2026-01-01', type: 'expense', amount: 25, category: 'Food' },
    { date: '2026-01-02', type: 'expense', amount: 35, category: 'Pet care' },
    { date: '2026-01-03', type: 'income', amount: 1000, category: 'Salary' },
  ], '2026-01');
  assert.equal(status[0].spent, 60);
  assert.equal(status[0].remaining, 40);
});
test('category budgets can disable carryover while older budgets keep it enabled', () => {
  const transactions = [
    { date: '2026-01-01', type: 'expense', amount: 120, category: 'Food' },
    { date: '2026-02-01', type: 'expense', amount: 20, category: 'Food' },
  ];
  const withoutCarryover = categoryBudgetStatus([{ id: 'fixed', name: 'Fixed', month: '2026-01', amount: 100, categories: ['Food'], carryoverEnabled: false, includeInTotal: false }], transactions, '2026-02')[0];
  assert.equal(withoutCarryover.available, 100);
  assert.equal(withoutCarryover.remaining, 80);
  assert.equal(withoutCarryover.carryoverEnabled, false);
  assert.equal(withoutCarryover.includeInTotal, false);
  const legacy = categoryBudgetStatus([{ id: 'legacy', name: 'Legacy', month: '2026-01', amount: 100, categories: ['Food'] }], transactions, '2026-02')[0];
  assert.equal(legacy.available, 80);
  assert.equal(legacy.carryoverEnabled, true);
  assert.equal(legacy.includeInTotal, true);
});
test('budget adjustments modify available total and carry forward independently of base', () => {
  const budget = { id: 'shopping', name: 'Shopping', month: '2026-01', amount: 3000, categories: ['Shopping'], adjustments: [{ month: '2026-02', amount: 5000 }, { month: '2026-02', amount: -1000 }] };
  const status = categoryBudgetStatus([budget], [], '2026-02')[0];
  assert.equal(status.base, 3000);
  assert.equal(status.adjustment, 4000);
  assert.equal(status.available, 10000);
  assert.equal(status.remaining, 10000);
});
test('monthly goals reset their view without losing previous contributions', () => {
  const goal = { type: 'monthly', contributions: [{ date: '2026-01-01', amount: 10 }, { date: '2026-02-02', amount: 25 }] };
  assert.equal(goalProgress(goal, '2026-02'), 25);
  assert.equal(goalProgress({ ...goal, type: 'unlimited' }, '2026-02'), 35);
  assert.equal(goalProgress(goal, '2026-03'), 0);
  assert.equal(goalProgress(goal), 35);
  assert.equal(goalProgress({ type: 'monthly', contributions: [...goal.contributions, { date: '2026-02-03', amount: -5 }] }, '2026-02'), 20);
});
test('goal balances affect net worth as savings assets or remaining debt', () => {
  assert.equal(goalNetWorth({ purpose: 'savings', contributions: [{ date: '2026-01-01', amount: 500 }, { date: '2026-02-01', amount: -75 }] }), 425);
  assert.equal(goalNetWorth({ purpose: 'savings', contributions: [{ date: '2026-01-01', amount: -75 }] }), 0);
  assert.equal(goalNetWorth({ purpose: 'debt', targetAmount: 1000, contributions: [{ date: '2026-01-01', amount: 300 }] }), -700);
  assert.equal(goalNetWorth({ purpose: 'debt', targetAmount: 1000, contributions: [{ date: '2026-01-01', amount: 1100 }] }), 0);
  assert.equal(goalNetWorth({ purpose: 'savings' }), 0);
});
test('CSV escapes quotes, separators, newlines and spreadsheet formulas', () => {
  const result = csv([['=HYPERLINK("bad")', 'a,b', 'two\nlines', '-cmd']]);
  assert.ok(result.startsWith('\ufeff'));
  assert.ok(result.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(result.includes('"a,b"'));
  assert.ok(result.includes('"\'-cmd"'));
});
test('categorization is deterministic and insights need enough history', () => {
  assert.equal(suggestCategory('Groceries at the supermarket'), 'Food');
  assert.equal(suggestCategory('Uber home'), 'Transport');
  assert.equal(suggestCategory('Something unexpected'), 'Other');
  const prior = [1, 2, 3].map((day) => ({ id: `old-${day}`, date: `2026-01-0${day}`, category: 'Food', type: 'expense', amount: 100 }));
  const result = insights([...prior, { id: 'unusual', date: '2026-02-01', type: 'expense', category: 'Food', amount: 900 }], '2026-02');
  assert.equal(result.suggestedBudget, 300);
  assert.deepEqual(result.anomalies, ['unusual']);
  assert.equal(insights([], '2026-02').suggestedBudget, null);
});