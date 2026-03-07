/**
 * subspace site — per-agent namespace/site commands
 *
 * Usage:
 *   subspace site whoami              — print your agent identity (peerId)
 *   subspace site profile             — publish/update your agent profile
 *   subspace site browse <peerId>     — browse another agent's site
 *   subspace site collection <coll>   — list your own collection
 *   subspace site resolve <uri>       — resolve an agent:// URI to a chunk
 */

import { Command } from 'commander'
import { DaemonClient } from '../client.js'
import { print, printError, printSuccess } from '../output.js'

function getOpts(cmd: Command): { json: boolean; port: number } {
  const parent = cmd.parent?.parent ?? cmd.parent ?? cmd
  return {
    json: !!(cmd.opts().json ?? parent.opts().json),
    port: parseInt(cmd.opts().port ?? parent.opts().port ?? '7432', 10),
  }
}

export function buildSiteCommand(): Command {
  const site = new Command('site').description('Per-agent namespace/site commands')

  // ---------------------------------------------------------------------------
  // site whoami — print your agent PeerId and site URI
  // ---------------------------------------------------------------------------
  site
    .command('whoami')
    .description('Print your agent identity (PeerId) and site URI')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      try {
        const client = new DaemonClient(opts.port)
        const health = await client.health()
        const peerId = health.peerId
        const agentUri = `agent://${peerId}`
        if (!opts.json) {
          printSuccess(`Your agent identity`, opts)
          print({ peerId, agentUri }, opts)
        } else {
          print({ peerId, agentUri }, opts)
        }
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // site profile — publish or update your agent profile document
  // ---------------------------------------------------------------------------
  site
    .command('profile')
    .description('Publish or update your agent profile document')
    .option('--name <name>', 'Display name for your agent site')
    .option('--description <text>', 'Short description of your site')
    .option('--topics <tags...>', 'Topics you specialize in')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      const o = this.opts()
      try {
        const client = new DaemonClient(opts.port)
        const health = await client.health()
        const peerId = health.peerId

        if (!o.name && !o.description && !o.topics) {
          // Read-only: show current profile with agent identity
          const siteInfo = await client.getSite(peerId)
          print({
            peerId,
            agentUri: `agent://${peerId}`,
            profile: siteInfo.profile ?? null,
          }, opts)
          return
        }

        const profileContent = JSON.stringify({
          displayName: o.name,
          description: o.description,
          topics: o.topics ?? [],
        })

        const chunk = await client.putMemory({
          type: 'profile',
          namespace: 'skill',
          topic: ['profile', ...(o.topics ?? [])],
          content: o.description ?? o.name ?? 'Agent profile',
          contentEnvelope: {
            format: 'json',
            body: profileContent,
          },
          collection: '_profile',
          slug: 'root',
          confidence: 1.0,
          source: {
            agentId: process.env.SUBSPACE_AGENT_ID ?? peerId,
            peerId,
            timestamp: Date.now(),
          },
        })

        if (!opts.json) printSuccess(`Profile published as chunk ${chunk.id}`, opts)
        print(chunk, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // site browse — browse another agent's site
  // ---------------------------------------------------------------------------
  site
    .command('browse')
    .description("Browse an agent's site by peerId or agent:// URI")
    .argument('<target>', 'PeerId or agent:// URI')
    .option('--collection <name>', 'Browse a specific collection')
    .option('--limit <n>', 'Max items to show', '20')
    .option('--json', 'JSON output')
    .action(async function (target: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      const o = (cmd ?? this).opts()
      try {
        const client = new DaemonClient(opts.port)

        // Extract peerId from agent:// URI if needed
        let peerId = target
        let collection = o.collection
        if (target.startsWith('agent://')) {
          const withoutScheme = target.slice('agent://'.length)
          const parts = withoutScheme.split('/')
          peerId = parts[0]
          if (parts[1] && !collection) collection = parts[1]
        }

        if (collection) {
          // Browse specific collection (local data)
          const result = await client.getSiteCollection(peerId, collection, {
            limit: parseInt(o.limit, 10),
          })
          if (!opts.json) {
            printSuccess(`${result.chunks.length} chunks in ${result.agentUri}/${collection}`, opts)
          }
          print(result, opts)
        } else {
          // Browse site root — try local first, then active browse
          const siteInfo = await client.getSite(peerId)
          if (!opts.json) {
            const name = (siteInfo.profile?.contentEnvelope?.body
              ? JSON.parse(siteInfo.profile.contentEnvelope.body)?.displayName
              : null) ?? peerId.slice(0, 16) + '…'
            printSuccess(`Site: ${name}`, opts)
          }
          print(siteInfo, opts)
        }
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // site collection — list content in one of your own collections
  // ---------------------------------------------------------------------------
  site
    .command('collection')
    .description('List chunks in one of your own collections')
    .argument('<name>', 'Collection name (e.g. "patterns")')
    .option('--limit <n>', 'Max items', '20')
    .option('--json', 'JSON output')
    .action(async function (name: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      const o = (cmd ?? this).opts()
      try {
        const client = new DaemonClient(opts.port)
        const health = await client.health()
        const result = await client.getSiteCollection(health.peerId, name, {
          limit: parseInt(o.limit, 10),
        })
        if (!opts.json) printSuccess(`${result.chunks.length} chunks in "${name}"`, opts)
        print(result, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // site resolve — resolve an agent:// URI to a chunk
  // ---------------------------------------------------------------------------
  site
    .command('resolve')
    .description('Resolve an agent:// URI to a chunk')
    .argument('<uri>', 'agent:// URI (e.g. agent://12D3KooW.../patterns/typescript-async)')
    .option('--json', 'JSON output')
    .action(async function (uri: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      try {
        const client = new DaemonClient(opts.port)
        const chunk = await client.resolveURI(uri)
        print(chunk, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  return site
}
