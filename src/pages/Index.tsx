import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, Wallet, TrendingDown, AlertTriangle, Target, BadgeCheck, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Header } from '@/components/layout/Header';
import { StatCard } from '@/components/dashboard/StatCard';
import { HabitAlertCard } from '@/components/dashboard/HabitAlertCard';
import { ExpenseList } from '@/components/dashboard/ExpenseList';
import { SpendingChart } from '@/components/dashboard/SpendingChart';
import { WeeklyTrendChart } from '@/components/dashboard/WeeklyTrendChart';
import { AddExpenseModal } from '@/components/dashboard/AddExpenseModal';
// STRICT MODE: no new modals for Saved; templates-only will be handled later within AddExpenseModal
import { AddSavingModal } from '@/components/dashboard/AddSavingModal';
import { 
  Category,
  Expense,
  HabitAlert,
  categoryColors,
  type SpendingByCategory,
} from '@/lib/mockData';
import { toast } from '@/components/ui/sonner';
import {
  classifyExpense,
  computeCategoryCap,
  reconcileSavingsLedger,
  recordOptimizedSaving,
  recomputeAlerts,
  type SavingsSummary,
  requestGeminiAnalysis,
  requestGeminiChat,
  type AnalysisResult,
} from '@/services/ai';
import { useAuth } from '@/context/AuthContext';

