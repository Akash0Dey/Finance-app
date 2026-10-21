import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFlow } from '../src/account-flow.js';

const month = '2026-10';
const transfer = (overrides = {}) => ({ type: 'transfer', date: '2026-10-21', fromType: 'account', fromId: 'bank', toType: 'account', toId: 'cash', amount: 100, receivedAmount: 100, ...overrides });

test('monthly account activity separates income, expenses and both transfer directions', () => {
  const rows = [
    { type: 'income', date: '2026-10-01', accountId: 'bank', amount: 500 },
    { type: 'expense', date: '2026-10-02', accountId: 'bank', amount: 25 },
    transfer(),
    transfer({ fromType: 'investment', fromId: 'fund', toId: 'bank', amount: 200, receivedAmount: 190 }),
    transfer({ toType: 'investment', toId: 'fund', amount: 50, receivedAmount: 50 }),
    transfer({ date: '2026-09-21', amount: 999, receivedAmount: 999 }),
    { type: 'income', date: '2026-10-01', accountId: 'other', amount: 999 },
  ];
  assert.deepEqual(accountFlow('bank', rows, month), { income: 500, expenses: 25, transfersIn: 190, transfersOut: 150 });
  assert.deepEqual(accountFlow('cash', rows, month), { income: 0, expenses: 0, transfersIn: 100, transfersOut: 0 });
  assert.deepEqual(accountFlow('bank', rows, '2026-09'), { income: 0, expenses: 0, transfersIn: 0, transfersOut: 999 });
});

test('monthly account activity handles empty months, zero receipts and paise precisely', () => {
  assert.deepEqual(accountFlow('bank', [], month), { income: 0, expenses: 0, transfersIn: 0, transfersOut: 0 });
  const rows = [transfer({ amount: 0.1, receivedAmount: 0.1 }), transfer({ amount: 0.2, receivedAmount: 0.2 }), transfer({ fromType: 'investment', fromId: 'fund', amount: 1, receivedAmount: 0 })];
  assert.equal(accountFlow('bank', rows, month).transfersOut, 0.3);
  assert.equal(accountFlow('cash', rows, month).transfersIn, 0.3);
  assert.equal(accountFlow('bank', rows, '2026-11').transfersOut, 0);
});