import { readFile } from 'node:fs/promises'
import { Command } from 'commander'
import { DaemonClient } from '../client.js'
import { print, printError, printSuccess } from '../output.js'
import type { MemoryType, MemoryNamespace, ContentFormat, ContentLink } from '@agent-net/core'

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
    .requiredOption('--type <type>', 'Memory type: skill|project|context|pattern|result|document|schema|thread|blob-manifest|profile')
    .requiredOption('--topic <tags...>', 'Semantic tags (space-separated)')
    .option('--content <text>', 'Memory content (plain text summary)')
    .option('--file <path>', 'Read content from a file (sets format automatically if --format is given)')
    .option('--format <fmt>', 'Content format: text|markdown|json|code|thread|table|composite')
    .option('--language <lang>', 'Code language hint (used with --format code)')
    .option('--namespace <ns>', 'Namespace: skill|project (default: project)', 'project')
    .option('--project <slug>', 'Project slug (for project-namespace chunks)')
    .option('--collection <name>', 'Collection name within this agent\'s site (e.g. "patterns")')
    .option('--slug <slug>', 'Human-readable slug within collection (e.g. "typescript-async")')
    .option('--confidence <n>', 'Confidence 0.0–1.0 (default: 0.8)', '0.8')
    .option('--ttl <seconds>', 'Time-to-live in seconds')
    .option('--link <target>', 'Add a link: <target>:<rel>[:<label>] (repeatable)', collect, [])
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      const o = this.opts()
      try {
        const client = new DaemonClient(opts.port)

        // Read content: --file overrides --content
        let content: string = o.content ?? ''
        let envelopeBody = content
        if (o.file) {
          envelopeBody = await readFile(o.file, 'utf8')
          // Summary = first 200 chars of file content
          if (!o.content) content = envelopeBody.slice(0, 200)
        }

        // Build content envelope if format is specified
        const contentEnvelope = o.format ? {
          format: o.format as ContentFormat,
          body: envelopeBody,
          metadata: o.language ? { language: o.language } : undefined,
        } : undefined

        if (!content && !contentEnvelope) {
          throw new Error('Either --content or --file is required')
        }

        // Parse links: "target:rel" or "target:rel:label"
        const links: ContentLink[] = (o.link as string[]).map((raw: string) => {
          const parts = raw.split(':')
          if (parts.length < 2) throw new Error(`Invalid link format "${raw}" — expected target:rel[:label]`)
          const [target, rel, ...rest] = parts
          return { target, rel, label: rest.join(':') || undefined }
        })

        const chunk = await client.putMemory({
          type: o.type as MemoryType,
          namespace: o.namespace as MemoryNamespace,
          topic: Array.isArray(o.topic) ? o.topic : [o.topic],
          content: content || envelopeBody.slice(0, 200),
          contentEnvelope,
          confidence: parseFloat(o.confidence),
          ttl: o.ttl ? Date.now() + parseInt(o.ttl, 10) * 1000 : undefined,
          collection: o.collection,
          slug: o.slug,
          links: links.length > 0 ? links : undefined,
          source: {
            agentId: process.env.AGENT_NET_AGENT_ID ?? 'unknown',
            peerId: '',
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
    .argument('<id>', 'Chunk UUID or agent:// URI')
    .option('--json', 'JSON output')
    .action(async function (idOrUri: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      try {
        const client = new DaemonClient(opts.port)
        const chunk = idOrUri.startsWith('agent://')
          ? await client.resolveURI(idOrUri)
          : await client.getMemory(idOrUri)
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
    .option('--type <type>', 'Filter by type')
    .option('--namespace <ns>', 'Filter by namespace: skill|project')
    .option('--project <slug>', 'Filter by project slug')
    .option('--peer <peerId>', 'Filter by publishing agent (namespace query)')
    .option('--collection <name>', 'Filter by collection name')
    .option('--format <fmt>', 'Filter by content format')
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
          peerId: o.peer,
          collection: o.collection,
          contentFormat: o.format as ContentFormat | undefined,
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
  // memory search
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

  // ---------------------------------------------------------------------------
  // memory links — show outgoing links from a chunk
  // ---------------------------------------------------------------------------
  memory
    .command('links')
    .description('Show outgoing links from a memory chunk')
    .argument('<id>', 'Chunk UUID')
    .option('--json', 'JSON output')
    .action(async function (id: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      try {
        const client = new DaemonClient(opts.port)
        const result = await client.getLinks(id)
        print(result, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // memory backlinks — show what links TO a chunk
  // ---------------------------------------------------------------------------
  memory
    .command('backlinks')
    .description('Show chunks that link TO this chunk')
    .argument('<id>', 'Chunk UUID')
    .option('--json', 'JSON output')
    .action(async function (id: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      try {
        const client = new DaemonClient(opts.port)
        const result = await client.getBacklinks(id)
        print(result, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // memory graph — traverse the content link graph
  // ---------------------------------------------------------------------------
  memory
    .command('graph')
    .description('Traverse the content link graph from a starting chunk')
    .argument('<id>', 'Starting chunk UUID')
    .option('--rel <rels...>', 'Filter by link relationship type(s)')
    .option('--depth <n>', 'Maximum hops (default: 3, max: 5)', '3')
    .option('--json', 'JSON output')
    .action(async function (id: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      try {
        const o = (cmd ?? this).opts()
        const client = new DaemonClient(opts.port)
        const result = await client.traverseGraph(
          id,
          o.rel,
          parseInt(o.depth, 10)
        )
        if (!opts.json) {
          printSuccess(`Graph: ${result.nodes.length} nodes, ${result.edges.length} edges`, opts)
        }
        print(result, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  return memory
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect repeated options into an array. */
function collect(val: string, prev: string[]): string[] {
  return prev.concat([val])
}
