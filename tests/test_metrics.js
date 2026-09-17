const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const storage = new Map();
const window = {
  location: { href: 'https://example.test/' },
  localStorage: {
    getItem: (k) => storage.has(k) ? storage.get(k) : null,
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
  dispatchEvent: () => {},
};
const context = {
  window,
  localStorage: window.localStorage,
  CustomEvent: function(name, init){ this.name=name; this.detail=init && init.detail; },
  URL,
  Blob: global.Blob,
  console,
  setTimeout,
  clearTimeout,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('src/auction-radar-phase1.js', 'utf8'), context);
const engine = window.AuctionRadarPhase1;

function rec({price=100000, market=130000, rent=0, renovation=0, other=0}={}) {
  return {
    startingPrice: price,
    sqm: 100,
    analysis: {
      estimatedMarketValue: market,
      estimatedMonthlyRent: rent,
      renovationCost: renovation,
      otherPurchaseCosts: other,
    }
  };
}

// Immediate sale must remain a valid strategy even below the 50% target.
{
  const m = engine.computeMetrics(rec({price:100000, market:130000, rent:0}));
  assert.strictEqual(m.immediateSaleProfit, 30000);
  assert.strictEqual(m.immediateSaleROI, 0.30);
  assert.strictEqual(m.strategy, 'immediate_sale');
  assert.strictEqual(m.immediateSaleTarget50, false);
}

// The 3-year scenario includes rental income plus the final sale.
{
  const m = engine.computeMetrics(rec({price:100000, market:110000, rent:1500}));
  assert.strictEqual(m.threeYearRentalIncome, 54000);
  assert.strictEqual(m.threeYearTotalProfit, 64000);
  assert.strictEqual(m.threeYearROI, 0.64);
  assert.ok(Math.abs(m.threeYearAnnualizedROI - (Math.pow(1.64, 1/3)-1)) < 1e-12);
  assert.strictEqual(m.strategy, 'three_year_hold');
}

// Without C&H estimates the ranking must say that an estimate is needed,
// rather than inventing a profitability result.
{
  const m = engine.computeMetrics({startingPrice:100000, sqm:100, analysis:{}});
  assert.strictEqual(m.immediateSaleROI, null);
  assert.strictEqual(m.threeYearROI, null);
  assert.strictEqual(m.strategy, 'needs_estimate');
  assert.ok(Number.isFinite(m.score));
}

console.log('test_metrics.js: OK');
