export const categories = ['Food', 'Transport', 'Utilities', 'Rent', 'Salary', 'Investment', 'Shopping', 'Health', 'Entertainment', 'Other'];
export const monthOf = (date) => date.slice(0, 7);
export const cents = (amount) => Math.round(Number(amount) * 100);
export const money = (amount) => amount / 100;

export function monthsBetween(first, last) {
  const result = [];
  for (let month = first; month <= last;) {
    result.push(month);
    const [year, number] = month.split('-').map(Number);
    month = number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
  }
  return result;
}

export function budgetHistory(budgets, transactions, until, carryoverEnabled = true, adjustments = []) {
  const sorted = [...budgets].sort((a, b) => a.month.localeCompare(b.month));
  if (!sorted.length || sorted[0].month > until) return [];
  let carry = 0;
  return monthsBetween(sorted[0].month, until).map((month) => {
    const budget = sorted.findLast((item) => item.month <= month);
    const spent = transactions.filter((t) => t.type === 'expense' && monthOf(t.date) === month).reduce((sum, t) => sum + cents(t.amount), 0);
    const base = cents(budget.amount);
    const adjustment = adjustments.filter((item) => item.month === month).reduce((sum, item) => sum + cents(item.amount), 0);
    const available = base + (carryoverEnabled ? carry : 0) + adjustment;
    const result = { month, base: money(base), carryover: money(carry), adjustment: money(adjustment), available: money(available), spent: money(spent), remaining: money(available - spent) };
    carry = carryoverEnabled ? available - spent : 0;
    return result;
  });
}

export function categoryBudgetStatus(budgets, transactions, month) {
  return budgets.filter((budget) => budget.month <= month).map((budget) => {
    const history = budgetHistory(
      [{ month: budget.month, amount: budget.amount }],
      transactions.filter((transaction) => budget.categories.includes('All') || budget.categories.includes(transaction.category)),
      month,
      budget.carryoverEnabled !== false,
      budget.adjustments ?? [],
    );
    const current = history.at(-1);
    return { ...budget, ...current, startsAt: budget.month, spent: current?.spent ?? 0, carryoverEnabled: budget.carryoverEnabled !== false, includeInTotal: budget.includeInTotal !== false, adjustments: budget.adjustments ?? [] };
  });
}

export function accountBalance(account, transactions) {
  return money(cents(account.openingBalance) + transactions.filter((t) => t.accountId === account.id).reduce((sum, t) => sum + (t.type === 'income' ? 1 : -1) * cents(t.amount), 0));
}

export function goalProgress(goal, month) {
  return money((goal.contributions ?? []).filter((c) => month === undefined || goal.type !== 'monthly' || monthOf(c.date) === month).reduce((sum, c) => sum + cents(c.amount), 0));
}

export function goalNetWorth(goal) {
  const progress = goalProgress(goal);
  if (goal.purpose !== 'debt') return Math.max(0, progress);
  const remaining = Math.max(0, cents(goal.targetAmount ?? 0) - cents(progress));
  return remaining ? -remaining / 100 : 0;
}

export function suggestCategory(description) {
  const text = description.toLowerCase();
  for (const [category, pattern] of [
    ['Food', /grocer|food|dinner|lunch|coffee|restaurant|swiggy|zomato/],
    ['Transport', /uber|ola|taxi|fuel|petrol|train|bus/],
    ['Rent', /rent/], ['Utilities', /electric|internet|wifi|water|phone bill/],
    ['Salary', /salary|paycheck|payroll/], ['Investment', /stock|mutual fund|investment/],
    ['Health', /doctor|medicine|hospital|pharmacy/], ['Entertainment', /netflix|movie|spotify/],
    ['Shopping', /amazon|shopping|clothes/],
  ]) if (pattern.test(text)) return category;
  return 'Other';
}

export function insights(transactions, month) {
  const current = transactions.filter((t) => t.type === 'expense' && monthOf(t.date) === month);
  const prior = transactions.filter((t) => t.type === 'expense' && monthOf(t.date) < month);
  const recentMonths = [...new Set(prior.map((t) => monthOf(t.date)))].sort().slice(-3);
  const recent = prior.filter((t) => recentMonths.includes(monthOf(t.date)));
  const suggestedBudget = recentMonths.length ? Math.ceil(recent.reduce((sum, t) => sum + cents(t.amount), 0) / recentMonths.length / 100 / 100) * 100 : null;
  const anomalies = current.filter((t) => {
    const peers = recent.filter((p) => p.category === t.category);
    return peers.length >= 3 && cents(t.amount) > peers.reduce((sum, p) => sum + cents(p.amount), 0) / peers.length * 2;
  }).map((t) => t.id);
  return { suggestedBudget, anomalies };
}

export function csv(rows) {
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\ufeff' + rows.map((row) => row.map(cell).join(',')).join('\r\n');
}