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
import { buildSiteCommand } from './commands/site.js'
import { buildDiscoverCommand, buildBrowseCommand, buildSecurityCommand } from './commands/discover.js'

const program = new Command()

program
  .name('agent-net')
  .description('Decentralized agent memory — store, query, and share memory across agents')
  .version('0.2.0')
  .option('--port <n>', 'Daemon port (default: 7432)', '7432')
  .option('--json', 'Output JSON for all commands (recommended for agents)')

// Core commands
program.addCommand(buildDaemonCommand())
program.addCommand(buildNetworkCommand())
program.addCommand(buildMemoryCommand())

// Site / namespace commands (TODO-054945bb)
program.addCommand(buildSiteCommand())

// Discovery / browse commands (TODO-a1fcd540)
program.addCommand(buildDiscoverCommand())
program.addCommand(buildBrowseCommand())

// Security diagnostics (TODO-ebb16396)
program.addCommand(buildSecurityCommand())

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
