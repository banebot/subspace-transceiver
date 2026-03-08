/**
 * Browse protocol — server-side handler.
 *
 * When the Rust engine accepts a `/subspace/browse/1.0.0` connection, it sends
 * a `browse.request` notification to TypeScript via the bridge. This module
 * handles that notification by querying the local memory stores and responding
 * via `bridge.browseRespond()`.
 *
 * Usage (in daemon startup):
 * ```ts
 * registerBrowseProtocol(bridge, stores)
 * ```
 */

import type { EngineBridge, BrowseStub } from './engine-bridge.js'
import type { IMemoryStore } from './store.js'

export interface BrowseProtocolOptions {
  /** Maximum number of stubs to return per request (hard cap). */
  maxStubs?: number
}

/**
 * Register the browse protocol server-side handler.
 *
 * Subscribes to `browse.request` notifications from the engine and responds
 * with content stubs from the provided store getter. The getter is called at
 * request time, so it always reflects the current set of joined networks.
 *
 * @param bridge       The EngineBridge to subscribe to and respond through.
 * @param getStores    Function returning the current list of memory stores to serve.
 * @param opts         Optional configuration.
 * @returns  Cleanup function that removes the handler.
 */
export function registerBrowseProtocol(
  bridge: EngineBridge | null,
  getStores: IMemoryStore[] | (() => IMemoryStore[]),
  opts: BrowseProtocolOptions = {}
): () => void {
  if (!bridge) {
    return () => {}
  }

  const maxStubs = opts.maxStubs ?? 200
  const resolveStores = typeof getStores === 'function' ? getStores : () => getStores

  const unsub = bridge.onBrowseRequest(async (event) => {
    try {
      const limit = Math.min(event.limit, maxStubs)
      const stubs: BrowseStub[] = []
      const stores = resolveStores()

      for (const store of stores) {
        const chunks = await store.list().catch(() => [])
        for (const chunk of chunks) {
          if (chunk._tombstone) continue
          if (event.collection && chunk.collection !== event.collection) continue
          if (event.since && chunk.source.timestamp < event.since) continue

          stubs.push({
            id: chunk.id,
            title: (chunk.slug ?? undefined),
            collection: chunk.collection,
            topic: chunk.topic ?? [],
            updated_at: chunk.source.timestamp,
          })

          if (stubs.length >= limit + 1) break
        }
        if (stubs.length >= limit + 1) break
      }

      const hasMore = stubs.length > limit
      const page = hasMore ? stubs.slice(0, limit) : stubs

      await bridge.browseRespond(event.requestId, page, hasMore)
    } catch (err) {
      console.warn('[browse] Error serving browse request:', err)
      // Respond with empty stubs to unblock the remote peer
      await bridge.browseRespond(event.requestId, [], false).catch(() => {})
    }
  })

  console.log('[subspace] Browse protocol registered.')
  return unsub
}
