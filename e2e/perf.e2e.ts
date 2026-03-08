/**
 * E2E: Multi-Agent Scale & Performance Benchmarks
 *
 * Lightweight benchmarks to catch latency/throughput regressions.
 * These are NOT load tests — thresholds are generous enough to pass on a
 * mid-range consumer laptop while still catching 2x+ regressions.
 *
 * Run with: npm run test:e2e:perf
 *
 * Results are logged as structured JSON and optionally compared against saved baselines:
 *   PERF_BASELINE=save   → write results to e2e/perf-baselines.json
 *   PERF_BASELINE=compare → compare against saved baselines and warn on regressions
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { TestHarness, randomPsk, percentile } from './harness.js'
import { pollUntil, sleep } from './helpers/wait.js'

const REPO_ROOT = new URL('..', import.meta.url).pathname
const BASELINES_PATH = join(REPO_ROOT, 'e2e/perf-baselines.json')
const PERF_BASELINE_MODE = process.env.PERF_BASELINE as 'save' | 'compare' | undefined

interface PerfResult {
  test: string
  p50: number
  p95: number
  p99?: number
  unit: string
  timestamp: number
  samples: number
}

const perfResults: PerfResult[] = []

function recordResult(result: Omit<PerfResult, 'timestamp'>) {
  const entry = { ...result, timestamp: Date.now() }
  perfResults.push(entry)
  // eslint-disable-next-line no-console
  console.log('[perf]', JSON.stringify(entry))
}

function computeStats(latencies: number[]): { p50: number; p95: number; p99: number } {
  const sorted = [...latencies].sort((a, b) => a - b)
  const p = (pct: number) => sorted[Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1)]
  return { p50: p(50), p95: p(95), p99: p(99) }
}

// Save/compare baseline results after all tests run
process.on('exit', () => {
  if (PERF_BASELINE_MODE === 'save') {
    writeFileSync(BASELINES_PATH, JSON.stringify(perfResults, null, 2))
    console.log(`[perf] Saved ${perfResults.length} baseline(s) to ${BASELINES_PATH}`)
  } else if (PERF_BASELINE_MODE === 'compare' && existsSync(BASELINES_PATH)) {
    const baselines: PerfResult[] = JSON.parse(readFileSync(BASELINES_PATH, 'utf8'))
    const regressions: string[] = []
    for (const result of perfResults) {
      const baseline = baselines.find((b) => b.test === result.test)
      if (!baseline) continue
      const p50Regression = result.p50 > baseline.p50 * 2
      const p95Regression = result.p95 > baseline.p95 * 2
      if (p50Regression || p95Regression) {
        regressions.push(
          `${result.test}: p50 ${baseline.p50}→${result.p50}ms, p95 ${baseline.p95}→${result.p95}ms`
        )
      }
    }
    if (regressions.length > 0) {
      console.warn('[perf] REGRESSIONS DETECTED (>2x baseline):\n' + regressions.join('\n'))
    }
  }
})

// ── Test 1: memory write latency ──────────────────────────────────────────────

describe('memory write latency', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    await harness.joinAllToPsk()
  })
  afterAll(() => harness.teardown())

  it('p50 < 200ms, p95 < 500ms for sequential writes', async () => {
    const SAMPLES = 50 // Reduced from 100 to keep test fast
    const latencies: number[] = []

    for (let i = 0; i < SAMPLES; i++) {
      const start = Date.now()
      await harness.client('alpha').putMemory({
        type: 'context',
        topic: ['perf-write'],
        content: `Perf write test chunk ${i} — ${Date.now()}`,
        confidence: 0.5,
      })
      latencies.push(Date.now() - start)
    }

    const { p50, p95, p99 } = computeStats(latencies)
    recordResult({ test: 'write-latency', p50, p95, p99, unit: 'ms', samples: SAMPLES })

    // Generous thresholds — catch only severe regressions
    expect(p50).toBeLessThan(200)
    expect(p95).toBeLessThan(500)
  })
})

// ── Test 2: memory query latency (local) ──────────────────────────────────────

describe('memory query latency (local)', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    await harness.joinAllToPsk()

    // Pre-populate with 100 chunks across 5 topics
    const topics = ['ts', 'auth', 'api', 'db', 'cache']
    for (let i = 0; i < 100; i++) {
      await harness.client('alpha').putMemory({
        type: 'skill',
        topic: [topics[i % topics.length]],
        content: `Query perf chunk ${i}`,
        confidence: 0.8,
      })
    }
  })
  afterAll(() => harness.teardown())

  it('p50 < 50ms, p95 < 200ms for local topic queries', async () => {
    const SAMPLES = 30
    const latencies: number[] = []

    for (let i = 0; i < SAMPLES; i++) {
      const topic = ['ts', 'auth', 'api', 'db', 'cache'][i % 5]
      const start = Date.now()
      await harness.client('alpha').queryMemory({ topics: [topic] })
      latencies.push(Date.now() - start)
    }

    const { p50, p95 } = computeStats(latencies)
    recordResult({ test: 'query-latency-local', p50, p95, unit: 'ms', samples: SAMPLES })

    expect(p50).toBeLessThan(50)
    expect(p95).toBeLessThan(200)
  })
})

// ── Test 3: cross-peer network query latency ──────────────────────────────────

describe('cross-peer network query latency', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha', 'beta'])
    await harness.joinAllToPsk()

    // Alpha has 50 chunks for Beta to query
    for (let i = 0; i < 50; i++) {
      await harness.client('alpha').putMemory({
        type: 'skill',
        topic: ['network-query-perf'],
        content: `Network query perf chunk ${i}`,
        confidence: 0.8,
      })
    }
  })
  afterAll(() => harness.teardown())

  it('p50 < 500ms, p95 < 2000ms for cross-peer searches', async () => {
    const SAMPLES = 10
    const latencies: number[] = []

    for (let i = 0; i < SAMPLES; i++) {
      const start = Date.now()
      await harness.client('beta').searchMemory('Network query perf chunk')
      latencies.push(Date.now() - start)
    }

    const { p50, p95 } = computeStats(latencies)
    recordResult({ test: 'query-latency-network', p50, p95, unit: 'ms', samples: SAMPLES })

    // P2P round-trips are slow — generous thresholds
    expect(p50).toBeLessThan(500)
    expect(p95).toBeLessThan(2000)
  })
})

// ── Test 4: mesh formation time ───────────────────────────────────────────────

describe('engine startup time', () => {
  it('3 agents start with Iroh engine in < 30s', async () => {
    const harness = new TestHarness()
    const start = Date.now()

    await harness.startAgents(['a', 'b', 'c'])
    await harness.waitForMesh(1, 30_000)

    const formationTimeMs = Date.now() - start
    recordResult({
      test: 'engine-startup-3-agents',
      p50: formationTimeMs,
      p95: formationTimeMs,
      unit: 'ms',
      samples: 1,
    })

    // eslint-disable-next-line no-console
    console.log(`[perf] Engine startup time (3 agents): ${formationTimeMs}ms`)
    expect(formationTimeMs).toBeLessThan(30_000)

    await harness.teardown()
  })
})

// ── Test 5: startup time ──────────────────────────────────────────────────────

describe('daemon startup time', () => {
  it('cold start < 15s (fresh dataDir)', async () => {
    const harness = new TestHarness()
    const start = Date.now()
    await harness.startAgents(['alpha'])  // startAgents waits for healthy
    const coldStartMs = Date.now() - start

    recordResult({
      test: 'cold-start',
      p50: coldStartMs,
      p95: coldStartMs,
      unit: 'ms',
      samples: 1,
    })

    // eslint-disable-next-line no-console
    console.log(`[perf] Cold start time: ${coldStartMs}ms`)
    expect(coldStartMs).toBeLessThan(15_000)

    await harness.teardown()
  })

  it('warm start (existing dataDir with data) < 20s', async () => {
    const harness = new TestHarness()
    await harness.startAgents(['alpha'])

    // Write some data to populate the store
    const psk = randomPsk()
    await harness.client('alpha').joinNetwork(psk)
    for (let i = 0; i < 20; i++) {
      await harness.client('alpha').putMemory({
        type: 'skill',
        topic: ['warm-start-perf'],
        content: `chunk ${i}`,
        confidence: 0.8,
      })
    }
    await harness.stopAgent('alpha', 'SIGTERM')

    // Warm restart
    const start = Date.now()
    await harness.restartAgent('alpha')
    const warmStartMs = Date.now() - start

    recordResult({
      test: 'warm-start',
      p50: warmStartMs,
      p95: warmStartMs,
      unit: 'ms',
      samples: 1,
    })

    // eslint-disable-next-line no-console
    console.log(`[perf] Warm start time: ${warmStartMs}ms`)
    expect(warmStartMs).toBeLessThan(20_000)

    await harness.teardown()
  })
})

// ── Test 6: search freetext throughput ────────────────────────────────────────

describe('freetext search throughput', () => {
  const harness = new TestHarness()
  beforeAll(async () => {
    await harness.startAgents(['alpha'])
    await harness.joinAllToPsk()

    // Write 50 chunks for search to scan
    for (let i = 0; i < 50; i++) {
      await harness.client('alpha').putMemory({
        type: 'pattern',
        topic: ['search-throughput'],
        content: `Search throughput test content item ${i} with unique phrase orange-banana`,
        confidence: 0.7,
      })
    }
  })
  afterAll(() => harness.teardown())

  it('20 sequential freetext searches complete with p95 < 300ms', async () => {
    const SAMPLES = 20
    const latencies: number[] = []

    for (let i = 0; i < SAMPLES; i++) {
      const start = Date.now()
      const results = await harness.client('alpha').searchMemory('orange-banana')
      latencies.push(Date.now() - start)
      expect(results.length).toBeGreaterThan(0)
    }

    const { p50, p95 } = computeStats(latencies)
    recordResult({ test: 'search-throughput', p50, p95, unit: 'ms', samples: SAMPLES })

    expect(p50).toBeLessThan(100)
    expect(p95).toBeLessThan(300)
  })
})
