/**
 * TypeScript bridge to the Rust Iroh engine subprocess.
 *
 * The engine is a compiled Rust binary (`subspace-engine`) that runs as a
 * child process and communicates via newline-delimited JSON-RPC over stdio:
 *   - stdin  → RPC requests from Node.js to engine
 *   - stdout ← RPC responses + notifications from engine
 *   - stderr ← engine log output (written to the daemon logger)
 *
 * ## Usage
 * ```ts
 * const bridge = new EngineBridge({ enginePath: '/path/to/subspace-engine' })
 * await bridge.start()
 * const { nodeId } = await bridge.engineStart({ seedHex: identity.key })
 * await bridge.gossipJoin({ topicHex: '...', bootstrapPeers: [] })
 * bridge.onGossipMessage(msg => console.log('received:', msg))
 * await bridge.engineStop()
 * ```
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Wire types (must match Rust rpc.rs)
// ---------------------------------------------------------------------------

interface RpcRequest {
  id: string
  method: string
  params: unknown
}

interface RpcResponse {
  id: string
  result?: unknown
  error?: { code: number; message: string }
}

interface RpcNotification {
  method: string
  params: unknown
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface EngineStartResult {
  nodeId: string
  addrs: string[]
}

export interface GossipMessage {
  topicHex: string
  payload: string  // base64-encoded
  fromNodeId: string
}

export interface PeerConnectedEvent {
  nodeId: string
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface EngineBridgeOptions {
  /** Path to the `subspace-engine` binary. Defaults to nearest `target/debug/subspace-engine`. */
  enginePath?: string
  /** Log engine stderr to Node.js stderr (default: true in dev, false in prod) */
  logStderr?: boolean
}

// ---------------------------------------------------------------------------
// EngineBridge
// ---------------------------------------------------------------------------

/**
 * Manages the Rust engine subprocess and provides a typed async API.
 */
export class EngineBridge extends EventEmitter {
  private proc: ChildProcess | null = null
  private pending = new Map<string, {
    resolve: (value: unknown) => void
    reject: (reason: unknown) => void
  }>()
  private started = false
  private readonly enginePath: string
  private readonly logStderr: boolean

  constructor(options: EngineBridgeOptions = {}) {
    super()
    this.enginePath = options.enginePath ?? EngineBridge.defaultEnginePath()
    this.logStderr = options.logStderr ?? (process.env.NODE_ENV !== 'production')
  }

  /**
   * Resolve the default engine binary path.
   * Looks for: (1) SUBSPACE_ENGINE_PATH env var, (2) adjacent dist/ binary,
   * (3) Cargo debug build output.
   */
  static defaultEnginePath(): string {
    if (process.env.SUBSPACE_ENGINE_PATH) {
      return process.env.SUBSPACE_ENGINE_PATH
    }

    // Relative to this file (packages/core/src/engine-bridge.ts)
    const here = fileURLToPath(new URL('.', import.meta.url))
    const candidates = [
      // Production: next to the compiled JS
      join(here, '..', 'bin', 'subspace-engine'),
      // Development: Cargo debug build
      join(here, '..', '..', '..', 'packages', 'engine', 'target', 'debug', 'subspace-engine'),
      // Monorepo root cargo debug build
      join(here, '..', '..', '..', '..', 'packages', 'engine', 'target', 'debug', 'subspace-engine'),
    ]

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }

    // Return the debug build path even if it doesn't exist yet — we'll get a
    // useful error when trying to spawn it.
    return candidates[1]
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the engine subprocess and wait for the `engine.ready` notification.
   * Must be called before any RPC methods.
   */
  async start(timeoutMs = 10_000): Promise<void> {
    if (this.started) return

    if (!existsSync(this.enginePath)) {
      throw new Error(
        `Iroh engine binary not found at: ${this.enginePath}\n` +
        `Run: cd packages/engine && cargo build`
      )
    }

    this.proc = spawn(this.enginePath, [], {
      stdio: ['pipe', 'pipe', this.logStderr ? 'inherit' : 'ignore'],
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG ?? 'subspace_engine=info,warn',
      },
    })

