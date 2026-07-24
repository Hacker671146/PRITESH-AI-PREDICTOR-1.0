
const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('node:fs/promises');
const path = require('node:path');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const NAME = 'WIN GO MATHEMATICAL ANALYTICS V5.0';

const API_URL =
  process.env.WINGO_API_URL ||
  'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json';

const DATA_FILE =
  process.env.DATA_FILE ||
  path.join(process.cwd(), 'data', 'wingo-state.json');

const POLL_INTERVAL = Math.max(
  15000,
  Number(process.env.POLL_MS || 60000)
);

const FETCH_LIMIT = Math.min(
  200,
  Math.max(10, Number(process.env.FETCH_LIMIT || 100))
);

const HISTORY_LIMIT = 10000;
const MODEL_HISTORY_LIMIT = 1000;

const SIMULATED_STAKE = Number(process.env.SIMULATED_STAKE || 10);
const PAYOUT_MULTIPLIER = Number(process.env.PAYOUT_MULTIPLIER || 1.98);

const apiCache = new NodeCache({
  stdTTL: 10,
  checkperiod: 20,
  useClones: true
});

let isProcessing = false;
let isReady = false;
let intervalHandle = null;
let observedPeriods = new Set();

/* -------------------------------------------------------------------------- */
/*                               HELPER FUNCTIONS                             */
/* -------------------------------------------------------------------------- */

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function isValidNumber(number) {
  return Number.isInteger(number) && number >= 0 && number <= 9;
}

