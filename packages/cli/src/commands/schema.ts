/**
 * CLI commands for Subspace Lexicon Protocol Registry.
 *
 * subspace schema list [--pattern <nsid-pattern>] [--json]
 * subspace schema show <nsid>
 * subspace schema register <file.json>
 * subspace schema validate --nsid <nsid> --data <json>
 */

import { readFile } from 'node:fs/promises'
import { Command } from 'commander'
import { print, printError, printSuccess } from '../output.js'

function getOpts(cmd: Command): { json: boolean; port: number } {
  const parent = cmd.parent?.parent ?? cmd.parent ?? cmd
  return {
    json: !!(cmd.opts().json ?? parent.opts().json),
    port: parseInt(String(cmd.opts().port ?? parent.opts().port ?? '7432'), 10),
  }
}

export function buildSchemaCommand(): Command {
  const schema = new Command('schema').description('Manage Lexicon schemas (NSID-based record types)')

  // ---------------------------------------------------------------------------
  // schema list
  // ---------------------------------------------------------------------------
  schema
    .command('list')
    .description('List all known schemas')
    .option('--pattern <nsid-pattern>', 'Filter by NSID prefix (e.g. net.subspace.*)')
    .action(async (opts, cmd) => {
      const { port, json } = getOpts(cmd)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/schemas`)
        if (!res.ok) printError(new Error('Failed to list schemas'), { json })
        let schemas = (await res.json()) as Array<{ id: string; revision: number; description?: string }>

        if (opts.pattern) {
          const pattern = opts.pattern as string
          schemas = schemas.filter(s => {
            if (pattern.endsWith('.*')) {
              const prefix = pattern.slice(0, -2)
              return s.id === prefix || s.id.startsWith(prefix + '.')
            }
            return s.id === pattern
          })
        }

        if (json) {
          print(schemas, { json })
          return
        }
        if (schemas.length === 0) {
          console.log('No schemas found.')
          return
        }
        for (const s of schemas) {
          const desc = s.description ? `  — ${s.description}` : ''
          console.log(`  ${s.id}@r${s.revision}${desc}`)
        }
      } catch (err) {
        printError(err, { json })
      }
    })

  // ---------------------------------------------------------------------------
  // schema show <nsid>
  // ---------------------------------------------------------------------------
  schema
    .command('show <nsid>')
    .description('Display a schema definition')
    .action(async (nsid: string, opts, cmd) => {
      const { port, json } = getOpts(cmd)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/schemas/${encodeURIComponent(nsid)}`)
        if (!res.ok) {
          if (res.status === 404) printError(new Error(`Schema not found: ${nsid}`), { json })
          printError(new Error('Failed to fetch schema'), { json })
        }
        const schemaData = await res.json()
        if (json) {
          print(schemaData, { json })
          return
        }
        console.log(JSON.stringify(schemaData, null, 2))
      } catch (err) {
        printError(err, { json })
      }
    })

  // ---------------------------------------------------------------------------
  // schema register <file.json>
  // ---------------------------------------------------------------------------
  schema
    .command('register <file>')
    .description('Register a Lexicon schema from a JSON file')
    .action(async (file: string, opts, cmd) => {
      const { port, json } = getOpts(cmd)
      try {
        const raw = await readFile(file, 'utf8')
        const schemaData = JSON.parse(raw)

        const res = await fetch(`http://127.0.0.1:${port}/schemas`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(schemaData),
        })
        if (!res.ok) {
          const err = (await res.json().catch(() => ({ error: 'Unknown error' }))) as { error: string }
          printError(new Error(err.error), { json })
        }
        const registered = await res.json()
        if (json) {
          print(registered, { json })
        } else {
          printSuccess(`Schema ${(registered as { id: string }).id} registered successfully.`, { json })
        }
      } catch (err) {
        printError(err, { json })
      }
    })

  // ---------------------------------------------------------------------------
  // schema validate --nsid <nsid> --data <json>
  // ---------------------------------------------------------------------------
  schema
    .command('validate')
    .description('Validate record data against a schema')
    .requiredOption('--nsid <nsid>', 'Schema NSID')
    .requiredOption('--data <json>', 'Record data as JSON string or @filename')
    .action(async (opts, cmd) => {
      const { port, json } = getOpts(cmd)
      try {
        let dataStr = opts.data as string
        if (dataStr.startsWith('@')) {
          dataStr = await readFile(dataStr.slice(1), 'utf8')
        }
        const data = JSON.parse(dataStr)

        const res = await fetch(`http://127.0.0.1:${port}/schemas/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nsid: opts.nsid, data }),
        })
        const result = await res.json()
        if (json) {
          print(result, { json })
          return
        }
        const r = result as { valid: boolean; errors: string[]; unknownSchema?: boolean }
        if (r.unknownSchema) {
          console.log(`⚠  Schema ${opts.nsid} not found (accepted under open-world model)`)
        } else if (r.valid) {
          printSuccess(`✓ Data is valid for schema ${opts.nsid}`, { json })
        } else {
          console.log(`✗ Validation failed for schema ${opts.nsid}:`)
          for (const err of r.errors) console.log(`   - ${err}`)
          process.exit(1)
        }
      } catch (err) {
        printError(err, { json })
      }
    })

  return schema
}
