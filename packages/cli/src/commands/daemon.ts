import { Command } from 'commander'
import { DaemonClient, ensureDaemon } from '../client.js'
import { print, printError, printSuccess } from '../output.js'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PID_PATH = join(homedir(), '.subspace', 'daemon.pid')

function getOpts(cmd: Command): { json: boolean; port: number } {
  const parent = cmd.parent?.parent ?? cmd.parent ?? cmd
  return {
    json: !!(cmd.opts().json ?? parent.opts().json),
    port: parseInt(cmd.opts().port ?? parent.opts().port ?? '7432', 10),
  }
}

export function buildDaemonCommand(): Command {
  const daemon = new Command('daemon').description('Manage the Subspace Transceiver daemon process')

  // ---------------------------------------------------------------------------
  // daemon start
  // ---------------------------------------------------------------------------
  daemon
    .command('start')
    .description('Start the daemon (auto-starts if not running)')
    .option('--foreground', 'Run in foreground (Docker/CI)')
    .option('--port <n>', 'Override daemon port')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      try {
        await ensureDaemon(opts.port)
        const client = new DaemonClient(opts.port)
        const health = await client.health()
        if (opts.json) {
          print({ running: true, ...health }, opts)
        } else {
          printSuccess(`Daemon started on port ${opts.port}`, opts)
          print(health, opts)
        }
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // daemon stop
  // ---------------------------------------------------------------------------
  daemon
    .command('stop')
    .description('Stop the running daemon')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      try {
        if (!existsSync(PID_PATH)) {
          if (opts.json) {
            print({ running: false, message: 'Daemon is not running' }, opts)
          } else {
            console.log('Daemon is not running.')
          }
          return
        }
        const entry = JSON.parse(readFileSync(PID_PATH, 'utf8'))
        process.kill(entry.pid, 'SIGTERM')
        // Wait briefly for shutdown
        await new Promise(r => setTimeout(r, 1500))
        if (opts.json) {
          print({ stopped: true, pid: entry.pid }, opts)
        } else {
          printSuccess(`Daemon (PID ${entry.pid}) stopped.`, opts)
        }
      } catch (err) {
        printError(err, opts)
      }
    })

  // ---------------------------------------------------------------------------
  // daemon status
  // ---------------------------------------------------------------------------
  daemon
    .command('status')
    .description('Show daemon status')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      try {
        const client = new DaemonClient(opts.port)
        // No auto-start for status check
        const res = await fetch(`http://127.0.0.1:${opts.port}/health`, {
          signal: AbortSignal.timeout(2000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const health = await res.json()
        if (opts.json) {
          print({ running: true, ...health }, opts)
        } else {
          print(health, opts)
        }
      } catch {
        if (opts.json) {
          print({ running: false }, opts)
        } else {
          console.log('Daemon is not running.')
        }
      }
    })

  // ---------------------------------------------------------------------------
  // daemon restart
  // ---------------------------------------------------------------------------
  daemon
    .command('restart')
    .description('Restart the daemon')
    .option('--port <n>', 'Override daemon port')
    .option('--json', 'JSON output')
    .action(async function (this: Command) {
      const opts = getOpts(this)
      try {
        // Stop
        if (existsSync(PID_PATH)) {
          const entry = JSON.parse(readFileSync(PID_PATH, 'utf8'))
          process.kill(entry.pid, 'SIGTERM')
          await new Promise(r => setTimeout(r, 2000))
        }
        // Start
        await ensureDaemon(opts.port)
        const client = new DaemonClient(opts.port)
        const health = await client.health()
        if (opts.json) {
          print({ running: true, restarted: true, ...health }, opts)
        } else {
          printSuccess(`Daemon restarted on port ${opts.port}`, opts)
          print(health, opts)
        }
      } catch (err) {
        printError(err, opts)
      }
    })

  return daemon
}
