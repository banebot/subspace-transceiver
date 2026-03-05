/**
 * Daemon configuration — load/save ~/.subspace/config.yaml.
 *
 * agentId precedence:
 *   1. SUBSPACE_AGENT_ID environment variable
 *   2. Value in config.yaml
 *   3. null → daemon will use its libp2p peer ID as agentId
 *
 * The 'unknown' agentId is explicitly prohibited — every chunk must carry
 * a meaningful provenance identifier.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'

export const SUBSPACE_DIR = join(homedir(), '.subspace')
export const CONFIG_PATH = join(SUBSPACE_DIR, 'config.yaml')
export const PID_PATH = join(SUBSPACE_DIR, 'daemon.pid')
export const IDENTITY_PATH = join(SUBSPACE_DIR, 'identity.key')
export const DEFAULT_PORT = 7432
export const DEFAULT_DATA_DIR = join(SUBSPACE_DIR, 'data')

export interface NetworkConfig {
  psk: string
  name?: string
}

/**
 * Security configuration — all limits enforced at ingest points
 * (daemon API, OrbitDB replication handler, blob protocol handler).
 */
export interface SecurityConfig {
  /**
   * Maximum chunks accepted from a single PeerId within `rateLimitWindowMs`.
   * Default: 100 chunks/hour.
   */
  maxChunksPerPeerPerWindow: number
  /** Rate limit window in milliseconds. Default: 3_600_000 (1 hour). */
  rateLimitWindowMs: number
  /**
   * Maximum byte size of the `content` field. Default: 65_536 (64KB).
   * Chunks exceeding this are rejected at ingest.
   */
  maxChunkContentBytes: number
  /**
   * Maximum byte size of `contentEnvelope.body`. Default: 262_144 (256KB).
   */
  maxEnvelopeBodyBytes: number
  /**
   * Maximum byte size of a blob received via the blob protocol.
   * Default: 10_485_760 (10MB).
   */
  maxBlobSizeBytes: number
  /**
   * Maximum total storage (in bytes) from any single PeerId.
   * Content from peers exceeding this quota is rejected.
   * Default: 104_857_600 (100MB).
   */
  maxStoragePerPeerBytes: number
  /**
   * Maximum total OrbitDB store size in bytes across all peers.
   * GC evicts crawled/replicated content when exceeded.
   * Default: 1_073_741_824 (1GB).
   */
  maxTotalStorageBytes: number
  /**
   * Minimum connected peer count for eclipse attack resistance.
   * Daemon logs a warning when below this threshold.
   * Default: 5.
   */
  minPeerConnections: number
  /**
   * Trusted bootstrap peers (multiaddrs) that are always kept connected.
   * Pinned peers can't be eclipsed away. Default: [].
   */
  trustedBootstrapPeers: string[]
  /**
   * If true, reject chunks without a valid Ed25519 signature.
   * Default: false (backward compatible — logs warning but allows unsigned).
   * Set to true for high-security deployments.
   */
  requireSignatures: boolean

  // ── Proof-of-work (TODO-4e34c409) ────────────────────────────────────────
  /**
   * Leading-zero bits required on chunk PoW stamps.
   * Default: 20 (~30ms to mine, prevents bulk content flooding).
   */
  powBitsForChunks: number
  /**
   * Leading-zero bits required on query/browse/manifest PoW stamps.
   * Default: 16 (~2ms to mine).
   */
  powBitsForRequests: number
  /**
   * Time window for PoW challenges (ms). Stamps are valid for current + previous window.
   * Default: 3_600_000 (1 hour).
   */
  powWindowMs: number
  /**
   * If true, reject chunks/requests without a valid PoW stamp.
   * Default: false (backward compatible — verifies if present, warns if absent).
   * Set to true once all agents in the network have been updated.
   */
  requirePoW: boolean
}

export interface SubscriptionConfig {
  /** GossipSub topics to subscribe to for auto-fetch */
  topics: string[]
  /** Specific peer IDs to subscribe to for auto-fetch */
  peers: string[]
}

/**
 * Epoch-based OrbitDB database rotation configuration.
 * Controls disk-space reclamation via time-windowed CRDT epoch rotation.
 * See packages/core/src/epoch-manager.ts for full design rationale.
 */
export interface EpochConfig {
  /**
   * Duration of each epoch in milliseconds.
   * Default: 604_800_000 (7 days).
   *
   * High-churn agents: 86_400_000 (1 day) with retainEpochs: 2
   * Archival agents: 2_592_000_000 (30 days) with retainEpochs: 3
   */
  epochDurationMs: number
  /**
   * Number of past epochs to retain as readable after rotation.
   * Total data visibility = (retainEpochs + 1) × epochDurationMs.
   * Default: 1 → 2 weeks total (current + 1 prior).
   *
   * Peers offline longer than retainEpochs × epochDurationMs will miss
   * data from dropped epochs. This is the explicit tradeoff for disk reclamation.
   */
  retainEpochs: number
  /**
   * Time before epoch end to start migrating permanent chunks (milliseconds).
   * Should be long enough for migration to complete before the epoch boundary.
   * Default: 3_600_000 (1 hour).
   */
  migrationLeadTimeMs: number
}

