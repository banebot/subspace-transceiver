#!/usr/bin/env node
/**
 * @agent-net/cli — agent-net command-line interface
 *
 * Usage: agent-net [options] <command>
 *
 * Global options:
 *   --port <n>   Daemon port (default: 7432)
 *   --json       Structured JSON output for all commands
 *   -V, --version
 *   -h, --help
 */

import { Command } from 'commander'
import { printError } from './output.js'
import { buildDaemonCommand } from './commands/daemon.js'
import { buildNetworkCommand } from './commands/network.js'
import { buildMemoryCommand } from './commands/memory.js'

const program = new Command()

program
  .name('agent-net')
  .description('Decentralized agent memory — store, query, and share memory across agents')
  .version('0.1.0')
  .option('--port <n>', 'Daemon port (default: 7432)', '7432')
  .option('--json', 'Output JSON for all commands (recommended for agents)')

// Register subcommand groups
program.addCommand(buildDaemonCommand())
program.addCommand(buildNetworkCommand())
program.addCommand(buildMemoryCommand())

// Global unhandled rejection handler
process.on('unhandledRejection', (reason) => {
  const opts = { json: process.argv.includes('--json') }
  printError(reason, opts)
})

// Parse and execute
program.parseAsync(process.argv).catch((err) => {
  const opts = { json: process.argv.includes('--json') }
  printError(err, opts)
})
