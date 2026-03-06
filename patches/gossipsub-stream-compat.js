#!/usr/bin/env node
/**
 * Patch @chainsafe/libp2p-gossipsub to support the libp2p@3 stream API.
 *
 * Problem:
 *   libp2p@3 / yamux@8 changed the stream interface: streams are now async
 *   iterables (for reading via `for await`) and expose `stream.send(data)` for
 *   writing. The old interface exposed separate `source` (AsyncIterable) and
 *   `sink` ((source) => Promise<void>) properties consumed by `it-pipe`.
 *
 *   gossipsub@14's OutboundStream constructor pipes a pushable into the raw
 *   stream using it-pipe:
 *
 *     pipe(this.pushable, this.rawStream).catch(errCallback)
 *
 *   With the old interface, it-pipe detects `rawStream.sink` and calls
 *   `rawStream.sink(pushable)` — forwarding every pushed message to the peer.
 *
 *   With libp2p@3, `rawStream.sink` is `undefined`, so it-pipe treats
 *   `rawStream` as an async iterable source (not a sink), ignores the
 *   pushable entirely, and returns the raw stream as an async iterable.
 *   The return value has no `.catch` method, so the constructor throws:
 *
 *     "TypeError: pipe(...).catch is not a function"
 *
 *   This is silently caught by createOutboundStream's try/catch, leaving
 *   every peer with zero outbound gossipsub streams — no SUBSCRIBE or
 *   GRAFT messages are ever sent, the mesh never forms, and OrbitDB CRDT
 *   replication is broken.
 *
 * Fix:
 *   When `rawStream.send` is present (libp2p@3+ API), replace the
 *   `pipe(pushable, rawStream)` call with an async iterator loop that
 *   consumes the pushable and calls `rawStream.send(chunk)` for each item.
 *   Fall back to the original pipe call for libp2p@2 environments.
 *
 *   InboundStream is unaffected: `pipe(rawStream, decode)` works because
 *   libp2p@3 streams implement Symbol.asyncIterator directly, which it-pipe
 *   treats as a valid source.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const target = resolve(
  __dirname,
  '../node_modules/@chainsafe/libp2p-gossipsub/dist/src/stream.js'
)

const original = `        pipe(this.pushable, this.rawStream).catch(errCallback);`

const patched = `        // libp2p@3 streams expose send() instead of a sink property.
        // it-pipe detects rawStream.sink === undefined, treats rawStream as an
        // async iterable source, and returns it — the pushable is never drained
        // and the resulting value has no .catch method, crashing the constructor.
        // Use an explicit async loop + send() when the libp2p@3 API is present.
        if (typeof this.rawStream.send === 'function') {
            const pushable = this.pushable;
            const rawStream = this.rawStream;
            (async () => {
                try {
                    for await (const data of pushable) {
                        rawStream.send(data);
                    }
                }
                catch (e) {
                    errCallback(e);
                }
            })();
        }
        else {
            pipe(this.pushable, this.rawStream).catch(errCallback);
        }`

let content = readFileSync(target, 'utf8')

if (content.includes('rawStream.send')) {
  console.log('[patch] gossipsub OutboundStream already patched for libp2p@3 — skipping')
  process.exit(0)
}

if (!content.includes(original)) {
  console.error('[patch] gossipsub OutboundStream: unexpected file content — cannot apply patch')
  console.error('[patch] expected to find:', original)
  process.exit(1)
}

content = content.replace(original, patched)
writeFileSync(target, content, 'utf8')
console.log('[patch] gossipsub OutboundStream patched for libp2p@3 stream.send() compat')
