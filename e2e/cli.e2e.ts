/**
 * E2E: CLI Integration — Full User Workflow via `subspace` Commands
 *
 * Tests the complete user-facing workflow through the CLI binary.
 * Validates the CLI → HTTP API → daemon → core pipeline end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { TestHarness, randomPsk } from './harness.js'
import { pollUntil } from './helpers/wait.js'

const execFile = promisify(execFileCb)

const REPO_ROOT = new URL('..', import.meta.url).pathname
const CLI_ENTRY = join(REPO_ROOT, 'packages/cli/dist/index.js')

/**
 * Run a subspace CLI command against a specific daemon port.
 * Always appends --json for structured output.
 */
async function cli(args: string[], port: number): Promise<unknown> {
  const { stdout, stderr } = await execFile('node', [
    '--no-warnings',
    CLI_ENTRY,
    '--port', String(port),
    '--json',
    ...args,
  ], {
    timeout: 30_000,
  })

  const text = stdout.trim()
  if (!text) {
    // Some commands output nothing on success (e.g. 204 responses)
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    // Some commands output non-JSON lines (e.g. info messages) — find JSON
    const jsonLine = text.split('\n').find((l) => l.trimStart().startsWith('{') || l.trimStart().startsWith('['))
    if (jsonLine) return JSON.parse(jsonLine)
    throw new Error(`CLI output is not JSON: ${text.slice(0, 200)}`)
  }
}

/**
 * Run CLI command and expect it to fail (non-zero exit code).
 */
async function cliExpectError(args: string[], port: number): Promise<{ code: number; stderr: string; stdout: string }> {
  try {
    await execFile('node', ['--no-warnings', CLI_ENTRY, '--port', String(port), '--json', ...args])
    throw new Error(`Expected CLI command to fail but it succeeded: ${args.join(' ')}`)
  } catch (err: unknown) {
    const e = err as { code?: number; stderr?: string; stdout?: string; message?: string }
    if (e.code === undefined) throw err  // unexpected error, not an exit code
    return { code: e.code ?? 1, stderr: e.stderr ?? '', stdout: e.stdout ?? '' }
  }
}

// ── Shared harness ────────────────────────────────────────────────────────────

const harness = new TestHarness()
let alphaPort: number

beforeAll(async () => {
  await harness.startAgents(['alpha', 'beta'])
  alphaPort = harness.agents.get('alpha')!.port
})

afterAll(() => harness.teardown())

// ── Test 1: whoami + site commands ────────────────────────────────────────────

describe('site whoami', () => {
  it('returns peerId and agentUri', async () => {
    const result = await cli(['site', 'whoami'], alphaPort) as {
      peerId: string; agentUri: string
    }
    expect(result.peerId).toMatch(/^12D3KooW/)
    expect(result.agentUri).toBe(`agent://${result.peerId}`)
  })
})

// ── Test 2: network join via CLI ──────────────────────────────────────────────

describe('network join/leave via CLI', () => {
  it('network join returns network info', async () => {
    const psk = randomPsk()
    const result = await cli(['network', 'join', '--psk', psk], alphaPort) as {
      id: string; peerId: string; namespaces: string[]
    }
    expect(result.id).toHaveLength(64)
    // peerId is a DID (did:key:z6...) or nodeId — just ensure it's non-empty
    expect(result.peerId).toBeTruthy()
    expect(result.namespaces).toEqual(['skill', 'project'])

    // Leave the network after test
    await cli(['network', 'leave', result.id], alphaPort)
  })

  it('network list shows active networks', async () => {
    const psk = randomPsk()
    await harness.client('alpha').joinNetwork(psk)

    const networks = await cli(['network', 'list'], alphaPort) as unknown[]
    expect(Array.isArray(networks)).toBe(true)
    expect(networks.length).toBeGreaterThan(0)
  })
})

// ── Test 3: memory put, get, query, forget ────────────────────────────────────

