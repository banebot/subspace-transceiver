/**
 * Query filtering and HEAD-of-chain resolution for Subspace Transceiver memory.
 *
 * Write model: APPEND-ONLY with supersedes chains.
 * A chain looks like: [ChunkA] <- [ChunkB (supersedes: A)] <- [ChunkC (supersedes: B)]
 * The HEAD is ChunkC — the most recent version in the chain.
 *
 * Fork tie-breaking rule: if resolveHeads encounters multiple chunks with no
 * superseder (concurrent forks — e.g. two agents updated same chunk offline),
 * the chunk with the highest source.timestamp is chosen as HEAD.
 * This rule is deterministic and converges on all peers.
 */

import type { MemoryChunk, MemoryQuery } from './schema.js'

// ---------------------------------------------------------------------------
// Filter predicate builder
// ---------------------------------------------------------------------------

/**
 * Build a filter predicate from a MemoryQuery.
 * The predicate returns true for chunks that match ALL specified query fields.
 * Tombstoned and TTL-expired chunks are always filtered out.
 */
export function buildOrbitFilter(q: MemoryQuery): (doc: MemoryChunk) => boolean {
  const now = Date.now()
  return (doc: MemoryChunk): boolean => {
    // Always exclude tombstones
    if (doc._tombstone) return false
    // Always exclude TTL-expired chunks
    if (doc.ttl !== undefined && doc.ttl < now) return false

    if (q.type !== undefined && doc.type !== q.type) return false
    if (q.namespace !== undefined && doc.namespace !== q.namespace) return false
    if (q.project !== undefined && doc.source.project !== q.project) return false
    // PeerId namespace filter — matches publishing agent
    if (q.peerId !== undefined && doc.source.peerId !== q.peerId) return false
    // Collection filter
    if (q.collection !== undefined && doc.collection !== q.collection) return false
    // Content format filter
    if (q.contentFormat !== undefined && doc.contentEnvelope?.format !== q.contentFormat) return false
    if (q.minConfidence !== undefined && doc.confidence < q.minConfidence) return false
    if (q.since !== undefined && doc.source.timestamp < q.since) return false
    if (q.until !== undefined && doc.source.timestamp > q.until) return false

    // Topic matching: chunk must include ALL requested topics
    if (q.topics !== undefined && q.topics.length > 0) {
      const chunkTopics = new Set(doc.topic.map(t => t.toLowerCase()))
      const allMatch = q.topics.every(t => chunkTopics.has(t.toLowerCase()))
      if (!allMatch) return false
    }

    return true
  }
}

// ---------------------------------------------------------------------------
// HEAD-of-chain resolution
// ---------------------------------------------------------------------------

/**
 * Given a flat list of chunks, return only the HEADs — chunks that are NOT
 * superseded by any other chunk in the list.
 *
 * A chunk C is a HEAD if no other chunk D exists where D.supersedes === C.id.
 *
 * Fork tie-breaking: if multiple chunks share no superseder (concurrent fork),
 * the one with the highest source.timestamp wins. This is deterministic and
 * converges on all peers.
 */
export function resolveHeads(chunks: MemoryChunk[]): MemoryChunk[] {
  if (chunks.length === 0) return []

  // Build a set of all chunk IDs that are superseded by something
  const supersededIds = new Set<string>()
  for (const chunk of chunks) {
    if (chunk.supersedes) {
      supersededIds.add(chunk.supersedes)
    }
  }

  // HEADs are chunks not in the superseded set (and not tombstoned)
  const heads = chunks.filter(c => !supersededIds.has(c.id) && !c._tombstone)

  // Group heads by their chain root to detect forks, then pick winner by timestamp
  // A fork occurs when two+ non-superseded chunks belong to the same logical chain.
  // We detect forks by finding chunks that have the same supersedes target.
  // Simple approach: group by supersedes value; if a group has >1, keep highest timestamp.
  const supersedesGroups = new Map<string | undefined, MemoryChunk[]>()
  for (const head of heads) {
    const key = head.supersedes ?? head.id // unique key per chain root
    if (!supersedesGroups.has(key)) {
      supersedesGroups.set(key, [])
    }
    supersedesGroups.get(key)!.push(head)
  }

  const result: MemoryChunk[] = []
  for (const group of supersedesGroups.values()) {
    if (group.length === 1) {
      result.push(group[0])
    } else {
      // Fork detected — pick the chunk with the highest source.timestamp
      const winner = group.reduce((best, c) =>
        c.source.timestamp > best.source.timestamp ? c : best
      )
      result.push(winner)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Combined query application
// ---------------------------------------------------------------------------

/**
 * Apply a MemoryQuery to a flat list of chunks:
 * 1. Filter by query predicates (type, namespace, topics, etc.)
 * 2. Resolve HEADs (remove superseded chunks)
 * 3. Sort by source.timestamp descending (newest first)
 * 4. Apply limit
 */
export function applyQuery(chunks: MemoryChunk[], q: MemoryQuery): MemoryChunk[] {
  const filter = buildOrbitFilter(q)
  const filtered = chunks.filter(filter)
  const heads = resolveHeads(filtered)
  const sorted = heads.sort((a, b) => b.source.timestamp - a.source.timestamp)
  if (q.limit !== undefined && q.limit > 0) {
    return sorted.slice(0, q.limit)
  }
  return sorted
}
