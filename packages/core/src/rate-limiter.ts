/**
 * Sliding-window rate limiter for per-peer ingest control.
 *
 * Tracks event timestamps for each PeerId in a sliding window.
 * Peers that exceed the window limit can be soft-banned for a configurable
 * duration — they are ignored without disconnection (graceful degradation).
 *
 * All state is in-memory and resets on daemon restart. This is intentional:
 * transient misbehavior does not permanently penalize peers.
 */

export interface RateLimiterOptions {
  /** Maximum number of events allowed within the window */
  maxPerWindow: number
  /** Window duration in milliseconds */
  windowMs: number
}

interface PeerWindow {
  /** Sorted ascending list of recent event timestamps within the window */
  timestamps: number[]
  /** Whether the peer is currently soft-banned */
  softBanned: boolean
  /** Timestamp when the soft-ban expires (0 = not banned) */
  bannedUntil: number
}

export class RateLimiter {
  private readonly maxPerWindow: number
  private readonly windowMs: number
  private readonly peers = new Map<string, PeerWindow>()

  constructor(opts: RateLimiterOptions) {
    this.maxPerWindow = opts.maxPerWindow
    this.windowMs = opts.windowMs
  }

  /**
   * Check whether a peer is within rate limits.
   * Returns `true` if the event is allowed, `false` if the peer is over-limit
   * or currently soft-banned.
   *
   * Does NOT record the event — call `record()` separately after this check.
   */
  check(peerId: string): boolean {
    const now = Date.now()
    const window = this.getOrCreate(peerId)

    // Soft-ban check
    if (window.softBanned) {
      if (now < window.bannedUntil) return false
      window.softBanned = false  // Ban expired
      window.bannedUntil = 0
    }

    this.prune(window, now)
    return window.timestamps.length < this.maxPerWindow
  }

  /**
   * Record an event for a peer.
   * Call after `check()` returns true.
   */
  record(peerId: string): void {
    const now = Date.now()
    const window = this.getOrCreate(peerId)
    this.prune(window, now)
    window.timestamps.push(now)
  }

  /**
   * Apply a soft ban to a peer for the specified duration (ms).
   * Banned peers fail `check()` without consuming quota.
   */
  softBan(peerId: string, durationMs: number): void {
    const window = this.getOrCreate(peerId)
    window.softBanned = true
    window.bannedUntil = Date.now() + durationMs
  }

  /**
   * Returns true if the peer is currently soft-banned.
   */
  isBanned(peerId: string): boolean {
    const window = this.peers.get(peerId)
    if (!window?.softBanned) return false
    if (Date.now() >= window.bannedUntil) {
      window.softBanned = false
      window.bannedUntil = 0
      return false
    }
    return true
  }

  /**
   * Return the current event count for a peer within the active window.
   */
  getCount(peerId: string): number {
    const window = this.peers.get(peerId)
    if (!window) return 0
    this.prune(window, Date.now())
    return window.timestamps.length
  }

  /**
   * Clear all state for a peer (e.g. after a manual reputation reset).
   */
  reset(peerId: string): void {
    this.peers.delete(peerId)
  }

  private getOrCreate(peerId: string): PeerWindow {
    if (!this.peers.has(peerId)) {
      this.peers.set(peerId, { timestamps: [], softBanned: false, bannedUntil: 0 })
    }
    return this.peers.get(peerId)!
  }

  /** Remove timestamps older than the window from the front of the list. */
  private prune(window: PeerWindow, now: number): void {
    const cutoff = now - this.windowMs
    let i = 0
    while (i < window.timestamps.length && window.timestamps[i] < cutoff) i++
    if (i > 0) window.timestamps.splice(0, i)
  }
}