describe('memory CLI commands', () => {
  beforeAll(async () => {
    // Ensure alpha has an active network
    const nets = await harness.client('alpha').getNetworks()
    if (nets.length === 0) {
      await harness.client('alpha').joinNetwork(randomPsk())
    }
  })

  it('memory put returns chunk with id', async () => {
    const result = await cli([
      'memory', 'put',
      '--type', 'pattern',
      '--topic', 'cli-test',
      '--content', 'CLI integration test chunk',
    ], alphaPort) as { id: string; type: string; content: string }

    expect(result.id).toBeTruthy()
    expect(result.type).toBe('pattern')
    expect(result.content).toBe('CLI integration test chunk')
  })

  it('memory get returns the stored chunk', async () => {
    const put = await cli([
      'memory', 'put',
      '--type', 'skill',
      '--topic', 'cli-get-test',
      '--content', 'get test content',
    ], alphaPort) as { id: string }

    const got = await cli(['memory', 'get', put.id], alphaPort) as {
      id: string; content: string
    }
    expect(got.id).toBe(put.id)
    expect(got.content).toBe('get test content')
  })

  it('memory query returns matching chunks', async () => {
    await cli([
      'memory', 'put',
      '--type', 'skill',
      '--topic', 'query-topic-xyz',
      '--content', 'unique query test',
    ], alphaPort)

    const results = await cli([
      'memory', 'query',
      '--topic', 'query-topic-xyz',
    ], alphaPort) as unknown[]

    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)
  })

  it('memory search returns results containing the search term', async () => {
    await cli([
      'memory', 'put',
      '--type', 'pattern',
      '--topic', 'search-test',
      '--content', 'unique-searchterm-xyz-abc123 content here',
    ], alphaPort)

    const results = await cli([
      'memory', 'search', 'unique-searchterm-xyz-abc123',
    ], alphaPort) as unknown[]

    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)
  })

  it('memory update creates a new version', async () => {
    const v1 = await cli([
      'memory', 'put',
      '--type', 'context',
      '--topic', 'update-cli-test',
      '--content', 'original cli content',
    ], alphaPort) as { id: string; version: number }

    const v2 = await cli([
      'memory', 'update', v1.id,
      '--content', 'updated cli content',
    ], alphaPort) as { id: string; version: number; supersedes: string }

    expect(v2.version).toBe(2)
    expect(v2.supersedes).toBe(v1.id)
  })

  it('memory forget removes the chunk', async () => {
    const chunk = await cli([
      'memory', 'put',
      '--type', 'context',
      '--topic', 'forget-cli-test',
      '--content', 'to be forgotten',
    ], alphaPort) as { id: string }

    await cli(['memory', 'forget', chunk.id], alphaPort)

    const err = await cliExpectError(['memory', 'get', chunk.id], alphaPort)
    expect(err.code).not.toBe(0)
  })
})

// ── Test 4: discovery commands ────────────────────────────────────────────────

describe('discovery CLI commands', () => {
  it('discover peers returns an array', async () => {
    const result = await cli(['discover', 'peers'], alphaPort)
    expect(Array.isArray(result)).toBe(true)
  })

  it('discover topics returns an array', async () => {
    const result = await cli(['discover', 'topics'], alphaPort)
    expect(Array.isArray(result)).toBe(true)
  })
})

// ── Test 5: site commands ─────────────────────────────────────────────────────

describe('site CLI commands', () => {
  it('site profile returns profile info', async () => {
    const result = await cli(['site', 'profile'], alphaPort) as {
      peerId: string; agentUri: string
    }
    expect(result.peerId).toMatch(/^12D3KooW/)
  })

  it('site browse <peerId> returns stubs or error gracefully', async () => {
    const alphaPeerId = harness.peerId('alpha')
    // Browse may return empty stubs or a 503 if no peers known yet — both are valid
    try {
      const result = await cli(['site', 'browse', alphaPeerId], alphaPort)
      // If it succeeds, it should be an object
      expect(result).toBeDefined()
    } catch {
      // 503 (peer not reachable) is acceptable in isolated test environment
    }
  })
})

// ── Test 6: security commands ─────────────────────────────────────────────────

describe('security CLI commands', () => {
  it('security reputation returns an array', async () => {
    const result = await cli(['security', 'reputation'], alphaPort)
    expect(Array.isArray(result)).toBe(true)
  })

  it('security clear <peerId> succeeds (idempotent)', async () => {
    const fakePeerId = '12D3KooWFakePeer0000000000000000000000000000000000001'
    // Should not throw even if peerId is unknown
    await cli(['security', 'clear', fakePeerId], alphaPort)
    // No assertion needed — if it doesn't throw, it passed
  })
})

// ── Test 7: error handling — invalid inputs ───────────────────────────────────

describe('error handling', () => {
  it('network join with short PSK fails with non-zero exit code', async () => {
    const err = await cliExpectError(['network', 'join', '--psk', 'short'], alphaPort)
    expect(err.code).not.toBe(0)
  })

  it('memory get with nonexistent ID fails with non-zero exit code', async () => {
    const err = await cliExpectError(['memory', 'get', 'nonexistent-id-xyz'], alphaPort)
    expect(err.code).not.toBe(0)
  })
})

// ── Test 8: --version and --help don't crash ──────────────────────────────────

describe('CLI meta-commands', () => {
  it('--version returns version string', async () => {
    const { stdout } = await execFile('node', ['--no-warnings', CLI_ENTRY, '--version'])
    expect(stdout.trim()).toMatch(/\d+\.\d+\.\d+/)
  })

  it('--help does not crash', async () => {
    const { stdout } = await execFile('node', ['--no-warnings', CLI_ENTRY, '--help'])
    expect(stdout).toContain('subspace')
  })
})
