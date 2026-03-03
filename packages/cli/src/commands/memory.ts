import { Command } from 'commander'
import { DaemonClient } from '../client.js'
import { print, printError, printSuccess } from '../output.js'
import type { MemoryType, MemoryNamespace } from '@agent-net/core'

function getOpts(cmd: Command): { json: boolean; port: number } {
  const parent = cmd.parent?.parent ?? cmd.parent ?? cmd
  return {
    json: !!(cmd.opts().json ?? parent.opts().json),
    port: parseInt(cmd.opts().port ?? parent.opts().port ?? '7432', 10),
  }
}

export function buildMemoryCommand(): Command {
  const memory = new Command('memory').description('Read and write agent memory')

  // ---------------------------------------------------------------------------
  // memory put
  // ---------------------------------------------------------------------------
  memory
    .command('put')
    .description('Store a new memory chunk')
    .requiredOption('--type <type>', 'Memory type: skill|project|context|pattern|result')
    .requiredOption('--topic <tags...>', 'Semantic tags (space-separated)')
    .requiredOption('--content <text>', 'Memory content')
    .option('--namespace <ns>', 'Namespace: skill|project (default: project)', 'project')
    .option('--project <slug>', 'Project slug (for project-namespace chunks)')
    .option('--confidence <n>', 'Confidence 0.0–1.0 (default: 0.8)', '0.8')
    .option('--ttl <seconds>', 'Time-to-live in seconds')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      const o = this.opts()
      try {
        const client = new DaemonClient(opts.port)
        const chunk = await client.putMemory({
          type: o.type as MemoryType,
          namespace: o.namespace as MemoryNamespace,
          topic: Array.isArray(o.topic) ? o.topic : [o.topic],
          content: o.content,
          confidence: parseFloat(o.confidence),
          ttl: o.ttl ? Date.now() + parseInt(o.ttl, 10) * 1000 : undefined,
          source: {
            agentId: process.env.AGENT_NET_AGENT_ID ?? 'unknown',
            peerId: '', // daemon fills this from session.node.peerId (empty string triggers fallback)
            project: o.project,
            timestamp: Date.now(),
          },
        })
        if (!opts.json) printSuccess(`Stored chunk ${chunk.id}`, opts)
        print(chunk, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // memory get
  // ---------------------------------------------------------------------------
  memory
    .command('get')
    .description('Retrieve a memory chunk by ID')
    .argument('<id>', 'Chunk UUID')
    .option('--json', 'JSON output')
    .action(async function (id: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      try {
        const client = new DaemonClient(opts.port)
        const chunk = await client.getMemory(id)
        print(chunk, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // memory query
  // ---------------------------------------------------------------------------
  memory
    .command('query')
    .description('Query memory chunks (local by default)')
    .option('--topic <tags...>', 'Filter by semantic tags')
    .option('--type <type>', 'Filter by type: skill|project|context|pattern|result')
    .option('--namespace <ns>', 'Filter by namespace: skill|project')
    .option('--project <slug>', 'Filter by project slug')
    .option('--min-confidence <n>', 'Minimum confidence threshold')
    .option('--local', 'Query local store only (default, sub-10ms)', true)
    .option('--network', 'Broadcast query to all peers in network')
    .option('--limit <n>', 'Maximum results to return')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      const o = this.opts()
      try {
        const client = new DaemonClient(opts.port)
        const q = {
          topics: o.topic ? (Array.isArray(o.topic) ? o.topic : [o.topic]) : undefined,
          type: o.type as MemoryType | undefined,
          namespace: o.namespace as MemoryNamespace | undefined,
          project: o.project,
          minConfidence: o.minConfidence ? parseFloat(o.minConfidence) : undefined,
          limit: o.limit ? parseInt(o.limit, 10) : undefined,
        }
        const chunks = o.network
          ? await client.searchMemory('', q)
          : await client.queryMemory(q)
        print(chunks, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // memory search (freetext content search)
  // ---------------------------------------------------------------------------
  memory
    .command('search')
    .description('Freetext search on memory content (substring match)')
    .argument('<freetext>', 'Text to search for in content field')
    .option('--local', 'Local only', true)
    .option('--network', 'Also query network peers')
    .option('--json', 'JSON output')
    .action(async function (freetext: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      try {
        const client = new DaemonClient(opts.port)
        const results = await client.searchMemory(freetext)
        print(results, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // memory forget
  // ---------------------------------------------------------------------------
  memory
    .command('forget')
    .description('Tombstone (delete) a memory chunk')
    .argument('<id>', 'Chunk UUID')
    .option('--json', 'JSON output')
    .action(async function (id: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      try {
        const client = new DaemonClient(opts.port)
        await client.forgetMemory(id)
        if (opts.json) {
          print({ forgotten: true, id }, opts)
        } else {
          printSuccess(`Chunk ${id} tombstoned.`, opts)
        }
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // memory update
  // ---------------------------------------------------------------------------
  memory
    .command('update')
    .description('Update a chunk (creates a new supersedes chain entry)')
    .argument('<id>', 'ID of the chunk to update')
    .requiredOption('--content <text>', 'New content')
    .option('--confidence <n>', 'New confidence 0.0–1.0')
    .option('--json', 'JSON output')
    .action(async function (id: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      try {
        const client = new DaemonClient(opts.port)
        const o = (cmd ?? this).opts()
        const updated = await client.updateMemory(
          id,
          o.content,
          o.confidence ? parseFloat(o.confidence) : undefined
        )
        if (!opts.json) printSuccess(`Updated — new chunk: ${updated.id}`, opts)
        print(updated, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  return memory
}
