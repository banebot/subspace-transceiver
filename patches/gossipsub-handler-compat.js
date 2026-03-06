#!/usr/bin/env node
/**
 * Patch @chainsafe/libp2p-gossipsub to support the libp2p@3 protocol handler
 * calling convention.
 *
 * Problem:
 *   libp2p@2 called registered protocol handlers with a single destructured
 *   object argument:
 *
 *     handler({ stream, connection })
 *
 *   libp2p@3 changed this to two positional arguments:
 *
 *     handler(stream, connection)
 *
 *   gossipsub@14's `onIncomingStream` is defined with a destructured parameter:
 *
 *     onIncomingStream({ stream, connection }) { ... }
 *
 *   When libp2p@3 calls `onIncomingStream(streamObj, connectionObj)`, the
 *   first positional argument `streamObj` is destructured looking for `.stream`
 *   and `.connection` properties. Neither exists on the raw stream object, so
 *   both variables become `undefined`. The function proceeds to access
 *   `connection.remotePeer` → TypeError, caught silently by libp2p's middleware
 *   chain, and `muxedStream.abort(err)` is called.
 *
 *   Result: no inbound gossipsub streams are ever created, no SUBSCRIBE or
 *   GRAFT messages are received, the gossip mesh never forms, and publish
 *   delivers to zero peers — OrbitDB CRDT replication is completely broken.
 *
 * Fix:
 *   Replace the destructured parameter signature with two positional
 *   parameters plus a runtime shim that handles both calling conventions.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const target = resolve(
  __dirname,
  '../node_modules/@chainsafe/libp2p-gossipsub/dist/src/index.js'
)

const original = [
  '    onIncomingStream({ stream, connection }) {',
  '        if (!this.isStarted()) {',
  '            return;',
  '        }',
  '        const peerId = connection.remotePeer;',
  '        // add peer to router',
  '        this.addPeer(peerId, connection.direction, connection.remoteAddr);',
  '        // create inbound stream',
  '        this.createInboundStream(peerId, stream);',
  '        // attempt to create outbound stream',
  '        this.outboundInflightQueue.push({ peerId, connection });',
  '    }',
].join('\n')

const patched = [
  '    onIncomingStream(streamOrData, connectionArg) {',
  '        // libp2p@2 called handler({ stream, connection }); libp2p@3 calls handler(stream, connection).',
  '        // Detect which convention is in use at runtime and normalise.',
  '        let stream, connection;',
  '        if (streamOrData != null && typeof streamOrData === \'object\' && \'connection\' in streamOrData) {',
  '            // libp2p@2 style: single destructured argument',
  '            stream = streamOrData.stream;',
  '            connection = streamOrData.connection;',
  '        }',
  '        else {',
  '            // libp2p@3 style: two positional arguments',
  '            stream = streamOrData;',
  '            connection = connectionArg;',
  '        }',
  '        if (!this.isStarted()) {',
  '            return;',
  '        }',
  '        const peerId = connection.remotePeer;',
  '        // add peer to router',
  '        this.addPeer(peerId, connection.direction, connection.remoteAddr);',
  '        // create inbound stream',
  '        this.createInboundStream(peerId, stream);',
  '        // attempt to create outbound stream',
  '        this.outboundInflightQueue.push({ peerId, connection });',
  '    }',
].join('\n')

let content = readFileSync(target, 'utf8')

if (content.includes('streamOrData')) {
  console.log('[patch] gossipsub onIncomingStream already patched for libp2p@3 — skipping')
  process.exit(0)
}

if (!content.includes(original)) {
  console.error('[patch] gossipsub onIncomingStream: unexpected file content — cannot apply patch')
  process.exit(1)
}

content = content.replace(original, patched)
writeFileSync(target, content, 'utf8')
console.log('[patch] gossipsub onIncomingStream patched for libp2p@3 handler calling convention')