function getSide(number) {
  return number >= 5 ? 'BIG' : 'SMALL';
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function percentage(value) {
  return `${safeNumber(value).toFixed(2)}%`;
}

function comparePeriods(a, b) {
  try {
    const left = BigInt(String(a));
    const right = BigInt(String(b));

    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  } catch {
    return String(a).localeCompare(String(b), undefined, {
      numeric: true
    });
  }
}

function getNextPeriod(period) {
  const periodString = String(period);

  if (!/^\d+$/.test(periodString)) {
    return null;
  }

  try {
    let next = (BigInt(periodString) + 1n).toString();

    // Preserve leading zeroes if API ever returns them.
    if (periodString.startsWith('0')) {
      next = next.padStart(periodString.length, '0');
    }

    return next;
  } catch {
    return null;
  }
}

function calculateWinRate(total, wins) {
  if (!total) return 0;
  return Number(((wins / total) * 100).toFixed(2));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/* -------------------------------------------------------------------------- */
/*                           PERSISTENT JSON STATE                            */
/* -------------------------------------------------------------------------- */

class PersistentStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = this.createFreshState();
  }

  createFreshState() {
    return {
      schemaVersion: 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),

      lastObservedPeriod: null,

      // Last 10,000 prediction records.
      records: [],

      // Pending predictions waiting for actual result.
      pending: {},

      // Used to avoid duplicate API result processing.
      observedPeriods: [],

      // Model rebuild data after restart.
      trainingHistory: [],

      // Mathematical model performance data.
      modelPerformance: {},

      // Lifetime aggregate stats.
      lifetime: {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        pnl: 0
      }
    };
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);

      this.state = {
        ...this.createFreshState(),
        ...parsed
      };

      this.sanitize();
      console.log(`[STORE] Loaded persistent state from ${this.filePath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`[STORE] Cannot read state file: ${error.message}`);
      }

      this.state = this.createFreshState();
      console.log('[STORE] Starting with fresh state.');
    }
  }

  sanitize() {
    if (!Array.isArray(this.state.records)) {
      this.state.records = [];
    }

    if (!Array.isArray(this.state.observedPeriods)) {
      this.state.observedPeriods = [];
    }

    if (!Array.isArray(this.state.trainingHistory)) {
      this.state.trainingHistory = [];
    }

    if (!isPlainObject(this.state.pending)) {
      this.state.pending = {};
    }

    if (!isPlainObject(this.state.modelPerformance)) {
      this.state.modelPerformance = {};
    }

    if (!isPlainObject(this.state.lifetime)) {
      this.state.lifetime = {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        pnl: 0
      };
    }

    this.state.lifetime = {
      totalTrades: safeNumber(this.state.lifetime.totalTrades, 0),
      wins: safeNumber(this.state.lifetime.wins, 0),
      losses: safeNumber(this.state.lifetime.losses, 0),
      pnl: safeNumber(this.state.lifetime.pnl, 0)
    };

    this.state.observedPeriods = [
      ...new Set(this.state.observedPeriods.map(String))
    ].slice(-HISTORY_LIMIT);

    this.state.trainingHistory = this.state.trainingHistory
      .filter(
        (item) =>
          item &&
          isValidNumber(Number(item.number)) &&
          item.period !== undefined
      )
      .map((item) => ({
        period: String(item.period),
        number: Number(item.number),
        observedAt: item.observedAt || new Date().toISOString()
      }))
      .slice(-MODEL_HISTORY_LIMIT);

    this.state.records.sort((a, b) =>
      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    );

    this.trimHistory();
  }

  trimHistory() {
    const pendingPeriods = new Set(Object.keys(this.state.pending));

    const pendingRecords = this.state.records.filter(
      (record) =>
        record.status === 'PENDING' ||
        pendingPeriods.has(String(record.period))
    );

    const settledRecords = this.state.records.filter(
      (record) =>
        record.status !== 'PENDING' &&
        !pendingPeriods.has(String(record.period))
    );

    const remainingSpace = Math.max(
      0,
      HISTORY_LIMIT - pendingRecords.length
    );

    this.state.records = [
      ...settledRecords.slice(-remainingSpace),
      ...pendingRecords
    ].sort((a, b) =>
      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    );

    this.state.observedPeriods = this.state.observedPeriods.slice(
      -HISTORY_LIMIT
    );

    this.state.trainingHistory = this.state.trainingHistory.slice(
      -MODEL_HISTORY_LIMIT
    );
  }

  async save() {
    this.trimHistory();

    this.state.updatedAt = new Date().toISOString();

    await fs.mkdir(path.dirname(this.filePath), {
      recursive: true
    });

    const temporaryFile = `${this.filePath}.${process.pid}.tmp`;

    await fs.writeFile(
      temporaryFile,
      JSON.stringify(this.state, null, 2),
      'utf8'
    );

    await fs.rename(temporaryFile, this.filePath);
  }

  findRecordById(id) {
    for (let i = this.state.records.length - 1; i >= 0; i--) {
      if (this.state.records[i].id === id) {
        return this.state.records[i];
      }
    }

    return null;
  }

  findRecordByPeriod(period) {
    for (let i = this.state.records.length - 1; i >= 0; i--) {
      if (String(this.state.records[i].period) === String(period)) {
        return this.state.records[i];
      }
    }

    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                      MATHEMATICAL / STATISTICAL MODELS                     */
/* -------------------------------------------------------------------------- */

const MODEL_NAMES = [
  'bayesian',
  'markov',
  'runLength',
  'dirichletFrequency'
];

class MathematicalPredictor {
  constructor() {
    this.numbers = [];

    this.weights = {
      bayesian: 0.25,
      markov: 0.25,
      runLength: 0.25,
      dirichletFrequency: 0.25
    };

    this.performance = {};

    for (const model of MODEL_NAMES) {
      this.performance[model] = {
        count: 0,
        correct: 0,
        brierEma: 0.25
      };
    }
  }

  restore(trainingHistory, savedPerformance) {
    this.numbers = trainingHistory
      .map((item) => Number(item.number))
      .filter(isValidNumber)
      .slice(-MODEL_HISTORY_LIMIT);

    for (const model of MODEL_NAMES) {
      const saved = savedPerformance?.[model];

      if (saved) {
        this.performance[model] = {
          count: safeNumber(saved.count, 0),
          correct: safeNumber(saved.correct, 0),
          brierEma: clamp(safeNumber(saved.brierEma, 0.25), 0, 1)
        };
      }
    }

    this.updateWeights();
  }

  observe(number) {
    if (!isValidNumber(number)) return;

    this.numbers.push(number);

    if (this.numbers.length > MODEL_HISTORY_LIMIT) {
      this.numbers.shift();
    }
  }

  getBinaryHistory() {
    return this.numbers.map((number) => (number >= 5 ? 1 : 0));
  }

  /*
   * Bayesian recency model:
   * Uses exponentially weighted Beta-Binomial posterior.
   */
  bayesianPrediction(binary) {
    if (!binary.length) return 0.5;

    let alpha = 1;
    let beta = 1;
    let totalWeight = 0;

    const halfLife = 40;

    for (let i = 0; i < binary.length; i++) {
      const age = binary.length - 1 - i;
      const weight = Math.pow(0.5, age / halfLife);

      totalWeight += weight;

      if (binary[i] === 1) {
        alpha += weight;
      } else {
        beta += weight;
      }
    }

    const posterior = alpha / (alpha + beta);
    const evidenceStrength = totalWeight / (totalWeight + 12);

    return clamp(0.5 + (posterior - 0.5) * evidenceStrength);
  }

  /*
   * Variable-order Markov:
   * Finds latest matching pattern from order 5 down to order 1.
   * Laplace smoothing prevents overconfidence on small sample sizes.
   */
  markovPrediction(binary) {
    if (binary.length < 3) return 0.5;

    const maxOrder = Math.min(5, binary.length - 1);

    for (let order = maxOrder; order >= 1; order--) {
      const targetState = binary.slice(-order).join('');

      let bigCount = 0;
      let totalCount = 0;

      for (let nextIndex = order; nextIndex < binary.length; nextIndex++) {
        const state = binary
          .slice(nextIndex - order, nextIndex)
          .join('');

        if (state === targetState) {
          totalCount++;

          if (binary[nextIndex] === 1) {
            bigCount++;
          }
        }
      }

      if (totalCount >= 2 || order === 1) {
        if (totalCount === 0) return 0.5;

        const smoothed = (bigCount + 1) / (totalCount + 2);
        const evidenceStrength = totalCount / (totalCount + 10);

        return clamp(
          0.5 + (smoothed - 0.5) * evidenceStrength
        );
      }
    }

    return 0.5;
  }

  /*
   * Run length model:
   * Checks historical behavior after a BIG/SMALL streak of similar length.
   * It is smoothed to avoid gambler-fallacy style overconfidence.
   */
  runLengthPrediction(binary) {
    if (binary.length < 3) return 0.5;

    const getRunContext = (endIndex) => {
      const value = binary[endIndex];
      let length = 1;

      for (let index = endIndex - 1; index >= 0; index--) {
        if (binary[index] !== value) break;
        length++;
      }

      return `${value}:${Math.min(length, 5)}`;
    };

    const targetContext = getRunContext(binary.length - 1);

    let bigCount = 0;
    let totalCount = 0;

    for (let nextIndex = 1; nextIndex < binary.length; nextIndex++) {
      const historicalContext = getRunContext(nextIndex - 1);

      if (historicalContext === targetContext) {
        totalCount++;

        if (binary[nextIndex] === 1) {
          bigCount++;
        }
      }
    }

    if (totalCount === 0) return 0.5;

    const smoothed = (bigCount + 1) / (totalCount + 2);
    const evidenceStrength = totalCount / (totalCount + 12);

    return clamp(
      0.5 + (smoothed - 0.5) * evidenceStrength
    );
  }

  /*
   * Dirichlet weighted frequency:
   * Uses decayed per-number probabilities, then sums 5-9 for BIG.
   */
  dirichletFrequencyPrediction() {
    if (!this.numbers.length) return 0.5;

    const counts = new Array(10).fill(1);
    const halfLife = 150;
    let totalEvidence = 0;

    for (let i = 0; i < this.numbers.length; i++) {
      const age = this.numbers.length - 1 - i;
      const weight = Math.pow(0.5, age / halfLife);

      counts[this.numbers[i]] += weight;
      totalEvidence += weight;
    }

    const total = counts.reduce((sum, value) => sum + value, 0);

    const bigProbability =
      counts.slice(5, 10).reduce((sum, value) => sum + value, 0) /
      total;

    const evidenceStrength = totalEvidence / (totalEvidence + 25);

    return clamp(
      0.5 + (bigProbability - 0.5) * evidenceStrength
    );
  }

  predictNumber(predictedSide) {
    const counts = new Array(10).fill(1);
    const halfLife = 100;

    for (let i = 0; i < this.numbers.length; i++) {
      const age = this.numbers.length - 1 - i;
      const weight = Math.pow(0.5, age / halfLife);

      counts[this.numbers[i]] += weight;
    }

    const candidates =
      predictedSide === 'BIG'
        ? [5, 6, 7, 8, 9]
        : [0, 1, 2, 3, 4];

    let bestNumber = candidates[0];
    let maxScore = -Infinity;

    for (const number of candidates) {
      if (counts[number] > maxScore) {
        maxScore = counts[number];
        bestNumber = number;
      }
    }

    return bestNumber;
  }

  predict() {
    const binary = this.getBinaryHistory();

    const modelScores = {
      bayesian: this.bayesianPrediction(binary),
      markov: this.markovPrediction(binary),
      runLength: this.runLengthPrediction(binary),
      dirichletFrequency: this.dirichletFrequencyPrediction()
    };

    let weightedSum = 0;
    let totalWeight = 0;

    for (const model of MODEL_NAMES) {
      const score = modelScores[model];
      const weight = this.weights[model] || 0.25;

      weightedSum += score * weight;
      totalWeight += weight;
    }

    const probabilityBig =
      totalWeight > 0 ? weightedSum / totalWeight : 0.5;

    const predictedSide =
      probabilityBig >= 0.5 ? 'BIG' : 'SMALL';

    const scoreValues = Object.values(modelScores);
    const average =
      scoreValues.reduce((sum, value) => sum + value, 0) /
      scoreValues.length;

    const variance =
      scoreValues.reduce(
        (sum, value) => sum + Math.pow(value - average, 2),
        0
      ) / scoreValues.length;

    const standardDeviation = Math.sqrt(variance);

    const directionStrength =
      Math.abs(probabilityBig - 0.5) * 2;

    const agreement = clamp(1 - standardDeviation * 4);

    // Signal strength only. It is NOT guaranteed win probability.
    const confidence = clamp(
      directionStrength * agreement * 100,
      0,
      100
    );

    return {
      side: predictedSide,
      probabilityBig: clamp(probabilityBig),
      confidence,
      predictedNumber: this.predictNumber(predictedSide),
      modelScores,
      modelWeights: { ...this.weights },
      dataPoints: this.numbers.length
    };
  }

  evaluate(modelScores, actualBinary) {
    if (!modelScores) return;

    for (const model of MODEL_NAMES) {
      const probability = modelScores[model];

      if (!Number.isFinite(probability)) continue;

      const performance = this.performance[model];

      const loss = Math.pow(
        clamp(probability) - actualBinary,
        2
      );

      const predictedBinary = probability >= 0.5 ? 1 : 0;

      const previousCount = performance.count;
      performance.count++;

      if (predictedBinary === actualBinary) {
        performance.correct++;
      }

      if (previousCount === 0) {
        performance.brierEma = loss;
      } else {
        // Moving average window around 50 observations.
        const alpha = 1 / Math.min(performance.count, 50);

        performance.brierEma =
          performance.brierEma +
          alpha * (loss - performance.brierEma);
      }
    }

    this.updateWeights();
  }

  updateWeights() {
    const minSamples = Math.min(
      ...MODEL_NAMES.map(
        (model) => this.performance[model].count
      )
    );

    // Equal weights until enough evaluated data exists.
    if (minSamples < 30) {
      for (const model of MODEL_NAMES) {
        this.weights[model] = 1 / MODEL_NAMES.length;
      }

      return;
    }

    const rawWeights = {};
    let total = 0;

    for (const model of MODEL_NAMES) {
      const performance = this.performance[model];

      // Shrink toward baseline Brier score 0.25 to reduce overfitting.
      const effectiveSamples = Math.min(performance.count, 50);

      const shrunkBrier =
        (performance.brierEma * effectiveSamples + 0.25 * 50) /
        (effectiveSamples + 50);

      const reliability = 1 / Math.max(0.08, shrunkBrier);

      rawWeights[model] = reliability;
      total += reliability;
    }

    for (const model of MODEL_NAMES) {
      this.weights[model] = rawWeights[model] / total;
    }
  }

  exportPerformance() {
    return JSON.parse(JSON.stringify(this.performance));
  }

  getModelHealth() {
    const result = {};

    for (const model of MODEL_NAMES) {
      const performance = this.performance[model];

      result[model] = {
        samples: performance.count,
        directionalAccuracy: calculateWinRate(
          performance.count,
          performance.correct
        ),
        brierScore: Number(performance.brierEma.toFixed(6)),
        weight: Number((this.weights[model] || 0).toFixed(6))
      };
    }

    return result;
  }
}

/* -------------------------------------------------------------------------- */
/*                             GLOBAL INSTANCES                               */
/* -------------------------------------------------------------------------- */

const store = new PersistentStore(DATA_FILE);
const predictor = new MathematicalPredictor();

/* -------------------------------------------------------------------------- */
/*                                API FETCHING                                */
/* -------------------------------------------------------------------------- */

function normalizeApiResult(item) {
  if (!item || typeof item !== 'object') return null;

  const rawPeriod =
    item.issue ??
    item.issueNumber ??
    item.period ??
    item.id;

  const rawNumber =
    item.number ??
    item.openNumber ??
    item.result ??
    item.winNumber;

  if (rawPeriod === undefined || rawNumber === undefined) {
    return null;
  }

  const period = String(rawPeriod).trim();
  const number = Number(String(rawNumber).trim());

  if (!period || !isValidNumber(number)) {
    return null;
  }

  return {
    period,
    number
  };
}

async function fetchLatestResults(limit = FETCH_LIMIT) {
  const cacheKey = `wingo_results_${limit}`;
  const cached = apiCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  try {
    const response = await axios.get(API_URL, {
      params: {
        ts: Date.now(),
        limit,
        pageNo: 1,
        pageSize: limit
      },
      timeout: 15000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Referer: 'https://www.ar-lottery01.com/',
        Origin: 'https://draw.ar-lottery01.com'
      }
    });

    const payload = response.data;

    const candidates = [
      payload?.data?.list,
      payload?.data?.records,
      payload?.list,
      payload?.records
    ];

    const list = candidates.find(Array.isArray) || [];

    const unique = new Map();

    for (const item of list) {
      const normalized = normalizeApiResult(item);

      if (normalized) {
        unique.set(normalized.period, normalized);
      }
    }

    const results = [...unique.values()].sort((a, b) =>
      comparePeriods(a.period, b.period)
    );

    if (!results.length) {
      console.error('[API] No valid result list found in API response.');
      return null;
    }

    apiCache.set(cacheKey, results);

    return results;
  } catch (error) {
    const status = error.response?.status
      ? `HTTP ${error.response.status}`
      : '';

    console.error(
      `[API ERROR] ${status} ${error.message}`.trim()
    );

    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                            PREDICTION RECORDING                            */
/* -------------------------------------------------------------------------- */

function createPredictionSnapshot(period, prediction) {
  return {
    period: String(period),
    prediction: prediction.side,
    probabilityBig: Number(
      prediction.probabilityBig.toFixed(6)
    ),
    confidence: Number(prediction.confidence.toFixed(2)),
    predictedNumber: prediction.predictedNumber,
    modelScores: prediction.modelScores,
    modelWeights: prediction.modelWeights,
    dataPoints: prediction.dataPoints,
    createdAt: new Date().toISOString()
  };
}

function publicPrediction(snapshot) {
  if (!snapshot) return null;

  return {
    period: snapshot.period,
    prediction: snapshot.prediction,
    probabilityBig: snapshot.probabilityBig,
    confidence: percentage(snapshot.confidence),
    predictedNumber: snapshot.predictedNumber,
    modelScores: snapshot.modelScores,
    modelWeights: snapshot.modelWeights,
    dataPoints: snapshot.dataPoints,
    createdAt: snapshot.createdAt
  };
}

function createVirtualTrade(period, prediction) {
  const snapshot = createPredictionSnapshot(period, prediction);

  const recordId = `SIM-${period}-${Date.now()}`;

  const record = {
    id: recordId,
    status: 'PENDING',

    ...snapshot,

    virtualBet: {
      type: 'BIG_SMALL_SIMULATION',
      selection: snapshot.prediction,
      stake: SIMULATED_STAKE,
      payoutMultiplier: PAYOUT_MULTIPLIER
    }
  };

  store.state.records.push(record);

  store.state.pending[String(period)] = {
    recordId,
    ...snapshot,
    stake: SIMULATED_STAKE,
    payoutMultiplier: PAYOUT_MULTIPLIER
  };

  console.log(
    `[PREDICTION] Period ${period} | ${snapshot.prediction} | ` +
      `Signal: ${percentage(snapshot.confidence)} | ` +
      `Number Hint: ${snapshot.predictedNumber}`
  );

  return record;
}

function settleVirtualTrade(period, actualNumber) {
  const pending = store.state.pending[String(period)];

  if (!pending) return false;

  const actualSide = getSide(actualNumber);
  const isWin = pending.prediction === actualSide;

  const stake = safeNumber(pending.stake, SIMULATED_STAKE);
  const payoutMultiplier = safeNumber(
    pending.payoutMultiplier,
    PAYOUT_MULTIPLIER
  );

  const grossReturn = isWin ? stake * payoutMultiplier : 0;
  const netPnl = isWin
    ? Number((grossReturn - stake).toFixed(2))
    : Number((-stake).toFixed(2));

  const record =
    store.findRecordById(pending.recordId) ||
    store.findRecordByPeriod(period);

  if (record) {
    record.status = 'SETTLED';
    record.actualNumber = actualNumber;
    record.actual = actualSide;
    record.result = isWin ? 'WIN' : 'LOSS';
    record.isWin = isWin;
    record.grossReturn = grossReturn;
    record.netPnl = netPnl;
    record.settledAt = new Date().toISOString();
  }

  predictor.evaluate(
    pending.modelScores,
    actualNumber >= 5 ? 1 : 0
  );

  store.state.lifetime.totalTrades++;

  if (isWin) {
    store.state.lifetime.wins++;
  } else {
    store.state.lifetime.losses++;
  }

  store.state.lifetime.pnl = Number(
    (store.state.lifetime.pnl + netPnl).toFixed(2)
  );

  delete store.state.pending[String(period)];

  console.log(
    `[RESULT] Period ${period} | ` +
      `Prediction: ${pending.prediction} | ` +
      `Actual: ${actualSide} (${actualNumber}) | ` +
      `${isWin ? 'WIN ✅' : 'LOSS ❌'} | P&L: ${netPnl}`
  );

  return true;
}

function rememberObservedResult(result) {
  predictor.observe(result.number);

  store.state.trainingHistory.push({
    period: result.period,
    number: result.number,
    observedAt: new Date().toISOString()
  });

  store.state.trainingHistory = store.state.trainingHistory.slice(
    -MODEL_HISTORY_LIMIT
  );

  store.state.observedPeriods.push(String(result.period));

  if (store.state.observedPeriods.length > HISTORY_LIMIT) {
    const removed = store.state.observedPeriods.shift();

    if (removed) {
      observedPeriods.delete(String(removed));
    }
  }

  observedPeriods.add(String(result.period));

  store.state.lastObservedPeriod = String(result.period);
}

/* -------------------------------------------------------------------------- */
/*                            MAIN PROCESSING FLOW                            */
/* -------------------------------------------------------------------------- */

async function processPrediction() {
  if (!isReady || isProcessing) {
    return;
  }

  isProcessing = true;

  try {
    const results = await fetchLatestResults(FETCH_LIMIT);

    if (!results || !results.length) {
      console.log('[PROCESS] API returned no usable results.');
      return;
    }

    let stateChanged = false;

    // Results are sorted oldest -> newest.
    for (const result of results) {
      const alreadyObserved = observedPeriods.has(result.period);

      // Recovery case: period was marked observed but pending prediction exists.
      if (alreadyObserved) {
        if (store.state.pending[result.period]) {
          settleVirtualTrade(result.period, result.number);
          stateChanged = true;
        }

        continue;
      }

      // First settle prediction, then train with actual result.
      if (store.state.pending[result.period]) {
        settleVirtualTrade(result.period, result.number);
      }

      rememberObservedResult(result);
      stateChanged = true;
    }

    const latestResult = results[results.length - 1];
    const nextPeriod = getNextPeriod(latestResult.period);

    if (!nextPeriod) {
      console.error(
        `[PROCESS] Cannot calculate next period from ${latestResult.period}`
      );

      if (stateChanged) {
        store.state.modelPerformance =
          predictor.exportPerformance();

        await store.save();
      }

      return;
    }

    const alreadyPending = Boolean(store.state.pending[nextPeriod]);
    const recordExists = Boolean(
      store.findRecordByPeriod(nextPeriod)
    );

    // Only one prediction per period.
    if (!alreadyPending && !recordExists) {
      const prediction = predictor.predict();

      createVirtualTrade(nextPeriod, prediction);
      stateChanged = true;
    }

    if (stateChanged) {
      store.state.modelPerformance =
        predictor.exportPerformance();

      await store.save();
    }
  } catch (error) {
    console.error(`[PROCESS ERROR] ${error.message}`);
  } finally {
    isProcessing = false;
  }
}

/* -------------------------------------------------------------------------- */
/*                              STATISTICS API                                */
/* -------------------------------------------------------------------------- */

function buildStatistics() {
  const settled = store.state.records.filter(
    (record) => record.status === 'SETTLED'
  );

  const retainedWins = settled.filter(
    (record) => record.isWin
  ).length;

  const retainedPnl = settled.reduce(
    (sum, record) => sum + safeNumber(record.netPnl, 0),
    0
  );

  return {
    lifetime: {
      totalTrades: store.state.lifetime.totalTrades,
      wins: store.state.lifetime.wins,
      losses: store.state.lifetime.losses,
      winRate: calculateWinRate(
        store.state.lifetime.totalTrades,
        store.state.lifetime.wins
      ),
      pnl: Number(store.state.lifetime.pnl.toFixed(2))
    },

    retainedHistory: {
      maxRecords: HISTORY_LIMIT,
      recordsStored: store.state.records.length,
      settledRecords: settled.length,
      wins: retainedWins,
      losses: settled.length - retainedWins,
      winRate: calculateWinRate(
        settled.length,
        retainedWins
      ),
      pnl: Number(retainedPnl.toFixed(2))
    }
  };
}

function getCurrentPendingPrediction() {
  const pending = Object.values(store.state.pending);

  if (!pending.length) {
    return null;
  }

  pending.sort((a, b) =>
    String(b.createdAt || '').localeCompare(
      String(a.createdAt || '')
    )
  );

  return pending[0];
}

/* -------------------------------------------------------------------------- */
/*                               EXPRESS ROUTES                               */
/* -------------------------------------------------------------------------- */

app.get('/', (req, res) => {
  res.json({
    name: NAME,
    status: isReady ? 'active' : 'initializing',
    mode: 'simulation_and_analytics',
    warning:
      'Lottery outcomes are random. Confidence is model signal strength, not a guaranteed win rate.',
    endpoints: {
      trade: '/trade',
      status: '/status',
      history: '/history?limit=20',
      predict: '/predict',
      health: '/health'
    }
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    ready: isReady,
    processing: isProcessing,
    timestamp: new Date().toISOString()
  });
});

app.get('/status', (req, res) => {
  res.json({
    status: isReady ? 'active' : 'initializing',
    name: NAME,
    lastObservedPeriod: store.state.lastObservedPeriod,
    pendingPredictions: Object.keys(store.state.pending).length,
    recordsStored: store.state.records.length,
    totalTrackedLimit: HISTORY_LIMIT,
    isProcessing,
    pollIntervalMs: POLL_INTERVAL,
    modelHistorySize: predictor.numbers.length,
    timestamp: new Date().toISOString()
  });
});

app.get('/trade', (req, res) => {
  const stats = buildStatistics();
  const currentPending = getCurrentPendingPrediction();

  const last10Results = store.state.records
    .filter((record) => record.status === 'SETTLED')
    .slice(-10)
    .reverse();

  res.json({
    bot: {
      name: NAME,
      status: isReady ? 'active' : 'initializing',
      version: '5.0',
      mode: 'SIMULATION_ONLY',
      flow:
        'API Poll -> Mathematical Models -> Save Prediction -> Settle On Actual Result'
    },

    currentPrediction: currentPending
      ? publicPrediction(currentPending)
      : {
          period: 'WAITING',
          prediction: 'WAITING',
          confidence: '0.00%',
          predictedNumber: null
        },

    statistics: stats,

    modelWeights: predictor.weights,

    modelHealth: predictor.getModelHealth(),

    last10Results,

    note:
      'No 90% accuracy guarantee is possible for a fair random draw. Use this as analytics/simulation only.',

    timestamp: new Date().toISOString()
  });
});

app.get('/history', (req, res) => {
  const requestedLimit = Number.parseInt(req.query.limit, 10);

  const limit = Math.min(
    HISTORY_LIMIT,
    Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 20)
  );

  const requestedStatus = String(
    req.query.status || ''
  ).toUpperCase();

  let records = [...store.state.records];

  if (requestedStatus === 'PENDING' || requestedStatus === 'SETTLED') {
    records = records.filter(
      (record) => record.status === requestedStatus
    );
  }

  records = records.slice(-limit).reverse();

  res.json({
    limit,
    retainedLimit: HISTORY_LIMIT,
    totalRecords: store.state.records.length,
    returnedRecords: records.length,
    results: records,
    timestamp: new Date().toISOString()
  });
});

app.get('/predict', (req, res) => {
  const prediction = predictor.predict();

  const nextPeriod = store.state.lastObservedPeriod
    ? getNextPeriod(store.state.lastObservedPeriod)
    : null;

  res.json({
    prediction: publicPrediction({
      period: nextPeriod || 'UNKNOWN',
      prediction: prediction.side,
      probabilityBig: prediction.probabilityBig,
      confidence: prediction.confidence,
      predictedNumber: prediction.predictedNumber,
      modelScores: prediction.modelScores,
      modelWeights: prediction.modelWeights,
      dataPoints: prediction.dataPoints,
      createdAt: new Date().toISOString()
    }),
    note:
      'Manual endpoint only. This call does not create a saved virtual trade.',
    timestamp: new Date().toISOString()
  });
});

/* -------------------------------------------------------------------------- */
/*                               APPLICATION START                            */
/* -------------------------------------------------------------------------- */

async function bootstrap() {
  await store.load();

  observedPeriods = new Set(
    store.state.observedPeriods.map(String)
  );

  predictor.restore(
    store.state.trainingHistory,
    store.state.modelPerformance
  );

  isReady = true;

  console.log('='.repeat(65));
  console.log(`🚀 ${NAME} started`);
  console.log(`📦 Persistent file: ${DATA_FILE}`);
  console.log(`🧠 Model history: ${predictor.numbers.length}`);
  console.log(`🗂️  Saved records limit: ${HISTORY_LIMIT}`);
  console.log(`⏱️  Poll interval: ${POLL_INTERVAL}ms`);
  console.log('='.repeat(65));

  await processPrediction();

  intervalHandle = setInterval(() => {
    processPrediction().catch((error) => {
      console.error(`[INTERVAL ERROR] ${error.message}`);
    });
  }, POLL_INTERVAL);
}

async function shutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal} received. Saving state...`);

  if (intervalHandle) {
    clearInterval(intervalHandle);
  }

  try {
    store.state.modelPerformance =
      predictor.exportPerformance();

    await store.save();
  } catch (error) {
    console.error(`[SHUTDOWN SAVE ERROR] ${error.message}`);
  } finally {
    process.exit(0);
  }
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📡 Trade API: http://localhost:${PORT}/trade`);
    console.log(`📊 Status API: http://localhost:${PORT}/status`);
    console.log(`📜 History API: http://localhost:${PORT}/history`);
  });

  bootstrap().catch((error) => {
    console.error(`[BOOTSTRAP ERROR] ${error.message}`);
    process.exitCode = 1;
  });

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = app;
```

---

## `package.json`

```json
{
  "name": "wingo-mathematical-analytics-v5",
  "version": "5.0.0",
  "description": "WinGo mathematical analytics, simulated prediction tracking and persistent result history",
  "main": "server.js",
  "type": "commonjs",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "axios": "^1.7.9",
    "express": "^4.21.2",
    "node-cache": "^5.1.2"
  },
  "devDependencies": {
    "nodemon": "^3.1.7"
  },
  "license": "MIT"
}
```

---

## Install / Run

```bash
npm install
npm start
```

Development mode:

```bash
npm run dev
```

---

## Useful APIs

```bash
# Current prediction, statistics, last 10 settled records
http://localhost:3000/trade

# Bot status
http://localhost:3000/status

# Last 20 history records
http://localhost:3000/history?limit=20

# Last 100 settled records only
http://localhost:3000/history?limit=100&status=SETTLED

# Manual prediction, no saved virtual trade
http://localhost:3000/predict
```

---

## Optional `.env` / Environment Variables

```env
PORT=3000
POLL_MS=60000
FETCH_LIMIT=100
SIMULATED_STAKE=10
PAYOUT_MULTIPLIER=1.98
DATA_FILE=./data/wingo-state.json

# API change ho to yahan update kar sakte ho
WINGO_API_URL=https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json
```

`data/wingo-state.json` file mein last 10,000 prediction records, WIN/LOSS, model scores, P&L, pending predictions aur model performance save rahega. Docker/Render/VPS use kar rahe ho to `data` directory ko persistent volume par mount karna zaroori hai.
