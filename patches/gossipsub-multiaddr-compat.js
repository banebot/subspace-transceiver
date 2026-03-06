#!/usr/bin/env node
/**
 * Patch @chainsafe/libp2p-gossipsub to support @multiformats/multiaddr v13+.
 *
 * Problem:
 *   libp2p@3.x bundles @multiformats/multiaddr@13 internally. In v13,
 *   `Multiaddr.tuples()` was removed and replaced with `getComponents()`.
 *   gossipsub@14.1.2 was built against v12 and calls `multiaddr.tuples()` in
 *   `multiaddrToIPStr()`. When libp2p passes a v13 Multiaddr as
 *   `connection.remoteAddr`, gossipsub's `addPeer()` throws:
 *     "TypeError: multiaddr.tuples is not a function or its return value is not iterable"
 *   The error is silently swallowed by the registrar's catch block, leaving
 *   every gossipsub peer with zero outbound streams — disabling all pub/sub
 *   message delivery and OrbitDB CRDT replication.
 *
 * Fix:
 *   Rewrite `multiaddrToIPStr` to try `tuples()` first (v12 API), then fall
 *   back to `getComponents()` (v13+ API).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const target = resolve(
  __dirname,
  '../node_modules/@chainsafe/libp2p-gossipsub/dist/src/utils/multiaddr.js'
)

const original = `export function multiaddrToIPStr(multiaddr) {
    for (const tuple of multiaddr.tuples()) {
        switch (tuple[0]) {
            case Protocol.ip4:
            case Protocol.ip6:
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                return convertToString(tuple[0], tuple[1]);
            default:
                break;
        }
    }
    return null;
}`

const patched = `export function multiaddrToIPStr(multiaddr) {
    // Support both @multiformats/multiaddr v12 (tuples()) and v13+ (getComponents()).
    // libp2p@3.x bundles multiaddr v13 internally; gossipsub@14 was built against v12.
    if (typeof multiaddr.tuples === 'function') {
        for (const tuple of multiaddr.tuples()) {
            switch (tuple[0]) {
                case Protocol.ip4:
                case Protocol.ip6:
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    return convertToString(tuple[0], tuple[1]);
                default:
                    break;
            }
        }
    } else if (typeof multiaddr.getComponents === 'function') {
        for (const comp of multiaddr.getComponents()) {
            if (comp.code === Protocol.ip4 || comp.code === Protocol.ip6) {
                return comp.value ?? null;
            }
        }
    }
    return null;
}`

let content = readFileSync(target, 'utf8')
if (content.includes('getComponents')) {
  console.log('[patch] gossipsub multiaddrToIPStr already patched — skipping')
  process.exit(0)
}
if (!content.includes(original.trim().slice(0, 40))) {
  console.error('[patch] gossipsub multiaddrToIPStr: unexpected file content — cannot apply patch')
  process.exit(1)
}
content = content.replace(original, patched)
writeFileSync(target, content, 'utf8')
console.log('[patch] gossipsub multiaddrToIPStr patched for @multiformats/multiaddr v13 compat')