export const DEFAULT_EPOCH_CONFIG: EpochConfig = {
  epochDurationMs: 604_800_000,  // 7 days
  retainEpochs: 1,
  migrationLeadTimeMs: 3_600_000, // 1 hour
}

export interface DaemonConfig {
  port: number
  dataDir: string
  /** Agent identity string. Null if not configured — daemon uses peer ID as fallback. */
  agentId: string | null
  /** Display name for this agent's site (shown in discovery manifests). */
  displayName?: string
  networks: NetworkConfig[]
  security: SecurityConfig
  subscriptions: SubscriptionConfig
  /**
   * Epoch-based database rotation.
   * When enabled (epochDurationMs > 0), OrbitDB stores are split into time-windowed
   * epochs. Expired epochs are physically deleted, reclaiming disk space from CRDT
   * tombstones that would otherwise accumulate forever.
   */
  epochs: EpochConfig
  /**
   * Circuit relay v2 multiaddrs for NAT traversal.
   *
   * When empty (the default), the built-in RELAY_ADDRESSES from bootstrap.ts are used.
   * Set this to override — e.g. to point at your own relay server for reliable beta
   * connectivity, or to disable relay entirely (set to []).
   *
   * Example (run your own relay with @libp2p/relay-server on a VPS):
   *   relayAddresses:
   *     - /ip4/1.2.3.4/tcp/4001/p2p/QmYourRelayPeerId
   *
   * See https://github.com/libp2p/js-libp2p/tree/main/packages/relay-server for
   * instructions on running a relay node.
   */
  relayAddresses: string[]
}

export const DEFAULT_SECURITY: SecurityConfig = {
  maxChunksPerPeerPerWindow: 100,
  rateLimitWindowMs: 3_600_000,
  maxChunkContentBytes: 65_536,
  maxEnvelopeBodyBytes: 262_144,
  maxBlobSizeBytes: 10_485_760,
  maxStoragePerPeerBytes: 104_857_600,
  maxTotalStorageBytes: 1_073_741_824,
  minPeerConnections: 5,
  trustedBootstrapPeers: [],
  requireSignatures: false,
  // PoW defaults
  powBitsForChunks: 20,
  powBitsForRequests: 16,
  powWindowMs: 3_600_000,
  requirePoW: false,
}

const DEFAULTS: DaemonConfig = {
  port: DEFAULT_PORT,
  dataDir: DEFAULT_DATA_DIR,
  agentId: null,
  displayName: undefined,
  networks: [],
  security: DEFAULT_SECURITY,
  subscriptions: { topics: [], peers: [] },
  epochs: DEFAULT_EPOCH_CONFIG,
  relayAddresses: [],
}

/**
 * Load the daemon config from ~/.subspace/config.yaml.
 * Merges with defaults for any missing fields.
 * SUBSPACE_AGENT_ID env var takes priority over config file value.
 */
export async function loadConfig(): Promise<DaemonConfig> {
  let fileConfig: Partial<DaemonConfig> = {}

  try {
    const raw = await readFile(CONFIG_PATH, 'utf8')
    fileConfig = yamlParse(raw) ?? {}
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[subspace] Could not read config at ${CONFIG_PATH}:`, err)
    }
  }

  const config: DaemonConfig = {
    port: fileConfig.port ?? DEFAULTS.port,
    dataDir: fileConfig.dataDir ?? DEFAULTS.dataDir,
    agentId: process.env.SUBSPACE_AGENT_ID ?? fileConfig.agentId ?? null,
    displayName: fileConfig.displayName ?? DEFAULTS.displayName,
    networks: fileConfig.networks ?? DEFAULTS.networks,
    security: { ...DEFAULT_SECURITY, ...(fileConfig.security ?? {}) },
    subscriptions: { ...DEFAULTS.subscriptions, ...(fileConfig.subscriptions ?? {}) },
    epochs: { ...DEFAULT_EPOCH_CONFIG, ...(fileConfig.epochs ?? {}) },
    relayAddresses: fileConfig.relayAddresses ?? DEFAULTS.relayAddresses,
  }

  if (!config.agentId) {
    console.warn(
      '[subspace] WARNING: No SUBSPACE_AGENT_ID set — memory provenance will use ' +
        'peer ID as agentId. Set SUBSPACE_AGENT_ID=<your-model-id> for consistent provenance.'
    )
  }

  return config
}

/**
 * Save config to ~/.subspace/config.yaml.
 * Creates the directory if it does not exist.
 */
export async function saveConfig(config: DaemonConfig): Promise<void> {
  await mkdir(SUBSPACE_DIR, { recursive: true })
  await writeFile(CONFIG_PATH, yamlStringify(config), 'utf8')
}

/**
 * Ensure the ~/.subspace directory and default data dir exist.
 */
export async function ensureDirectories(config: DaemonConfig): Promise<void> {
  await mkdir(SUBSPACE_DIR, { recursive: true })
  await mkdir(config.dataDir, { recursive: true })
}