    this.proc.on('exit', (code, signal) => {
      this.emit('exit', { code, signal })
      // Reject all pending RPC calls
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`Engine process exited with code=${code}, signal=${signal}`))
      }
      this.pending.clear()
      this.proc = null
      this.started = false
    })

    this.proc.on('error', (err) => {
      this.emit('error', err)
    })

    // Parse stdout as line-delimited JSON
    const rl = createInterface({ input: this.proc.stdout! })
    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        this.handleLine(line)
      } catch (err) {
        console.error('[engine-bridge] Failed to parse engine output:', line, err)
      }
    })

    // Wait for the engine.ready notification
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Engine did not send engine.ready within ${timeoutMs}ms`))
      }, timeoutMs)

      const onReady = () => {
        clearTimeout(timer)
        this.off('engine.ready', onReady)
        resolve()
      }
      this.once('engine.ready', onReady)
    })

    this.started = true
  }

  /**
   * Stop the engine subprocess cleanly.
   */
  async stop(): Promise<void> {
    if (!this.proc) return
    try {
      await this.call<{ stopped: boolean }>('engine.stop', {})
    } catch {
      // Ignore errors during shutdown
    }
    this.proc.kill('SIGTERM')
    this.proc = null
    this.started = false
  }

  // ---------------------------------------------------------------------------
  // Engine RPC methods
  // ---------------------------------------------------------------------------

  /**
   * Start the Iroh endpoint with the given Ed25519 seed.
   * The seed is the same 32-byte secret as the agent's identity key.
   */
  async engineStart(params: { seedHex: string; relayUrl?: string }): Promise<EngineStartResult> {
    return this.call<EngineStartResult>('engine.start', {
      seed_hex: params.seedHex,
      ...(params.relayUrl ? { relay_url: params.relayUrl } : {}),
    })
  }

  /** Get the engine's current NodeId (Iroh EndpointId as string). */
  async engineNodeId(): Promise<string> {
    const result = await this.call<{ nodeId: string }>('engine.nodeId', {})
    return result.nodeId
  }

  /** Get the engine's current listening addresses. */
  async engineAddrs(): Promise<string[]> {
    const result = await this.call<{ addrs: string[] }>('engine.addrs', {})
    return result.addrs
  }

  /** List connected peers. */
  async peerList(): Promise<string[]> {
    const result = await this.call<{ peers: string[] }>('engine.peers', {})
    return result.peers
  }

  // ---------------------------------------------------------------------------
  // Gossip RPC methods
  // ---------------------------------------------------------------------------

  /**
   * Join a gossip topic to receive and send broadcast messages.
   * @param topicHex  32-byte topic ID as hex
   * @param bootstrapPeers  Initial peer EndpointIds to connect to
   */
  async gossipJoin(params: { topicHex: string; bootstrapPeers?: string[] }): Promise<void> {
    await this.call('gossip.join', {
      topic_hex: params.topicHex,
      bootstrap_peers: params.bootstrapPeers ?? [],
    })
  }

  /**
   * Leave a gossip topic (drop our subscription).
   */
  async gossipLeave(topicHex: string): Promise<void> {
    await this.call('gossip.leave', { topic_hex: topicHex })
  }

  /**
   * Broadcast a message to all peers subscribed to a topic.
   * @param topicHex  32-byte topic ID as hex
   * @param payload   Raw bytes to broadcast
   */
  async gossipBroadcast(topicHex: string, payload: Uint8Array): Promise<void> {
    const payloadB64 = Buffer.from(payload).toString('base64')
    await this.call('gossip.broadcast', {
      topic_hex: topicHex,
      payload_b64: payloadB64,
    })
  }

  // ---------------------------------------------------------------------------
  // Event subscriptions
  // ---------------------------------------------------------------------------

  /**
   * Register a callback for gossip messages received from peers.
   */
  onGossipMessage(handler: (msg: GossipMessage) => void): () => void {
    this.on('gossip.received', handler)
    return () => this.off('gossip.received', handler)
  }

  /**
   * Register a callback for peer connection events.
   */
  onPeerConnected(handler: (event: PeerConnectedEvent) => void): () => void {
    this.on('peer.connected', handler)
    return () => this.off('peer.connected', handler)
  }

  /**
   * Register a callback for peer disconnection events.
   */
  onPeerDisconnected(handler: (event: PeerConnectedEvent) => void): () => void {
    this.on('peer.disconnected', handler)
    return () => this.off('peer.disconnected', handler)
  }

  /** True if the engine subprocess is running. */
  get isRunning(): boolean {
    return this.started && this.proc !== null
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private handleLine(line: string): void {
    const msg = JSON.parse(line) as RpcResponse | RpcNotification

    // Notification: has `method` but no `id`
    if ('method' in msg && !('id' in msg)) {
      const notif = msg as RpcNotification
      this.handleNotification(notif)
      return
    }

    // Response: has `id`
    if ('id' in msg) {
      const resp = msg as RpcResponse
      const pending = this.pending.get(resp.id)
      if (!pending) {
        console.warn('[engine-bridge] No pending call for id:', resp.id)
        return
      }
      this.pending.delete(resp.id)
      if (resp.error) {
        pending.reject(new Error(`RPC error ${resp.error.code}: ${resp.error.message}`))
      } else {
        pending.resolve(resp.result)
      }
    }
  }

  private handleNotification(notif: RpcNotification): void {
    switch (notif.method) {
      case 'engine.ready':
        this.emit('engine.ready')
        break
      case 'gossip.received': {
        const params = notif.params as {
          topic_hex: string
          payload_b64: string
          from_node_id: string
        }
        const msg: GossipMessage = {
          topicHex: params.topic_hex,
          payload: params.payload_b64,
          fromNodeId: params.from_node_id,
        }
        this.emit('gossip.received', msg)
        break
      }
      case 'peer.connected':
        this.emit('peer.connected', notif.params)
        break
      case 'peer.disconnected':
        this.emit('peer.disconnected', notif.params)
        break
      default:
        this.emit(notif.method, notif.params)
    }
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    if (!this.proc || !this.proc.stdin) {
      throw new Error('Engine is not running. Call bridge.start() first.')
    }

    const id = randomUUID()
    const request: RpcRequest = { id, method, params }

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      })

      const line = JSON.stringify(request) + '\n'
      this.proc!.stdin!.write(line, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(new Error(`Failed to write to engine stdin: ${err.message}`))
        }
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Singleton factory
// ---------------------------------------------------------------------------

let _defaultBridge: EngineBridge | null = null

/**
 * Get or create the default EngineBridge singleton.
 * Used by the daemon to share a single engine subprocess.
 */
export function getDefaultBridge(options?: EngineBridgeOptions): EngineBridge {
  if (!_defaultBridge) {
    _defaultBridge = new EngineBridge(options)
  }
  return _defaultBridge
}

/**
 * Reset the default bridge singleton (for testing only).
 */
export function _resetDefaultBridge(): void {
  _defaultBridge = null
}
