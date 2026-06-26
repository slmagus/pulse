/**
 * Pulse Rule Engine — Tier-0 agent system with per-agent balance sheets and
 * peer-to-peer transactions.
 *
 * Each agent owns real accounts. Money moves agent-to-agent; aggregate pool
 * balances are re-derived from individual holdings each tick, not tracked
 * separately. Only the Fed creates or destroys net M2.
 *
 * Balance sheet layout:
 *   retail_depositor  → deposits_B (savings, earns interest), checking_B
 *   small_business    → cash_B (operating capital), revenue_B (this tick, reset)
 *   consumer          → checking_B (wages in / spending out), savings_B (earns yield)
 *   institutional     → equity_B (appreciates with stocks), bond_B (earns rate yield)
 *
 * All money values in $billions USD.
 */

import RCFG from "./rule-engine-config.json";

// ─── Agent generation ─────────────────────────────────────────────────────────

export function generateTier0Agents() {
  const agents = [];
  const { populations: P } = RCFG;

  // Retail depositors — each represents a cohort
  const rdCfg = P.retail_depositors;
  for (let i = 0; i < rdCfg.count; i++) {
    const spread = 1 - rdCfg.deposit_spread / 2 + Math.random() * rdCfg.deposit_spread;
    const deposits = rdCfg.avg_deposits_B * spread;
    agents.push({
      id: `dep_${i}`, type: "retail_depositor",
      insured: Math.random() < rdCfg.insured_fraction,
      deposits_B: deposits,
      checking_B: deposits * 0.08,   // liquid transaction float
      withdrawn: false,
    });
  }

  // Small businesses
  const sbCfg = P.small_businesses;
  const sbSectors = Object.entries(sbCfg.sector_mix);
  for (let i = 0; i < sbCfg.count; i++) {
    let sector = sbSectors[sbSectors.length - 1][0], r = Math.random(), c = 0;
    for (const [s, w] of sbSectors) { c += w; if (r <= c) { sector = s; break; } }
    const spread = 0.5 + Math.random();
    agents.push({
      id: `biz_${i}`, type: "small_business", sector,
      employees: Math.max(1, Math.round(sbCfg.avg_employees * spread)),
      cash_B: sbCfg.avg_cash_B * spread,
      revenue_B: 0,       // reset each tick
      payroll_B: 0,       // reset each tick
      stressed: false,
    });
  }

  // Consumers — checking + savings accounts
  const consCfg = P.consumers;
  for (let i = 0; i < consCfg.count; i++) {
    const spread = 1 - consCfg.spending_spread / 2 + Math.random() * consCfg.spending_spread;
    const liquid = consCfg.avg_cash_B * spread;
    agents.push({
      id: `cons_${i}`, type: "consumer",
      employed: Math.random() < consCfg.employed_fraction,
      checking_B: liquid * 0.6,
      savings_B: liquid * 0.4,
      spending_index: 0.5 + Math.random() * 0.5,
    });
  }

  // Institutional investors — equity + bond split
  const instCfg = P.institutional_investors;
  for (let i = 0; i < instCfg.count; i++) {
    const aum = instCfg.avg_aum_B * (0.5 + Math.random());
    const riskOn = Math.random() < instCfg.initial_risk_on_fraction;
    agents.push({
      id: `inst_${i}`, type: "institutional_investor",
      equity_B: aum * (riskOn ? 0.70 : 0.30),
      bond_B:   aum * (riskOn ? 0.30 : 0.70),
      risk_on: riskOn,
    });
  }

  return agents;
}

// ─── Money supply initializer ─────────────────────────────────────────────────

export function initMoneySupply() {
  const ms = RCFG.money_supply;
  return {
    m2_B:             ms.initial_m2_B,
    fed_balance_B:    ms.initial_fed_balance_B,
    treasury_B:       ms.initial_treasury_B,
    consumer_pool_B:  ms.initial_consumer_pool_B,
    business_pool_B:  ms.initial_business_pool_B,
    lastFlows: null,
  };
}

