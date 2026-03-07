/**
 * CLI commands for Subspace mail (store-and-forward messaging).
 *
 * subspace mail send --to <peerId> --body "message" [--subject "Subject"]
 * subspace mail inbox [--json]
 * subspace mail read <id>
 * subspace mail delete <id>
 * subspace mail outbox [--json]
 */

import { Command } from 'commander'
import { DaemonClient } from '../client.js'
import { print, printError, printSuccess } from '../output.js'

function getOpts(cmd: Command): { json: boolean; port: number } {
  const parent = cmd.parent?.parent ?? cmd.parent ?? cmd
  return {
    json: !!(cmd.opts().json ?? parent.opts().json),
    port: parseInt(String(cmd.opts().port ?? parent.opts().port ?? '7432'), 10),
  }
}

export function buildMailCommand(): Command {
  const mail = new Command('mail').description('Send and receive messages between agents')

  // ---------------------------------------------------------------------------
  // mail send
  // ---------------------------------------------------------------------------
  mail
    .command('send')
    .description('Send a message to another agent')
    .requiredOption('--to <peerId>', 'Recipient PeerId')
    .requiredOption('--body <text>', 'Message body')
    .option('--subject <text>', 'Message subject')
    .option('--type <contentType>', 'Content type hint (e.g. text/plain, application/json)')
    .option('--ttl <seconds>', 'TTL in seconds (default: 604800 = 7 days)', '604800')
    .action(async (opts, cmd) => {
      const { port, json } = getOpts(cmd)
      const client = new DaemonClient(port)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mail/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: opts.to,
            subject: opts.subject,
            body: opts.body,
            contentType: opts.type,
            ttl: parseInt(opts.ttl, 10),
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Unknown error' }))
          printError(new Error((err as { error: string }).error), { json })
        }
        const result = (await res.json()) as { ok: boolean; mode: string }
        if (json) {
          print(result, { json })
        } else {
          printSuccess(`Message sent (${result.mode === 'direct' ? '✓ direct delivery' : '→ via relay'})`, { json })
        }
      } catch (err) {
        printError(err, { json })
      }
    })

  // ---------------------------------------------------------------------------
  // mail inbox
  // ---------------------------------------------------------------------------
  mail
    .command('inbox')
    .description('List received messages')
    .action(async (opts, cmd) => {
      const { port, json } = getOpts(cmd)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mail/inbox`)
        if (!res.ok) printError(new Error('Failed to list inbox'), { json })
        const messages = (await res.json()) as Array<Record<string, unknown>>
        if (json) {
          print(messages, { json })
          return
        }
        if (messages.length === 0) {
          console.log('Inbox is empty.')
          return
        }
        for (const msg of messages) {
          const date = new Date(msg.receivedAt as number).toLocaleString()
          const from = String(msg.from).slice(0, 20) + '…'
          const subject = msg.subject ? ` [${msg.subject}]` : ''
          console.log(`  ${msg.id}  ${date}  From: ${from}${subject}`)
        }
      } catch (err) {
        printError(err, { json })
      }
    })

  // ---------------------------------------------------------------------------
  // mail read <id>
  // ---------------------------------------------------------------------------
  mail
    .command('read <id>')
    .description('Read a specific inbox message')
    .action(async (id: string, opts, cmd) => {
      const { port, json } = getOpts(cmd)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mail/inbox/${id}`)
        if (!res.ok) {
          if (res.status === 404) printError(new Error('Message not found'), { json })
          printError(new Error('Failed to read message'), { json })
        }
        const msg = (await res.json()) as Record<string, unknown>
        if (json) {
          print(msg, { json })
          return
        }
        const date = new Date(msg.receivedAt as number).toLocaleString()
        console.log(`From:      ${msg.from}`)
        console.log(`Received:  ${date}`)
        if (msg.subject) console.log(`Subject:   ${msg.subject}`)
        console.log('---')
        console.log(String(msg.body))
      } catch (err) {
        printError(err, { json })
      }
    })

  // ---------------------------------------------------------------------------
  // mail delete <id>
  // ---------------------------------------------------------------------------
  mail
    .command('delete <id>')
    .description('Delete an inbox message')
    .action(async (id: string, opts, cmd) => {
      const { port, json } = getOpts(cmd)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mail/inbox/${id}`, { method: 'DELETE' })
        if (!res.ok) {
          if (res.status === 404) printError(new Error('Message not found'), { json })
          printError(new Error('Failed to delete message'), { json })
        }
        printSuccess(`Message ${id} deleted.`, { json })
      } catch (err) {
        printError(err, { json })
      }
    })

  // ---------------------------------------------------------------------------
  // mail outbox
  // ---------------------------------------------------------------------------
  mail
    .command('outbox')
    .description('List sent messages')
    .action(async (opts, cmd) => {
      const { port, json } = getOpts(cmd)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mail/outbox`)
        if (!res.ok) printError(new Error('Failed to list outbox'), { json })
        const messages = (await res.json()) as Array<Record<string, unknown>>
        if (json) {
          print(messages, { json })
          return
        }
        if (messages.length === 0) {
          console.log('Outbox is empty.')
          return
        }
        for (const msg of messages) {
          const date = new Date(msg.sentAt as number).toLocaleString()
          const to = String(msg.to).slice(0, 20) + '…'
          const subject = msg.subject ? ` [${msg.subject}]` : ''
          const status = msg.status === 'sent' ? '✓' : '⏳'
          console.log(`  ${status}  ${msg.id}  ${date}  To: ${to}${subject}`)
        }
      } catch (err) {
        printError(err, { json })
      }
    })

  return mail
}