const Index = () => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSavedOpen, setIsSavedOpen] = useState(false);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [alerts, setAlerts] = useState<HabitAlert[]>([]);
  const [savedSummary, setSavedSummary] = useState<SavingsSummary>({ total: 0, prevented: 0, reduced: 0, optimized: 0 });
  const [isBotOpen, setIsBotOpen] = useState(false);
  const [botLoading, setBotLoading] = useState(false);
  const [botInput, setBotInput] = useState('');
  const [botMessages, setBotMessages] = useState<Array<{ role: 'ai' | 'user'; text: string }>>([]);
  const [lastAnalysis, setLastAnalysis] = useState<AnalysisResult | null>(null);
  const [isFloatingHovered, setIsFloatingHovered] = useState(false);
  const [dismissedAlertIds, setDismissedAlertIds] = useState<Set<string>>(new Set());
  const { user } = useAuth();

  const expensesKey = user?.email ? `expenses:${user.email.toLowerCase()}` : 'expenses:guest';
  const userKey = user?.email ? user.email.toLowerCase() : 'guest';

  useEffect(() => {
    try {
      const rawExpenses = localStorage.getItem(expensesKey);
      if (rawExpenses) {
        const parsed: Expense[] = JSON.parse(rawExpenses).map((e: any) => {
          const date = new Date(e.date);
          return {
            ...e,
            date,
            source: e.source ?? 'MANUAL',
          } as Expense;
        });
        setExpenses(parsed);
        const computedAlerts = recomputeAlerts(parsed);
        setAlerts(computedAlerts);
      } else {
        setExpenses([]);
        setAlerts([]);
      }
    } catch {
      setExpenses([]);
      setAlerts([]);
    }
  }, [expensesKey]);

  useEffect(() => {
    try {
      localStorage.setItem(expensesKey, JSON.stringify(expenses));
    } catch {}
  }, [expenses, expensesKey]);
  // Do not persist alerts; they should reset on restart

  useEffect(() => {
    const { summary } = reconcileSavingsLedger({ userKey, expenses });
    setSavedSummary(summary);
  }, [expenses, userKey]);

  useEffect(() => {
    // Refresh background analysis whenever expenses change
    (async () => {
      const analysis = await requestGeminiAnalysis(expenses);
      setLastAnalysis(analysis);
      if (isBotOpen && analysis.suggestions?.length) {
        setBotMessages((msgs) => [{ role: 'ai', text: analysis.suggestions[0] }, ...msgs]);
      }
    })();
  }, [expenses]);

  const totalSpent = expenses.reduce((sum, exp) => sum + exp.amount, 0);
  const impulseSpending = expenses.filter(e => e.isImpulse).reduce((sum, exp) => sum + exp.amount, 0);
  const badAlerts = alerts.filter((a) => a.severity === 'bad');
  const potentialSavings = badAlerts.reduce((sum, alert) => sum + alert.savingPotential, 0);
  const [applySavings, setApplySavings] = useState(false);
  const displayedTotal = Math.max(0, totalSpent - (applySavings ? potentialSavings : 0));
  const savingsPct = totalSpent > 0 ? ((applySavings ? potentialSavings : 0) / totalSpent) * 100 : 0;

  const spendingByCategory: SpendingByCategory[] = (() => {
    const totals: Record<Category, number> = {
      food: 0,
      transport: 0,
      shopping: 0,
      entertainment: 0,
      bills: 0,
      subscriptions: 0,
      groceries: 0,
      health: 0,
      other: 0,
    };
    expenses.forEach((e) => {
      totals[e.category] += e.amount;
    });
    const total = Object.values(totals).reduce((s, n) => s + n, 0) || 0;
    return (Object.keys(totals) as Category[])
      .filter((cat) => totals[cat] > 0)
      .map((cat) => ({
        category: cat,
        amount: totals[cat],
        percentage: total ? parseFloat(((totals[cat] / total) * 100).toFixed(1)) : 0,
        color: categoryColors[cat],
      }));
  })();

  const weeklyData = (() => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
    const totals: Record<typeof days[number], number> = { Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0 };
    expenses.forEach((e) => {
      const d = new Date(e.date);
      const key = days[d.getDay()];
      totals[key] += e.amount;
    });
    const order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
    return order.map((day) => ({ day, amount: totals[day] }));
  })();

  const handleAddExpense = (newExpense: { description: string; amount: number; category: Category }) => {
    const attemptId = Date.now().toString();
    const now = new Date();

    let finalAmount = newExpense.amount;
    if (applySavings) {
      const cap = computeCategoryCap({ expenses, alerts: badAlerts, category: newExpense.category, now });
      if (cap !== null) {
        const monthTotal = expenses
          .filter((e) => {
            const d = new Date(e.date);
            return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && e.category === newExpense.category;
          })
          .reduce((s, e) => s + e.amount, 0);
        const remaining = Math.max(0, cap - monthTotal);
        if (remaining <= 0) {
          recordOptimizedSaving({
            userKey,
            expenseId: attemptId,
            category: newExpense.category,
            amount: newExpense.amount,
            reason: 'Overspend blocked by savings cap',
            now,
          });
          const { summary } = reconcileSavingsLedger({ userKey, expenses, now });
          setSavedSummary(summary);
          toast('Spending capped', { description: `This ${newExpense.category} expense was blocked. ₹${newExpense.amount.toFixed(0)} counted as Saved.` });
          return;
        }
        if (newExpense.amount > remaining) {
          const blocked = newExpense.amount - remaining;
          finalAmount = remaining;
          recordOptimizedSaving({
            userKey,
            expenseId: attemptId,
            category: newExpense.category,
            amount: blocked,
            reason: 'Overspend reduced by savings cap',
            now,
          });
          toast('Spending optimized', { description: `Reduced by ₹${blocked.toFixed(0)} and counted as Saved.` });
        }
      }
    }

    const expenseBase: Expense = {
      id: attemptId,
      description: newExpense.description,
      amount: finalAmount,
      category: newExpense.category,
      date: now,
      isImpulse: false,
      source: 'MANUAL',
    };
    const { flags } = classifyExpense(expenseBase, expenses);
    const expense: Expense = { ...expenseBase, isImpulse: flags.impulse };
    const nextExpenses = [expense, ...expenses];
    setExpenses(nextExpenses);
    const nextAlerts = recomputeAlerts(nextExpenses);
    setAlerts(nextAlerts);
    const { summary } = reconcileSavingsLedger({ userKey, expenses: nextExpenses, now });
    setSavedSummary(summary);
    // Trigger background analysis update
    requestGeminiAnalysis(nextExpenses).then(setLastAnalysis).catch(() => {});
    toast.success('Expense added', {
      description: `${expense.description} - ₹${expense.amount.toFixed(0)} (${expense.category})`,
    });
  };

  const handleDismissAlert = (id: string) => {
    setAlerts(alerts.filter(a => a.id !== id));
    toast('Alert dismissed', { description: 'This habit alert has been removed from the list.' });
  };

  const handleDeleteExpense = (id: string) => {
    const target = expenses.find((e) => e.id === id);
    if (!target) return;
    if (target.source !== 'MANUAL') return; // guard
    const next = expenses.filter((e) => e.id !== id);
    setExpenses(next);
    const nextAlerts = recomputeAlerts(next);
    setAlerts(nextAlerts);
    const { summary } = reconcileSavingsLedger({ userKey, expenses: next });
    setSavedSummary(summary);
    requestGeminiAnalysis(next).then(setLastAnalysis).catch(() => {});
    toast('Expense deleted', { description: 'Dashboard recalculated.' });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 relative overflow-hidden">
      {/* Animated background elements */}
      <div className="fixed top-0 left-0 w-96 h-96 bg-purple-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob"></div>
      <div className="fixed top-0 right-0 w-96 h-96 bg-cyan-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-2000"></div>
      <div className="fixed bottom-0 left-1/2 w-96 h-96 bg-pink-500 rounded-full mix-blend-multiply filter blur-3xl opacity-20 animate-blob animation-delay-4000"></div>

      <style>{`
        @keyframes blob {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(30px, -50px) scale(1.1); }
          66% { transform: translate(-20px, 20px) scale(0.9); }
        }
        .animate-blob {
          animation: blob 7s infinite;
        }
        .animation-delay-2000 {
          animation-delay: 2s;
        }
        .animation-delay-4000 {
          animation-delay: 4s;
        }
      `}</style>

      <Header alertCount={alerts.length} />

      <main className="container mx-auto px-4 py-6 pb-24 relative z-10">
        {/* Stats Grid */}
        <motion.section
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <StatCard
            title="Total Spent"
            value={`₹${displayedTotal.toFixed(0)}`}
            subtitle={applySavings ? "This month (after savings)" : "This month"}
            icon={Wallet}
            trend={{ value: Math.round(applySavings ? savingsPct : 0), isPositive: applySavings }}
          />
          <StatCard
            title="Impulse Spending"
            value={`₹${impulseSpending.toFixed(0)}`}
            subtitle={`${((impulseSpending / totalSpent) * 100).toFixed(0)}% of total`}
            icon={TrendingDown}
            variant="warning"
          />
          <StatCard
            title="Bad Habits"
            value={badAlerts.length.toString()}
            subtitle="Detected patterns"
            icon={AlertTriangle}
            variant="default"
          />
          <StatCard
            title="Potential Savings"
            value={`₹${potentialSavings}`}
            subtitle="Per month"
            icon={Target}
            variant="primary"
          />
          <div className="lg:col-span-4">
            <motion.div
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <Button
                onClick={() => {
                  setApplySavings((v) => !v);
                  if (!applySavings) {
                    toast.success('Potential savings applied', { description: `New total: ₹${Math.max(0, totalSpent - potentialSavings).toFixed(0)}` });
                  } else {
                    toast('Savings removed', { description: `Total restored: ₹${totalSpent.toFixed(0)}` });
                  }
                }}
                className={applySavings 
                  ? 'w-full bg-gradient-to-r from-red-500 to-orange-500 hover:from-red-600 hover:to-orange-600 text-white font-semibold rounded-xl h-11 shadow-lg shadow-orange-500/30'
                  : 'w-full bg-gradient-to-r from-emerald-500 to-green-500 hover:from-emerald-600 hover:to-green-600 text-white font-semibold rounded-xl h-11 shadow-lg shadow-emerald-500/30'
                }
              >
                {applySavings ? 'Remove Applied Savings' : 'Apply Potential Savings'}
              </Button>
            </motion.div>
          </div>
        </motion.section>

        {/* Alerts Section */}
        {badAlerts.length > 0 && (
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="mb-8"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold font-display bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">
                🚨 Bad Habit Alerts
              </h2>
              <Button variant="ghost" size="sm" className="text-purple-400 hover:text-purple-300 hover:bg-purple-500/10 transition-colors">
                View All →
              </Button>
            </div>
            <div className="space-y-4">
              {badAlerts.map((alert, index) => (
                <HabitAlertCard 
                  key={alert.id} 
                  alert={alert} 
                  onDismiss={handleDismissAlert}
                  index={index}
                />
              ))}
            </div>
          </motion.section>
        )}

        {/* Charts Section */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2"
        >
          <SpendingChart data={spendingByCategory} />
          <WeeklyTrendChart data={weeklyData} />
        </motion.section>

        {/* Recent Expenses */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-bold font-display bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-transparent">
              Recent Expenses
            </h2>
            <Button variant="ghost" size="sm" className="text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10 transition-colors">
              See All →
            </Button>
          </div>
          <ExpenseList expenses={expenses.slice(0, 6)} onDelete={handleDeleteExpense} />
        </motion.section>
      </main>

      {/* Floating Actions (bottom-right) */}
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: 0.5, type: 'spring' }}
        className="fixed bottom-6 right-6 flex flex-col gap-3 z-50"
      >
        <Button
          onClick={async () => {
            setIsBotOpen((v) => !v);
            if (!isBotOpen) {
              setBotLoading(true);
              try {
                const analysis = await requestGeminiAnalysis(expenses);
                setLastAnalysis(analysis);
                setBotMessages([
                  { role: 'ai' as const, text: analysis.shortExplanations?.[0] || 'I will watch your spending patterns and suggest gentle improvements.' },
                  ...((analysis.suggestions?.slice(0, 2).map((s) => ({ role: 'ai' as const, text: s })) as Array<{ role: 'ai' | 'user'; text: string }>) || []),
                ]);
              } finally {
                setBotLoading(false);
              }
            }
          }}
          className="rounded-full bg-gradient-to-r from-cyan-500 to-purple-500 hover:from-cyan-600 hover:to-purple-600 shadow-lg shadow-purple-500/50 hover:shadow-xl transition-all px-5 h-12 text-white font-semibold"
        >
          <Sparkles className="h-5 w-5 mr-2" />
          AI Suggestions
        </Button>
        <Button
          onClick={() => {
            setIsSavedOpen(true);
          }}
          className="rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 shadow-lg shadow-emerald-500/50 hover:shadow-xl transition-all px-5 h-12 text-white font-semibold"
        >
          <BadgeCheck className="h-5 w-5 mr-2" />
          Saved
        </Button>
        <Button
          onClick={() => setIsModalOpen(true)}
          className="rounded-full bg-gradient-to-r from-violet-500 to-pink-500 hover:from-violet-600 hover:to-pink-600 shadow-lg shadow-violet-500/50 hover:shadow-xl transition-all px-5 h-12 text-white font-semibold"
        >
          <Plus className="h-5 w-5 mr-2" />
          Add Expense
        </Button>
      </motion.div>

      <AddExpenseModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onAdd={handleAddExpense}
      />
      <AddSavingModal isOpen={isSavedOpen} onClose={() => setIsSavedOpen(false)} summary={savedSummary} />

      {/* Lightweight chat panel (overlay), not a new page/layout */}
      {isBotOpen && (
        <motion.div 
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          className="fixed bottom-32 right-6 z-50 w-[min(420px,90vw)] rounded-2xl border border-white/20 bg-slate-900/95 backdrop-blur-xl shadow-2xl shadow-purple-500/20"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-gradient-to-r from-purple-500/10 to-cyan-500/10">
            <div className="text-sm font-semibold bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">✨ AI Suggestions</div>
            <Button variant="ghost" size="sm" onClick={() => setIsBotOpen(false)} className="text-gray-400 hover:text-white">✕</Button>
          </div>
          <div className="max-h-72 overflow-auto p-4 space-y-3">
            {botLoading && <div className="text-sm text-gray-400 italic">Analyzing your spending patterns…</div>}
            {(!botLoading && botMessages.length === 0) && (
              <div className="text-sm text-gray-400 italic">Ask for tips on a category or spending habit.</div>
            )}
            {botMessages.map((m, i) => (
              <motion.div 
                key={i} 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={m.role === 'ai' ? 'bg-cyan-500/10 border border-cyan-500/30 rounded-lg p-3 text-sm text-gray-200' : 'bg-purple-500/10 border border-purple-500/30 rounded-lg p-3 text-sm text-purple-300 ml-8'}
              >
                {m.text}
              </motion.div>
            ))}
          </div>
          <form
            className="flex gap-2 p-3 border-t border-white/10 bg-white/5"
            onSubmit={async (e) => {
              e.preventDefault();
              const q = botInput.trim();
              if (!q) return;
              setBotMessages((msgs) => [...msgs, { role: 'user', text: q }]);
              setBotInput('');
              try {
                const { reply } = await requestGeminiChat(expenses, q);
                setBotMessages((msgs) => [...msgs, { role: 'ai', text: reply }]);
                toast.success('AI suggestion received!');
              } catch (error) {
                setBotMessages((msgs) => [...msgs, { role: 'ai', text: 'I had trouble reaching the AI service. Try again shortly.' }]);
                toast.error('Failed to get AI suggestion. Please try again.');
              }
            }}
          >
            <input
              className="flex-1 rounded-md border border-white/20 bg-white/5 text-white px-3 py-2 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50"
              placeholder="Ask for help: reduce food delivery"
              value={botInput}
              onChange={(e) => setBotInput(e.target.value)}
            />
            <Button type="submit" className="bg-gradient-to-r from-cyan-500 to-purple-500 hover:from-cyan-600 hover:to-purple-600 text-white font-semibold">Send</Button>
          </form>
        </motion.div>
      )}
    </div>
  );
};

export default Index;