// ─── Tier-0 tick ─────────────────────────────────────────────────────────────

/**
 * Run all Tier-0 agents for one simulation tick.
 *
 * Each agent type executes up to `actions_per_tick` decision cycles.
 * Transactions move money between individual agent accounts; pool totals are
 * re-derived at the end by summing all agent balances.
 */
export function runTier0Tick(agents, money, vitals, prevVitals, prevWithdrawalRate = 0) {
  const { rules: R, populations: P, fiscal: F, contagion: C, macro_sensitivities: MS } = RCFG;

  const micro = {
    hires: 0, layoffs: 0, launches: 0, deals: 0, invests: 0,
    closes: 0, marriages: 0, births: 0, deaths: 0, buys: 0, purchases: 0,
    rate_delta: 0, gdp_boost: 0, confidence_boost: 0, stocks_shock: 0,
  };
  const stats = {
    depositors: { total: 0, withdrew: 0, deposited: 0, net_withdrawal_B: 0, interest_earned_B: 0 },
    businesses: { total: 0, net_hires: 0, net_layoffs: 0, total_employees: 0, deals: 0, b2b_volume_B: 0 },
    consumers:  { total: 0, spent: 0, major_purchases: 0, wages_received_B: 0, interest_earned_B: 0 },
    investors:  { total: 0, went_risk_on: 0, went_risk_off: 0, returns_B: 0 },
  };
  const ledger = [];

  // Per-tick flow ledger (double-entry, for display)
  const flows = {
    wages_B: 0, income_tax_B: 0, corporate_tax_B: 0,
    consumer_spend_B: 0, b2b_spend_B: 0, withdrawal_B: 0,
    deposit_interest_B: 0, savings_interest_B: 0, investor_returns_B: 0,
    treasury_delta_B: 0,
  };

  const stocksMomentum = prevVitals
    ? (vitals.stocks - prevVitals.stocks) / prevVitals.stocks * 100
    : 0;

  // Partition agents by type (done once for efficiency)
  const depositors = agents.filter(a => a.type === "retail_depositor");
  const businesses  = agents.filter(a => a.type === "small_business");
  const consumers   = agents.filter(a => a.type === "consumer");
  const investors   = agents.filter(a => a.type === "institutional_investor");
  const activeBiz   = businesses.filter(b => !b.stressed);

  // ── 1. Deposit interest accrual ──────────────────────────────────────────
  // Banks pay depositors quarterly interest. Interest is new credit (bank lending
  // creates deposits) — technically expands M2 slightly.
  const rdR = R.retail_depositor;
  const quarterlyDepositRate = (vitals.rate * 0.60) / 400;  // 60% of fed rate, quarterly
  stats.depositors.total = depositors.length;

  for (const dep of depositors) {
    if (dep.withdrawn) continue;
    const interest = dep.deposits_B * quarterlyDepositRate;
    dep.deposits_B += interest;
    dep.checking_B += interest * 0.1;   // a fraction flows to checking
    flows.deposit_interest_B += interest;
    stats.depositors.interest_earned_B += interest;
  }

  // ── 2. Savings account interest for consumers ─────────────────────────────
  const quarterlyConsumerSavingsRate = (vitals.rate * 0.50) / 400;
  for (const c of consumers) {
    if (c.savings_B > 0) {
      const interest = c.savings_B * quarterlyConsumerSavingsRate;
      c.savings_B  += interest;
      flows.savings_interest_B += interest;
      stats.consumers.interest_earned_B += interest;
    }
  }

  // ── 3. Institutional investor portfolio returns ───────────────────────────
  const instR = R.institutional_investor;
  const quarterlyBondYield = vitals.rate / 400;
  stats.investors.total = investors.length;
  const actionsInst = P.institutional_investors.actions_per_tick;

  for (const inv of investors) {
    // Equity mark-to-market: shares drift with stocks momentum
    const equityReturn = inv.equity_B * (stocksMomentum / 100) * 0.25;
    inv.equity_B = Math.max(0, inv.equity_B + equityReturn);

    // Bond yield accrual
    const bondReturn = inv.bond_B * quarterlyBondYield;
    inv.bond_B += bondReturn;

    const totalReturn = equityReturn + bondReturn;
    flows.investor_returns_B += totalReturn;
    stats.investors.returns_B += totalReturn;

    for (let act = 0; act < actionsInst; act++) {
      if (act === 0) {
        // Risk-on / risk-off reallocation
        const rateShock = prevVitals && (vitals.rate - prevVitals.rate) >= instR.withdraw_rate_shock_threshold;
        const gdpWeak   = vitals.gdp < instR.withdraw_gdp_floor;
        const aum       = inv.equity_B + inv.bond_B;

        if ((rateShock || gdpWeak) && inv.risk_on && Math.random() < instR.withdraw_probability_max) {
          const shift = Math.min(inv.equity_B, aum * instR.equity_allocation_shift_B / instR.avg_aum_B);
          inv.equity_B -= shift;
          inv.bond_B   += shift;
          inv.risk_on   = false;
          stats.investors.went_risk_off++;
          micro.stocks_shock      += MS.institutional_withdraw_stocks_hit;
          micro.confidence_boost  += MS.institutional_withdraw_stocks_hit * 0.5;
        } else if (stocksMomentum >= instR.invest_stock_momentum_threshold
            && vitals.gdp >= R.small_business.hire_gdp_threshold
            && !inv.risk_on && Math.random() < instR.invest_probability_max) {
          const shift = Math.min(inv.bond_B, aum * instR.equity_allocation_shift_B / instR.avg_aum_B);
          inv.bond_B   -= shift;
          inv.equity_B += shift;
          inv.risk_on   = true;
          stats.investors.went_risk_on++;
          micro.invests++;
          micro.stocks_shock += MS.institutional_invest_stocks_boost;
        }
      }
      if (act === 1 && !inv.risk_on) {
        micro.confidence_boost += 0.3;  // bond safety signal
      }
    }
  }

  if (stats.investors.went_risk_on > 0 || stats.investors.went_risk_off > 0) {
    ledger.push({
      kind: "invest",
      text: `Institutional: ${stats.investors.went_risk_on} risk-on, ${stats.investors.went_risk_off} risk-off · momentum ${stocksMomentum >= 0 ? "+" : ""}${stocksMomentum.toFixed(2)}% · returns ${fmt_B(stats.investors.returns_B)}`,
    });
  }

  // ── 4. Small business decisions ───────────────────────────────────────────
  const sbR   = R.small_business;
  const ratePenalty = vitals.rate * sbR.rate_sensitivity;
  const gdpSignal   = vitals.gdp - ratePenalty;
  stats.businesses.total = businesses.length;
  const actionsSB = P.small_businesses.actions_per_tick;

  // Reset per-tick revenue/payroll
  for (const biz of businesses) { biz.revenue_B = 0; biz.payroll_B = 0; }

  for (const biz of businesses) {
    for (let act = 0; act < actionsSB; act++) {
      // Action 1: hire or lay off
      if (act === 0) {
        if (gdpSignal >= sbR.hire_gdp_threshold && vitals.confidence >= sbR.hire_confidence_threshold) {
          if (Math.random() < sbR.hire_probability_max) {
            biz.employees++;
            biz.stressed = false;
            stats.businesses.net_hires++;
            micro.hires++;
          }
        } else if (gdpSignal < sbR.layoff_gdp_threshold || vitals.confidence < sbR.layoff_confidence_threshold) {
          if (biz.employees > 1 && Math.random() < sbR.layoff_probability_max) {
            biz.employees--;
            biz.stressed = true;
            stats.businesses.net_layoffs++;
            micro.layoffs++;
          }
        }
      }

      // Action 2: B2B deal — buy from another business (peer-to-peer cash transfer)
      if (act === 1 && !biz.stressed && activeBiz.length > 1 && Math.random() < sbR.deal_probability) {
        const seller = activeBiz[Math.floor(Math.random() * activeBiz.length)];
        if (seller !== biz && biz.cash_B > 0) {
          const dealAmt = biz.cash_B * 0.04;
          biz.cash_B    -= dealAmt;
          seller.cash_B += dealAmt;
          flows.b2b_spend_B += dealAmt;
          stats.businesses.b2b_volume_B += dealAmt;
          stats.businesses.deals++;
          micro.deals++;
          micro.gdp_boost += 0.015;
        }
      }

      // Action 3: invest in capacity (capital expenditure — boosts GDP, depletes cash)
      if (act === 2 && !biz.stressed && vitals.confidence > 65 && biz.cash_B > 0
          && Math.random() < sbR.invest_probability) {
        const capex = biz.cash_B * 0.06;
        biz.cash_B -= capex;
        micro.invests++;
        micro.gdp_boost += 0.03;
        // Capex flows to other businesses (construction, equipment) — simplified
        if (activeBiz.length > 0) {
          const recipient = activeBiz[Math.floor(Math.random() * activeBiz.length)];
          recipient.cash_B += capex * 0.8;
        }
      }
    }
  }

  // ── 5. Wage payments: business → consumer (peer-to-peer with tax withholding) ─
  // Each employed consumer receives a proportional wage from the total payroll pool.
  const totalEmployees = businesses.reduce((s, b) => s + b.employees, 0);
  stats.businesses.total_employees = totalEmployees;

  const totalWages_B  = totalEmployees * F.quarterly_wage_per_employee_B;
  const incomeTax_B   = totalWages_B * F.income_tax_rate;
  const netWages_B    = totalWages_B - incomeTax_B;

  // Deduct payroll from businesses proportionally
  for (const biz of businesses) {
    const payroll = biz.employees * F.quarterly_wage_per_employee_B;
    biz.payroll_B  = payroll;
    biz.cash_B    -= payroll;
    if (biz.cash_B < 0) {
      // Business is insolvent: flag as stressed, zero out
      biz.stressed = true;
      biz.cash_B   = 0;
    }
  }

  // Distribute net wages to employed consumers
  const employedConsumers = consumers.filter(c => c.employed);
  if (employedConsumers.length > 0) {
    const wagePerConsumer = netWages_B / employedConsumers.length;
    for (const c of employedConsumers) {
      c.checking_B += wagePerConsumer;
      stats.consumers.wages_received_B += wagePerConsumer;
    }
  }

  flows.wages_B      = totalWages_B;
  flows.income_tax_B = incomeTax_B;
  flows.treasury_delta_B += incomeTax_B;

  micro.confidence_boost += stats.businesses.net_hires  * MS.business_hire_unemployment_reduction  * -6;
  micro.confidence_boost += stats.businesses.net_layoffs * MS.business_layoff_unemployment_increase * -5;
  micro.gdp_boost += stats.businesses.deals * 0.012;

  if (stats.businesses.net_hires > 0 || stats.businesses.net_layoffs > 0) {
    ledger.push({
      kind: stats.businesses.net_hires > stats.businesses.net_layoffs ? "hire" : "layoff",
      text: `Small businesses: +${stats.businesses.net_hires} hires, -${stats.businesses.net_layoffs} layoffs · payroll ${fmt_B(totalWages_B)} · B2B ${fmt_B(flows.b2b_spend_B)}`,
    });
  }

  // ── 6. Consumer decisions (spending, savings management) ─────────────────
  const consR     = R.consumer;
  const actionsCons = P.consumers.actions_per_tick;
  stats.consumers.total = consumers.length;
  let totalConsumerSpend_B = 0;

  for (const c of consumers) {
    // Update employment status stochastically
    const uRate = vitals.unemployment / 100;
    if (c.employed  && Math.random() < uRate * 0.08)  c.employed = false;
    if (!c.employed && stats.businesses.net_hires > 0  && Math.random() < 0.07) c.employed = true;

    for (let act = 0; act < actionsCons; act++) {
      const confSignal = vitals.confidence - consR.spend_confidence_threshold
        - vitals.unemployment * consR.unemployment_spend_penalty;
      const rateSavingsBoost = Math.max(0, (vitals.rate - 3) * consR.rate_savings_sensitivity);

      // Actions 0–2: routine spending (consumer → random business, peer-to-peer)
      if (act < 3 && confSignal > 0 && c.employed && c.checking_B > 0) {
        const spendRate = Math.max(0, consR.base_spend_rate - rateSavingsBoost) * c.spending_index;
        const spend = Math.min(c.checking_B * spendRate, c.checking_B * 0.8);
        if (spend > 0 && activeBiz.length > 0) {
          const seller = activeBiz[Math.floor(Math.random() * activeBiz.length)];
          c.checking_B  -= spend;
          // After corporate tax, revenue lands in the business's account
          const corpTaxOnSale = spend * sbR.revenue_spend_pass_through * F.corporate_tax_rate;
          const netRevenue     = spend * sbR.revenue_spend_pass_through - corpTaxOnSale;
          seller.cash_B    += netRevenue;
          seller.revenue_B += spend;
          flows.corporate_tax_B   += corpTaxOnSale;
          flows.treasury_delta_B  += corpTaxOnSale;
          totalConsumerSpend_B    += spend;
          stats.consumers.spent++;
          micro.buys++;
          micro.gdp_boost += MS.consumer_spend_gdp_boost;
        }
      }

      // Action 3: major purchase (consumer → random business, larger amount)
      if (act === 3 && vitals.confidence >= consR.major_purchase_confidence_threshold
          && Math.random() < consR.major_purchase_probability
          && c.employed && c.checking_B > 0 && activeBiz.length > 0) {
        const bigSpend = Math.min(c.checking_B * consR.base_spend_rate * 5, c.checking_B * 0.4);
        if (bigSpend > 0) {
          const seller = activeBiz[Math.floor(Math.random() * activeBiz.length)];
          c.checking_B  -= bigSpend;
          const corpTax = bigSpend * sbR.revenue_spend_pass_through * F.corporate_tax_rate;
          seller.cash_B    += bigSpend * sbR.revenue_spend_pass_through - corpTax;
          seller.revenue_B += bigSpend;
          flows.corporate_tax_B  += corpTax;
          flows.treasury_delta_B += corpTax;
          totalConsumerSpend_B   += bigSpend;
          stats.consumers.major_purchases++;
          micro.purchases++;
          micro.gdp_boost += MS.consumer_spend_gdp_boost * 4;
        }
      }

      // Savings management: move surplus checking to savings if rate is attractive,
      // or draw from savings if unemployed and low on checking
      if (act === actionsCons - 1) {
        const savingsThreshold = consR.base_spend_rate * 6;
        const savingsAttractiveness = vitals.rate > 4 ? (vitals.rate - 4) * consR.rate_savings_sensitivity : 0;

        if (c.checking_B > consR.avg_cash_B * 2 && savingsAttractiveness > 0) {
          // Park surplus in savings
          const toSave = c.checking_B * savingsAttractiveness * 0.5;
          c.checking_B -= toSave;
          c.savings_B  += toSave;
        } else if (!c.employed && c.checking_B < consR.avg_cash_B * 0.3 && c.savings_B > 0) {
          // Unemployed: draw down savings to maintain spending
          const draw = Math.min(c.savings_B * 0.25, c.savings_B);
          c.savings_B  -= draw;
          c.checking_B += draw;
        }
      }
    }
  }

  flows.consumer_spend_B = totalConsumerSpend_B;

  if (stats.consumers.spent > 0 || stats.consumers.major_purchases > 0) {
    ledger.push({
      kind: "buy",
      text: `Consumer: ${stats.consumers.spent} routine + ${stats.consumers.major_purchases} major purchases · ${fmt_B(totalConsumerSpend_B)} circulated · wages in ${fmt_B(stats.consumers.wages_received_B)}`,
    });
  }

  // ── 7. Depositor withdrawal / deposit decisions ───────────────────────────
  let withdrawalCount = 0, depositCount = 0, totalWithdrawnB = 0;

  for (const dep of depositors) {
    if (dep.withdrawn) continue;
    const actionsRD = P.retail_depositors.actions_per_tick;

    for (let act = 0; act < actionsRD; act++) {
      // Action 0: withdrawal decision
      if (act === 0) {
        const herdPressure = prevWithdrawalRate > rdR.herd_threshold ? rdR.herd_multiplier : 1;
        const riskMult     = dep.insured ? 1 : rdR.uninsured_risk_premium;
        const confDeficit  = Math.max(0, rdR.withdraw_confidence_floor - vitals.confidence);
        const prob = rdR.withdraw_base_probability * riskMult * herdPressure
          * (confDeficit / Math.max(1, rdR.withdraw_confidence_floor));
        if (Math.random() < prob) {
          dep.withdrawn     = true;
          totalWithdrawnB  += dep.deposits_B;
          dep.deposits_B    = 0;  // funds leave the formal banking system
          dep.checking_B    = 0;
          withdrawalCount++;
        }
      }

      // Action 1: add more deposits if confident (new money flows in)
      if (act === 1 && !dep.withdrawn && vitals.confidence >= rdR.deposit_confidence_ceiling
          && dep.checking_B > 0) {
        const newDeposit = dep.checking_B * 0.50;  // move checking → deposits
        dep.checking_B  -= newDeposit;
        dep.deposits_B  += newDeposit;
        depositCount++;
      }
    }
  }

  flows.withdrawal_B = totalWithdrawnB;
  flows.treasury_delta_B += 0;  // withdrawals are wealth redistribution, not tax
  stats.depositors.withdrew       = withdrawalCount;
  stats.depositors.deposited      = depositCount;
  stats.depositors.net_withdrawal_B = totalWithdrawnB;

  const withdrawalRate = depositors.length > 0 ? withdrawalCount / depositors.length : 0;
  const isSystemic     = withdrawalRate >= C.systemic_withdrawal_threshold;

  micro.confidence_boost += withdrawalCount * MS.deposit_withdrawal_confidence_hit;
  micro.confidence_boost += depositCount    * MS.deposit_inflow_confidence_boost;

  if (withdrawalCount > 0) {
    const pct = (withdrawalRate * 100).toFixed(1);
    ledger.push({
      kind: isSystemic ? "regulate" : "layoff",
      text: `Depositor run: ${withdrawalCount}/${depositors.length} withdrew ${fmt_B(totalWithdrawnB)} (${pct}%)${isSystemic ? " ⚠ SYSTEMIC" : ""}`,
    });
  }
  if (depositCount > 0) {
    ledger.push({
      kind: "invest",
      text: `${depositCount} depositors moved surplus to savings — confidence ${vitals.confidence.toFixed(0)}`,
    });
  }

  // ── 8. Re-derive pool totals from individual agent balances ───────────────
  let derived_consumer_B = 0, derived_business_B = 0, derived_investor_B = 0;
  for (const a of agents) {
    if (a.type === "retail_depositor" && !a.withdrawn) {
      derived_consumer_B += a.deposits_B + a.checking_B;
    } else if (a.type === "small_business") {
      derived_business_B += Math.max(0, a.cash_B);
    } else if (a.type === "consumer") {
      derived_consumer_B += a.checking_B + a.savings_B;
    } else if (a.type === "institutional_investor") {
      derived_investor_B += a.equity_B + a.bond_B;
    }
  }

  return {
    micro, stats, ledger, flows, withdrawalRate,
    derivedPools: {
      consumer_B:  derived_consumer_B,
      business_B:  derived_business_B,
      investor_B:  derived_investor_B,
    },
  };
}

