#!/usr/bin/env node
/**
 * Patch @orbitdb/core sync.js for libp2p@3 stream compatibility.
 *
 * Problem:
 *   @orbitdb/core@3.x's sync.js uses it-pipe with raw libp2p streams:
 *
 *     await pipe(sendHeads, stream, receiveHeads(peerId))
 *     await pipe(stream, receiveHeads(peerId), sendHeads, stream)
 *
 *   it-pipe's `pipe()` checks for a "duplex" object via isDuplex() which
 *   requires both `obj.sink` AND `obj.source` to be present. libp2p@3
 *   streams expose `Symbol.asyncIterator` for reading and `send()` for
 *   writing — they do NOT have a `sink` property. This causes it-pipe to
 *   leave the stream object as a non-function element in the pipeline, then
 *   rawPipe() tries to call it as a function → "fns.shift(...) is not a function".
 *
 * Fix:
 *   Wrap each pipe() call so that if the stream has a `send` method (libp2p@3
 *   API), we adapt it to the duplex interface { source, sink } that it-pipe
 *   expects. The source is the stream itself (AsyncIterable) and the sink is
 *   an async function that drains the iterable with stream.send().
 *
 *   Fall back to the original pipe() call when `send` is absent (libp2p@2).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const target = resolve(
  __dirname,
  '../node_modules/@orbitdb/core/src/sync.js'
)

let content = readFileSync(target, 'utf8')

if (content.includes('adaptLibp2p3Stream')) {
  console.log('[patch] @orbitdb/core sync.js already patched for libp2p@3 — skipping')
  process.exit(0)
}

// Insert a helper function after the imports at the top of the file
const importSection = `import { pipe } from 'it-pipe'`
if (!content.includes(importSection)) {
  console.error('[patch] @orbitdb/core sync.js: unexpected content — cannot find import section')
  process.exit(1)
}

const helperFn = `
/**
 * Adapt a libp2p@3 stream (AsyncIterable + send()) to the duplex {source,sink}
 * interface expected by it-pipe. Falls back to returning the stream unchanged
 * for libp2p@2 environments that already implement the duplex interface.
 */
const adaptLibp2p3Stream = (stream) => {
  if (stream == null || typeof stream.send !== 'function') {
    return stream  // Already duplex (libp2p@2) or null
  }
  return {
    source: stream,
    sink: async (source) => {
      for await (const data of source) {
        stream.send(data)
      }
    }
  }
}
`

content = content.replace(importSection, importSection + '\n' + helperFn)

// Patch the two pipe() calls that use raw streams
const patch1Original = `      await pipe(stream, receiveHeads(peerId), sendHeads, stream)`
const patch1Replacement = `      const adaptedStream1 = adaptLibp2p3Stream(stream)
      await pipe(adaptedStream1, receiveHeads(peerId), sendHeads, adaptedStream1)`

if (!content.includes(patch1Original)) {
  console.error('[patch] @orbitdb/core sync.js: cannot find first pipe() call to patch')
  process.exit(1)
}
content = content.replace(patch1Original, patch1Replacement)

const patch2Original = `          await pipe(sendHeads, stream, receiveHeads(peerId))`
const patch2Replacement = `          const adaptedStream2 = adaptLibp2p3Stream(stream)
          await pipe(sendHeads, adaptedStream2, receiveHeads(peerId))`

if (!content.includes(patch2Original)) {
  console.error('[patch] @orbitdb/core sync.js: cannot find second pipe() call to patch')
  process.exit(1)
}
content = content.replace(patch2Original, patch2Replacement)

writeFileSync(target, content, 'utf8')
console.log('[patch] @orbitdb/core sync.js patched for libp2p@3 stream compat')
