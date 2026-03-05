/**
 * CLI output formatter — human-readable or structured JSON.
 *
 * All commands pass opts.json through from the --json flag.
 * Agents always use --json for programmatic parsing.
 */

import { AgentNetError } from '@subspace/core'

export interface OutputOptions {
  json: boolean
}

// ANSI colour codes (no external dep)
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

function useColor(): boolean {
  return process.stdout.isTTY && process.env.NO_COLOR === undefined
}

function color(code: string, str: string): string {
  return useColor() ? `${code}${str}${RESET}` : str
}

/**
 * Print a value to stdout.
 * --json: pretty-printed JSON
 * default: formatted human-readable output
 */
export function print(data: unknown, opts: OutputOptions): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
    return
  }
  printHuman(data)
}

function printHuman(data: unknown): void {
  if (data === null || data === undefined) {
    console.log(color(DIM, '(empty)'))
    return
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log(color(DIM, 'No results.'))
      return
    }
    for (const item of data) {
      printHuman(item)
      console.log(color(DIM, '─'.repeat(60)))
    }
    return
  }

  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>

    // Pretty-print MemoryChunk
    if ('id' in obj && 'content' in obj && 'type' in obj) {
      console.log(color(BOLD, `[${obj.type}] ${obj.id}`))
      if (obj.topic) console.log(`  ${color(CYAN, 'topics:')} ${(obj.topic as string[]).join(', ')}`)
      if (obj.namespace) console.log(`  ${color(CYAN, 'namespace:')} ${obj.namespace}`)
      if (obj.confidence !== undefined) console.log(`  ${color(CYAN, 'confidence:')} ${obj.confidence}`)
      if (obj.source) {
        const src = obj.source as Record<string, unknown>
        console.log(`  ${color(CYAN, 'agent:')} ${src.agentId}`)
        if (src.project) console.log(`  ${color(CYAN, 'project:')} ${src.project}`)
        console.log(`  ${color(CYAN, 'at:')} ${new Date(src.timestamp as number).toISOString()}`)
      }
      if (obj.supersedes) console.log(`  ${color(DIM, `supersedes: ${obj.supersedes}`)}`)
      console.log(`  ${color(CYAN, 'content:')}`)
      const lines = String(obj.content).split('\n')
      for (const line of lines) {
        console.log(`    ${line}`)
      }
      return
    }

    // Pretty-print NetworkInfoDTO
    if ('id' in obj && 'peerId' in obj && 'peers' in obj) {
      console.log(color(BOLD, `network: ${obj.id}`))
      if (obj.name) console.log(`  name:   ${obj.name}`)
      console.log(`  peerId: ${obj.peerId}`)
      console.log(`  peers:  ${obj.peers}`)
      return
    }

    // Pretty-print health response
    if ('status' in obj && 'uptime' in obj) {
      const statusColor = obj.status === 'ok' ? GREEN : RED
      console.log(`${color(BOLD, 'daemon:')} ${color(statusColor, String(obj.status))}`)
      console.log(`  peerId:  ${obj.peerId}`)
      console.log(`  uptime:  ${obj.uptime}s`)
      console.log(`  version: ${obj.version}`)
      const nets = (obj.networks as unknown[]) ?? []
      console.log(`  networks: ${nets.length}`)
      for (const net of nets) {
        const n = net as Record<string, unknown>
        console.log(`    - ${n.id} (${n.peers} peers)`)
      }
      return
    }

    // Generic key-value
    for (const [k, v] of Object.entries(obj)) {
      console.log(`  ${color(CYAN, k + ':')} ${JSON.stringify(v)}`)
    }
    return
  }

  console.log(String(data))
}

/**
 * Print an error and exit with code 1.
 * --json: { error: string, code: string } to stdout
 * default: coloured error message to stderr
 */
export function printError(err: unknown, opts: OutputOptions): never {
  if (opts.json) {
    const code = err instanceof AgentNetError ? err.code : 'UNKNOWN_ERROR'
    const message = err instanceof Error ? err.message : String(err)
    process.stdout.write(JSON.stringify({ error: message, code }, null, 2) + '\n')
  } else {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(color(RED, `✗ Error: ${message}`) + '\n')
  }
  process.exit(1)
}

/**
 * Print a success message (non-JSON only).
 */
export function printSuccess(msg: string, opts: OutputOptions): void {
  if (!opts.json) {
    console.log(color(GREEN, `✓ ${msg}`))
  }
}
