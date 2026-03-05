/**
 * In-memory backlink index for the subspace content graph.
 *
 * Maintains a reverse index: targetId → Set<sourceChunkId>.
 * This allows "what chunks link TO this chunk?" queries in O(1) without
 * scanning the entire store.
 *
 * LIFECYCLE
 * ─────────
 * - Built on startup by scanning the local store.
 * - Updated incrementally when chunks are put (local or replicated).
 * - Not persisted — rebuilt from OrbitDB on restart (fast, local-only).
 *
 * INDEX COVERAGE
 * ──────────────
 * Indexes two sources of links:
 *   1. `chunk.links[].target` — explicit ContentLink entries
 *   2. `chunk.supersedes`     — implicit supersedes relationship
 *
 * For `agent://` URIs in link targets, the index stores the URI string
 * directly. Resolution of URIs to chunk IDs happens at query time.
 *
 * THREAD SAFETY
 * ─────────────
 * Single-threaded Node.js — no locking needed. All operations are synchronous
 * on the in-memory Map.
 */

import type { MemoryChunk, ContentLink } from './schema.js'
import type { IMemoryStore } from './store.js'

export class BacklinkIndex {
  /**
   * Maps target (chunk ID or agent:// URI) → set of source chunk IDs
   * that contain a link pointing at it.
   */
  private readonly index = new Map<string, Set<string>>()

  /**
   * Build the index from an existing store.
   * Should be called once on daemon startup after stores are initialized.
   */
  async build(store: IMemoryStore): Promise<void> {
    const all = await store.list()
    for (const chunk of all) {
      this.indexChunk(chunk)
    }
  }

  /**
   * Add a chunk's outgoing links to the index.
   * Idempotent — safe to call multiple times for the same chunk.
   */
  indexChunk(chunk: MemoryChunk): void {
    if (chunk._tombstone) return

    // Index explicit links
    if (chunk.links) {
      for (const link of chunk.links) {
        this.addEdge(link.target, chunk.id)
      }
    }

    // Index supersedes as an implicit link
    if (chunk.supersedes) {
      this.addEdge(chunk.supersedes, chunk.id)
    }
  }

  /**
   * Remove a chunk's outgoing links from the index.
   * Called when a chunk is tombstoned.
   */
  removeChunk(chunk: MemoryChunk): void {
    if (chunk.links) {
      for (const link of chunk.links) {
        const set = this.index.get(link.target)
        if (set) {
          set.delete(chunk.id)
          if (set.size === 0) this.index.delete(link.target)
        }
      }
    }
    if (chunk.supersedes) {
      const set = this.index.get(chunk.supersedes)
      if (set) {
        set.delete(chunk.id)
        if (set.size === 0) this.index.delete(chunk.supersedes)
      }
    }
  }

  /**
   * Get the IDs of all chunks that link TO the given target.
   * Target may be a chunk UUID or an agent:// URI.
   */
  getBacklinks(target: string): string[] {
    return [...(this.index.get(target) ?? [])]
  }

  /**
   * Get all outgoing link targets for a given source chunk.
   * Returns an array of { target, rel } pairs.
   *
   * Derived from the chunk itself, not the index
   * (the index is a reverse map, not forward map).
   */
  static getLinks(chunk: MemoryChunk): ContentLink[] {
    const links: ContentLink[] = [...(chunk.links ?? [])]

    // Surface the supersedes field as a synthetic link entry
    if (chunk.supersedes) {
      const alreadyIndexed = links.some(
        l => l.target === chunk.supersedes && l.rel === 'supersedes'
      )
      if (!alreadyIndexed) {
        links.push({ target: chunk.supersedes, rel: 'supersedes' })
      }
    }

    return links
  }

  /** Total number of distinct targets tracked in the index. */
  get size(): number {
    return this.index.size
  }

  private addEdge(target: string, sourceId: string): void {
    if (!this.index.has(target)) {
      this.index.set(target, new Set())
    }
    this.index.get(target)!.add(sourceId)
  }
}
