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

export function buildNetworkCommand(): Command {
  const network = new Command('network').description('Manage agent-net networks')

  // ---------------------------------------------------------------------------
  // network create
  // ---------------------------------------------------------------------------
  network
    .command('create')
    .description('Create and join a new network with a PSK')
    .requiredOption('--psk <key>', 'Pre-shared key (use: openssl rand -hex 32)')
    .option('--name <label>', 'Human-readable network label')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      const { psk, name } = this.opts()
      try {
        const client = new DaemonClient(opts.port)
        const net = await client.joinNetwork(psk, name)
        if (!opts.json) printSuccess(`Joined network ${net.id}`, opts)
        print(net, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // network join (alias for create — same operation)
  // ---------------------------------------------------------------------------
  network
    .command('join')
    .description('Join an existing network with a PSK')
    .requiredOption('--psk <key>', 'Pre-shared key')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      const { psk } = this.opts()
      try {
        const client = new DaemonClient(opts.port)
        const net = await client.joinNetwork(psk)
        if (!opts.json) printSuccess(`Joined network ${net.id}`, opts)
        print(net, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // network leave
  // ---------------------------------------------------------------------------
  network
    .command('leave')
    .description('Leave a network')
    .argument('<networkId>', 'Network ID (from network list)')
    .option('--json', 'JSON output')
    .action(async function (networkId: string, _opts: Record<string, unknown>, cmd: Command) {
      const opts = getOpts(cmd ?? this)
      try {
        const client = new DaemonClient(opts.port)
        await client.leaveNetwork(networkId)
        if (opts.json) {
          print({ left: true, networkId }, opts)
        } else {
          printSuccess(`Left network ${networkId}`, opts)
        }
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // network list
  // ---------------------------------------------------------------------------
  network
    .command('list')
    .description('List active networks')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      try {
        const client = new DaemonClient(opts.port)
        const nets = await client.listNetworks()
        print(nets, opts)
      } catch (err) {
        printError(err, opts)
      }
    })

  return network
}
