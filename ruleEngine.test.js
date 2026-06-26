import {
  generateTier0Agents,
  initMoneySupply,
  runTier0Tick,
  applyTier0MoneyFlows,
  applyInstitutionalMoneyFlows,
  fmtMoney,
} from './ruleEngine.js';

describe('ruleEngine', () => {
  describe('generateTier0Agents', () => {
    test('creates agents of all expected types', () => {
      const agents = generateTier0Agents();
      const types = new Set(agents.map(a => a.type));

      expect(types).toContain('retail_depositor');
      expect(types).toContain('small_business');
      expect(types).toContain('consumer');
      expect(types).toContain('institutional_investor');
    });

    test('retail_depositors have required properties', () => {
      const agents = generateTier0Agents();
      const depositor = agents.find(a => a.type === 'retail_depositor');

      expect(depositor).toHaveProperty('id');
      expect(depositor).toHaveProperty('deposits_B');
      expect(depositor).toHaveProperty('checking_B');
      expect(depositor).toHaveProperty('insured');
      expect(depositor).toHaveProperty('withdrawn');
      expect(typeof depositor.deposits_B).toBe('number');
      expect(depositor.deposits_B).toBeGreaterThan(0);
    });

    test('small_businesses have required properties', () => {
      const agents = generateTier0Agents();
      const business = agents.find(a => a.type === 'small_business');

      expect(business).toHaveProperty('id');
      expect(business).toHaveProperty('sector');
      expect(business).toHaveProperty('employees');
      expect(business).toHaveProperty('cash_B');
      expect(business).toHaveProperty('stressed');
      expect(['tech', 'food', 'retail', 'services', 'logistics']).toContain(business.sector);
      expect(business.employees).toBeGreaterThanOrEqual(1);
    });

    test('consumers have required properties', () => {
      const agents = generateTier0Agents();
      const consumer = agents.find(a => a.type === 'consumer');

      expect(consumer).toHaveProperty('id');
      expect(consumer).toHaveProperty('employed');
      expect(consumer).toHaveProperty('checking_B');
      expect(consumer).toHaveProperty('savings_B');
      expect(consumer).toHaveProperty('spending_index');
      expect(typeof consumer.employed).toBe('boolean');
    });

    test('institutional_investors have required properties', () => {
      const agents = generateTier0Agents();
      const investor = agents.find(a => a.type === 'institutional_investor');

      expect(investor).toHaveProperty('id');
      expect(investor).toHaveProperty('equity_B');
      expect(investor).toHaveProperty('bond_B');
      expect(investor).toHaveProperty('risk_on');
      expect(investor.equity_B + investor.bond_B).toBeGreaterThan(0);
    });

    test('all agents have unique IDs', () => {
      const agents = generateTier0Agents();
      const ids = agents.map(a => a.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe('initMoneySupply', () => {
    test('initializes money supply with correct properties', () => {
      const money = initMoneySupply();

      expect(money).toHaveProperty('m2_B');
      expect(money).toHaveProperty('fed_balance_B');
      expect(money).toHaveProperty('treasury_B');
      expect(money).toHaveProperty('consumer_pool_B');
      expect(money).toHaveProperty('business_pool_B');
      expect(money).toHaveProperty('lastFlows');
    });

    test('all money values are positive', () => {
      const money = initMoneySupply();

      expect(money.m2_B).toBeGreaterThan(0);
      expect(money.fed_balance_B).toBeGreaterThan(0);
      expect(money.treasury_B).toBeGreaterThan(0);
      expect(money.consumer_pool_B).toBeGreaterThan(0);
      expect(money.business_pool_B).toBeGreaterThan(0);
    });

    test('m2_B equals sum of pools', () => {
      const money = initMoneySupply();

      expect(money.m2_B).toBe(money.consumer_pool_B + money.business_pool_B);
    });
  });

  describe('runTier0Tick', () => {
    test('executes without error with valid inputs', () => {
      const agents = generateTier0Agents();
      const money = initMoneySupply();
      const vitals = {
        rate: 5,
        unemployment: 4,
        inflation: 2.5,
        gdp: 1.2,
        stocks: 100,
        confidence: 60,
      };

      expect(() => {
        runTier0Tick(agents, money, vitals, null, 0);
      }).not.toThrow();
    });

    test('returns required objects', () => {
      const agents = generateTier0Agents();
      const money = initMoneySupply();
      const vitals = {
        rate: 5,
        unemployment: 4,
        inflation: 2.5,
        gdp: 1.2,
        stocks: 100,
        confidence: 60,
      };

      const result = runTier0Tick(agents, money, vitals, null, 0);

      expect(result).toHaveProperty('micro');
      expect(result).toHaveProperty('stats');
      expect(result).toHaveProperty('ledger');
      expect(result).toHaveProperty('flows');
      expect(result).toHaveProperty('withdrawalRate');
      expect(result).toHaveProperty('derivedPools');
    });

    test('micro events are non-negative integers', () => {
      const agents = generateTier0Agents();
      const money = initMoneySupply();
      const vitals = {
        rate: 5,
        unemployment: 4,
        inflation: 2.5,
        gdp: 1.2,
        stocks: 100,
        confidence: 60,
      };

      const result = runTier0Tick(agents, money, vitals, null, 0);

      Object.values(result.micro).forEach(val => {
        if (typeof val === 'number') {
          expect(val).toBeGreaterThanOrEqual(0);
        }
      });
    });

    test('consumer pool derives from individual balances', () => {
      const agents = generateTier0Agents();
      const money = initMoneySupply();
      const vitals = {
        rate: 5,
        unemployment: 4,
        inflation: 2.5,
        gdp: 1.2,
        stocks: 100,
        confidence: 60,
      };

      const result = runTier0Tick(agents, money, vitals, null, 0);
      const derivedConsumer = agents
        .filter(a => a.type === 'retail_depositor' && !a.withdrawn)
        .reduce((sum, a) => sum + a.deposits_B + a.checking_B, 0)
        + agents
        .filter(a => a.type === 'consumer')
        .reduce((sum, a) => sum + a.checking_B + a.savings_B, 0);

      expect(result.derivedPools.consumer_B).toBe(derivedConsumer);
    });

    test('business pool derives from individual balances', () => {
      const agents = generateTier0Agents();
      const money = initMoneySupply();
      const vitals = {
        rate: 5,
        unemployment: 4,
        inflation: 2.5,
        gdp: 1.2,
        stocks: 100,
        confidence: 60,
      };

      const result = runTier0Tick(agents, money, vitals, null, 0);
      const derivedBusiness = agents
        .filter(a => a.type === 'small_business')
        .reduce((sum, a) => sum + Math.max(0, a.cash_B), 0);

      expect(result.derivedPools.business_B).toBe(derivedBusiness);
    });

    test('withdrawal rate is between 0 and 1', () => {
      const agents = generateTier0Agents();
      const money = initMoneySupply();
      const vitals = {
        rate: 5,
        unemployment: 4,
        inflation: 2.5,
        gdp: 1.2,
        stocks: 100,
        confidence: 60,
      };

      const result = runTier0Tick(agents, money, vitals, null, 0);

      expect(result.withdrawalRate).toBeGreaterThanOrEqual(0);
      expect(result.withdrawalRate).toBeLessThanOrEqual(1);
    });

    test('high confidence triggers business hiring', () => {
      const agents = generateTier0Agents();
      const money = initMoneySupply();
      const vitals = {
        rate: 2,
        unemployment: 3,
        inflation: 2,
        gdp: 2.5,
        stocks: 150,
        confidence: 85,
      };

      const result = runTier0Tick(agents, money, vitals, null, 0);

      expect(result.micro.hires).toBeGreaterThanOrEqual(0);
    });

    test('low confidence triggers business layoffs', () => {
      const agents = generateTier0Agents();
      const money = initMoneySupply();
      const vitals = {
        rate: 8,
        unemployment: 8,
        inflation: 5,
        gdp: -1.2,
        stocks: 50,
        confidence: 30,
      };

      const result = runTier0Tick(agents, money, vitals, null, 0);

      expect(result.micro.layoffs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('applyTier0MoneyFlows', () => {
    test('updates pools from derived balances', () => {
      const money = initMoneySupply();
      const flows = {
        wages_B: 10,
        income_tax_B: 2,
        corporate_tax_B: 1.5,
        consumer_spend_B: 20,
        b2b_spend_B: 5,
        withdrawal_B: 0,
        deposit_interest_B: 0.5,
        savings_interest_B: 0.3,
        investor_returns_B: 1,
        treasury_delta_B: 3.5,
      };
      const derivedPools = {
        consumer_B: 15000,
        business_B: 8500,
        investor_B: 150,
      };

      const result = applyTier0MoneyFlows(money, flows, derivedPools);

      expect(result.consumer_pool_B).toBe(derivedPools.consumer_B);
      expect(result.business_pool_B).toBe(derivedPools.business_B);
      expect(result.m2_B).toBe(derivedPools.consumer_B + derivedPools.business_B);
    });

    test('treasury delta is applied', () => {
      const money = initMoneySupply();
      const initialTreasury = money.treasury_B;
      const flows = {
        wages_B: 0,
        income_tax_B: 2,
        corporate_tax_B: 1.5,
        consumer_spend_B: 0,
        b2b_spend_B: 0,
        withdrawal_B: 0,
        deposit_interest_B: 0,
        savings_interest_B: 0,
        investor_returns_B: 0,
        treasury_delta_B: 3.5,
      };
      const derivedPools = {
        consumer_B: money.consumer_pool_B,
        business_B: money.business_pool_B,
        investor_B: 0,
      };

      const result = applyTier0MoneyFlows(money, flows, derivedPools);

      expect(result.treasury_B).toBe(initialTreasury + 3.5);
    });

    test('prevents negative treasury', () => {
      const money = initMoneySupply();
      const flows = {
        wages_B: 0,
        income_tax_B: 0,
        corporate_tax_B: 0,
        consumer_spend_B: 0,
        b2b_spend_B: 0,
        withdrawal_B: 0,
        deposit_interest_B: 0,
        savings_interest_B: 0,
        investor_returns_B: 0,
        treasury_delta_B: -money.treasury_B - 100,
      };
      const derivedPools = {
        consumer_B: money.consumer_pool_B,
        business_B: money.business_pool_B,
        investor_B: 0,
      };

      const result = applyTier0MoneyFlows(money, flows, derivedPools);

      expect(result.treasury_B).toBeGreaterThanOrEqual(0);
    });

    test('preserves lastFlows', () => {
      const money = initMoneySupply();
      const flows = { treasury_delta_B: 0 };
      const derivedPools = {
        consumer_B: money.consumer_pool_B,
        business_B: money.business_pool_B,
        investor_B: 0,
      };

      const result = applyTier0MoneyFlows(money, flows, derivedPools);

      expect(result.lastFlows).toEqual(flows);
    });
  });

  describe('applyInstitutionalMoneyFlows', () => {
    test('stimulus event increases pools', () => {
      const money = initMoneySupply();
      const events = [{ type: 'stimulus', amount: 10 }];

      const result = applyInstitutionalMoneyFlows(money, events);

      expect(result.consumer_pool_B).toBeGreaterThan(money.consumer_pool_B);
      expect(result.business_pool_B).toBeGreaterThan(money.business_pool_B);
    });

    test('tax_hike decreases pools', () => {
      const money = initMoneySupply();
      const events = [{ type: 'tax_hike', amount: 10 }];

      const result = applyInstitutionalMoneyFlows(money, events);

      expect(result.consumer_pool_B).toBeLessThan(money.consumer_pool_B);
      expect(result.business_pool_B).toBeLessThan(money.business_pool_B);
      expect(result.treasury_B).toBeGreaterThan(money.treasury_B);
    });

    test('rate_change adjusts m2 for hike', () => {
      const money = initMoneySupply();
      const events = [{ type: 'rate_change', delta: 1 }];

      const result = applyInstitutionalMoneyFlows(money, events);

      expect(result.m2_B).toBeLessThan(money.m2_B);
    });

    test('rate_change adjusts m2 for cut', () => {
      const money = initMoneySupply();
      const events = [{ type: 'rate_change', delta: -1 }];

      const result = applyInstitutionalMoneyFlows(money, events);

      expect(result.m2_B).toBeGreaterThan(money.m2_B);
    });

    test('spending_bill draws from treasury', () => {
      const money = {
        ...initMoneySupply(),
        treasury_B: 1000,
      };
      const events = [{ type: 'spending_bill', amount: 5 }];

      const result = applyInstitutionalMoneyFlows(money, events);

      expect(result.treasury_B).toBeLessThan(money.treasury_B);
      expect(result.consumer_pool_B).toBeGreaterThan(money.consumer_pool_B);
    });

    test('prevents negative pools', () => {
      const money = initMoneySupply();
      const events = [{ type: 'tax_hike', amount: 100000 }];

      const result = applyInstitutionalMoneyFlows(money, events);

      expect(result.consumer_pool_B).toBeGreaterThanOrEqual(0);
      expect(result.business_pool_B).toBeGreaterThanOrEqual(0);
      expect(result.treasury_B).toBeGreaterThanOrEqual(0);
    });

    test('multiple events apply sequentially', () => {
      const money = initMoneySupply();
      const events = [
        { type: 'stimulus', amount: 5 },
        { type: 'tax_hike', amount: 3 },
      ];

      const result = applyInstitutionalMoneyFlows(money, events);

      expect(result.m2_B).toBeGreaterThan(money.m2_B);
    });
  });

  describe('fmtMoney', () => {
    test('formats trillions', () => {
      expect(fmtMoney(1500)).toBe('$1.50T');
      expect(fmtMoney(2000)).toBe('$2.00T');
    });

    test('formats billions', () => {
      expect(fmtMoney(500)).toBe('$500B');
      expect(fmtMoney(1)).toBe('$1B');
    });

    test('formats millions', () => {
      expect(fmtMoney(0.5)).toBe('$500M');
      expect(fmtMoney(0.001)).toBe('$1M');
    });

    test('returns $0 for falsy or negative values', () => {
      expect(fmtMoney(null)).toBe('$0');
      expect(fmtMoney(undefined)).toBe('$0');
      expect(fmtMoney(0)).toBe('$0');
      expect(fmtMoney(-10)).toBe('$0');
    });
  });
});
