/**
 * subspace discover — network discovery and browsing commands
 *
 * Usage:
 *   subspace discover peers              — list known peers from discovery manifests
 *   subspace discover topics             — show topics across the network
 *   subspace discover check <peerId>     — does a peer have content about a topic?
 *   subspace browse <peerId>             — actively browse a peer's site
 *   subspace subscribe --topic <t>       — subscribe to auto-fetch for a topic
 *   subspace security reputation         — show peer reputation scores
 *   subspace security clear <peerId>     — clear a peer's blacklist
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

// ---------------------------------------------------------------------------
// discover — passive network discovery
// ---------------------------------------------------------------------------

export function buildDiscoverCommand(): Command {
  const discover = new Command('discover').description('Discover content and peers on the network')

  discover
    .command('peers')
    .description('List known peers from discovery manifests (passive, zero network cost)')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      try {
        const client = new DaemonClient(opts.port)
        const peers = await client.getDiscoveryPeers()
        if (!opts.json) {
          if (peers.length === 0) {
            printSuccess('No peers discovered yet. Manifests arrive within ~60s of connecting.', opts)
          } else {
            printSuccess(`${peers.length} peer(s) discovered:`, opts)
          }
        }
        print(peers, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  discover
    .command('topics')
    .description('Show all topics seen across the network (from discovery bloom filters)')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      try {
        const client = new DaemonClient(opts.port)
        const topics = await client.getDiscoveryTopics()
        if (!opts.json) printSuccess(`${topics.length} topics on the network:`, opts)
        print(topics, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  discover
    .command('check')
    .description('Check if a peer probably has content about a topic (bloom filter, zero network cost)')
    .argument('<peerId>', 'PeerId of the target peer')
    .requiredOption('--topic <topic>', 'Topic to check')
    .option('--json', 'JSON output')
    .action(async function (peerId: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      const o = (cmd ?? this).opts()
      try {
        const client = new DaemonClient(opts.port)
        const result = await client.checkTopicOnPeer(peerId, o.topic)
        if (!opts.json) {
          if (result.probably === null) {
            printSuccess(`Peer ${peerId.slice(0, 16)}… is unknown (no discovery manifest received yet)`, opts)
          } else {
            const verdict = result.probably ? '✓ PROBABLY has' : '✗ PROBABLY does NOT have'
            printSuccess(`${verdict} content about "${o.topic}"`, opts)
          }
        }
        print(result, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  return discover
}

// ---------------------------------------------------------------------------
// browse — active peer browse
// ---------------------------------------------------------------------------

export function buildBrowseCommand(): Command {
  const browse = new Command('browse')
    .description('Actively browse a remote peer\'s site (fetches metadata from the peer)')
    .argument('<peerId>', 'PeerId or agent:// URI of the peer to browse')
    .option('--collection <name>', 'Browse a specific collection')
    .option('--limit <n>', 'Max items to return', '20')
    .option('--json', 'JSON output')
    .action(async function (target: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      const o = (cmd ?? this).opts()
      try {
        const client = new DaemonClient(opts.port)

        let peerId = target
        let collection = o.collection
        if (target.startsWith('agent://')) {
          const withoutScheme = target.slice('agent://'.length)
          const parts = withoutScheme.split('/')
          peerId = parts[0]
          if (parts[1] && !collection) collection = parts[1]
        }

        const result = await client.browse(peerId, {
          collection,
          limit: parseInt(o.limit, 10),
        })

        if (!opts.json) {
          printSuccess(
            `${result.stubs.length} chunk(s) from ${peerId.slice(0, 16)}…` +
            (result.hasMore ? ' (more available)' : ''),
            opts
          )
        }
        print(result, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  return browse
}

// ---------------------------------------------------------------------------
// security — reputation and peer management
// ---------------------------------------------------------------------------

export function buildSecurityCommand(): Command {
  const security = new Command('security').description('Network security diagnostics and controls')

  security
    .command('reputation')
    .description('Show peer reputation scores (local view only)')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      try {
        const client = new DaemonClient(opts.port)
        const reps = await client.getReputation()
        if (!opts.json) {
          if (reps.length === 0) {
            printSuccess('No peer reputation data yet.', opts)
          } else {
            printSuccess(`${reps.length} peer(s) with reputation records:`, opts)
          }
        }
        print(reps, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  security
    .command('clear')
    .description('Clear blacklist and reset reputation score for a peer')
    .argument('<peerId>', 'PeerId to clear')
    .option('--json', 'JSON output')
    .action(async function (peerId: string, _cmdOpts: unknown, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      try {
        const client = new DaemonClient(opts.port)
        await client.clearPeerBlacklist(peerId)
        if (opts.json) {
          print({ cleared: true, peerId }, opts)
        } else {
          printSuccess(`Cleared blacklist for peer ${peerId.slice(0, 16)}…`, opts)
        }
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // security pow-status — proof-of-work configuration and stamp diagnostics
  // ---------------------------------------------------------------------------
  security
    .command('pow-status')
    .description('Show proof-of-work configuration, cached stamps, and mining speed benchmark')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      try {
        const client = new DaemonClient(opts.port)
        const status = await client.getPowStatus()
        if (!opts.json) {
          const { config: cfg, cachedStamps, benchmark } = status
          printSuccess('Proof-of-Work status:', opts)
          print({
            requirePoW: cfg.requirePoW,
            powBitsForChunks: cfg.powBitsForChunks,
            powBitsForRequests: cfg.powBitsForRequests,
            powWindowMs: `${cfg.powWindowMs / 3_600_000}h`,
            cachedStamps: cachedStamps.length,
            benchmarkBits: benchmark.bitsUsed,
            benchmarkMs: benchmark.mineTimeMs,
          }, opts)
        } else {
          print(status, opts)
        }
      } catch (err) {
        printError(err, opts)
      }
    })

  return security
}