// ─── Money state updater ──────────────────────────────────────────────────────

/**
 * Rebuild the money state from derived agent pools + treasury/Fed adjustments.
 * Pool totals are ground truth from individual balance sheets; treasury and Fed
 * are updated via the flow ledger.
 */
export function applyTier0MoneyFlows(money, flows, derivedPools) {
  const next = {
    ...money,
    consumer_pool_B: derivedPools.consumer_B,
    business_pool_B: derivedPools.business_B,
    treasury_B:      Math.max(0, money.treasury_B + flows.treasury_delta_B),
    // Fed balance unchanged by Tier-0 (only LLM institutional events move it)
    fed_balance_B:   money.fed_balance_B,
    lastFlows: flows,
  };
  next.m2_B = next.consumer_pool_B + next.business_pool_B;
  return next;
}

/**
 * Apply LLM institutional events to money supply state.
 * Called after applyEvents() resolves each tick's named-cast events.
 */
export function applyInstitutionalMoneyFlows(money, events) {
  const cfg = RCFG.money_supply._note_institutional_events;
  let next = { ...money };

  for (const ev of events) {
    const amt = Math.abs(Number(ev.amount || ev.delta || 0));

    if (ev.type === "stimulus") {
      const injection = amt * cfg.stimulus_B_per_point;
      next.consumer_pool_B += injection * 0.6;
      next.business_pool_B += injection * 0.4;
      next.fed_balance_B   -= injection;
    } else if (ev.type === "spending_bill") {
      const spend = Math.min(amt * cfg.spending_bill_B_per_point, next.treasury_B);
      next.treasury_B      -= spend;
      next.consumer_pool_B += spend * 0.6;
      next.business_pool_B += spend * 0.4;
    } else if (ev.type === "tax_cut") {
      const cut = Math.min(amt * cfg.tax_cut_B_per_point, next.treasury_B);
      next.treasury_B      -= cut;
      next.consumer_pool_B += cut * 0.55;
      next.business_pool_B += cut * 0.45;
    } else if (ev.type === "tax_hike") {
      const hike = amt * cfg.tax_hike_B_per_point;
      next.consumer_pool_B -= hike * 0.55;
      next.business_pool_B -= hike * 0.45;
      next.treasury_B      += hike;
    } else if (ev.type === "subsidize") {
      const sub = Math.min(amt * cfg.subsidize_B_per_point, next.treasury_B);
      next.treasury_B      -= sub;
      next.business_pool_B += sub;
    } else if (ev.type === "bailout") {
      const rescue = cfg.stimulus_B_per_point * 0.5;
      next.business_pool_B += rescue;
      next.fed_balance_B   -= rescue * 0.5;
      next.treasury_B      -= Math.min(rescue * 0.5, next.treasury_B);
    } else if (ev.type === "rate_change") {
      const delta = Number(ev.delta || 0);
      if (delta > 0) {
        const shrink = delta * cfg.rate_hike_m2_shrink_per_pct;
        next.consumer_pool_B -= shrink * 0.5;
        next.business_pool_B -= shrink * 0.5;
        next.fed_balance_B   += shrink;
      } else {
        const grow = Math.abs(delta) * cfg.rate_cut_m2_grow_per_pct;
        next.consumer_pool_B += grow * 0.5;
        next.business_pool_B += grow * 0.5;
        next.fed_balance_B   -= grow;
      }
    } else if (ev.type === "safety_net") {
      const net = Math.min(amt * cfg.spending_bill_B_per_point * 0.5, next.treasury_B);
      next.treasury_B      -= net;
      next.consumer_pool_B += net;
    }
  }

  next.consumer_pool_B = Math.max(0, next.consumer_pool_B);
  next.business_pool_B = Math.max(0, next.business_pool_B);
  next.treasury_B      = Math.max(0, next.treasury_B);
  next.m2_B            = next.consumer_pool_B + next.business_pool_B;
  return next;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt_B(b) {
  if (!b || b < 0) return "$0";
  if (b >= 1000) return `$${(b / 1000).toFixed(1)}T`;
  if (b >= 1)    return `$${b.toFixed(0)}B`;
  return `$${(b * 1000).toFixed(0)}M`;
}

export function fmtMoney(b) {
  if (!b || b < 0) return "$0";
  if (b >= 1000) return `$${(b / 1000).toFixed(2)}T`;
  if (b >= 1)    return `$${b.toFixed(0)}B`;
  return `$${(b * 1000).toFixed(0)}M`;
}
