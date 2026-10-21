// Sum minor units so monthly cash movement is accurate to the paise.
export function accountFlow(accountId, transactions, month) {
  const totals = { income: 0, expenses: 0, transfersIn: 0, transfersOut: 0 };
  for (const transaction of transactions) {
    if (!transaction.date.startsWith(month)) continue;
    if (transaction.type === 'transfer') {
      if (transaction.fromType === 'account' && transaction.fromId === accountId) totals.transfersOut += Math.round(transaction.amount * 100);
      if (transaction.toType === 'account' && transaction.toId === accountId) totals.transfersIn += Math.round(transaction.receivedAmount * 100);
    } else if (transaction.accountId === accountId) {
      if (transaction.type === 'income') totals.income += Math.round(transaction.amount * 100);
      if (transaction.type === 'expense') totals.expenses += Math.round(transaction.amount * 100);
    }
  }
  return Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / 100]));
}