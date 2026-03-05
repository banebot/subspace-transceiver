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
