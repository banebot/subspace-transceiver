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
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'

export const SUBSPACE_DIR = join(homedir(), '.subspace')
export const CONFIG_PATH = join(SUBSPACE_DIR, 'config.yaml')
/** @deprecated Use getPidPath(dataDir) for per-instance PID files */
export const PID_PATH = join(SUBSPACE_DIR, 'daemon.pid')
/** @deprecated Use getIdentityPath(dataDir) for per-instance identity files */
export const IDENTITY_PATH = join(SUBSPACE_DIR, 'identity.key')
export const DEFAULT_PORT = 7432
export const DEFAULT_DATA_DIR = join(SUBSPACE_DIR, 'data')

/**
 * Return the config file path for a specific dataDir instance.
 * Each daemon instance stores its config alongside its data, so multiple
 * daemons can run independently without sharing network/PSK state.
 * Production default dataDir is ~/.subspace/data → config at ~/.subspace/data/config.yaml.
 */
export function getConfigPath(dataDir: string): string {
  return join(dataDir, 'config.yaml')
}

/**
 * Return the PID file path for a specific dataDir instance.
 * Each daemon instance stores its PID alongside its data, so multiple
 * daemons with different dataDirs can run on the same machine without
 * conflicting on a global PID file.
 */
export function getPidPath(dataDir: string): string {
  return join(dataDir, 'daemon.pid')
}

/**
 * Return the identity key path for a specific dataDir instance.
 * Storing the identity inside dataDir ensures each daemon instance gets a
 * unique Ed25519 keypair, which is required for distinct libp2p PeerIds.
 * The default production dataDir is ~/.subspace/data, so the identity lives
 * at ~/.subspace/data/identity.key (previously ~/.subspace/identity.key).
 */
export function getIdentityPath(dataDir: string): string {
  return join(dataDir, 'identity.key')
}

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
  maxChunksPerPeerPerWindow: 10_000,
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
 * Load the daemon config from the per-instance config file.
 * The config file is stored in the dataDir so each daemon instance has
 * independent network/PSK state — no cross-contamination between instances.
 * Merges with defaults for any missing fields.
 * SUBSPACE_AGENT_ID env var takes priority over config file value.
 */
export async function loadConfig(): Promise<DaemonConfig> {
  // Determine dataDir early so we can locate the per-instance config file.
  // We need the dataDir to find the config, but the config also contains the
  // dataDir setting — break the circularity using the env var or global default.
  const earlyDataDir = process.env.SUBSPACE_DATA_DIR ?? DEFAULT_DATA_DIR
  const instanceConfigPath = getConfigPath(earlyDataDir)

  let fileConfig: Partial<DaemonConfig> = {}

  // When SUBSPACE_DATA_DIR is explicitly set (e.g. in tests) use ONLY the
  // per-instance config so each daemon is fully isolated from all others.
  // Without an explicit dataDir we also try the legacy global path for
  // backward-compat with existing production installations.
  const configPaths: string[] = process.env.SUBSPACE_DATA_DIR
    ? [instanceConfigPath]
    : [instanceConfigPath, CONFIG_PATH]

  for (const cfgPath of configPaths) {
    try {
      const raw = await readFile(cfgPath, 'utf8')
      fileConfig = yamlParse(raw) ?? {}
      break
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[subspace] Could not read config at ${cfgPath}:`, err)
      }
    }
  }

  const config: DaemonConfig = {
    port: fileConfig.port ?? DEFAULTS.port,
    dataDir: process.env.SUBSPACE_DATA_DIR ?? fileConfig.dataDir ?? DEFAULTS.dataDir,
    agentId: process.env.SUBSPACE_AGENT_ID ?? fileConfig.agentId ?? null,
    displayName: fileConfig.displayName ?? DEFAULTS.displayName,
    networks: fileConfig.networks ?? DEFAULTS.networks,
    security: {
      ...DEFAULT_SECURITY,
      ...(fileConfig.security ?? {}),
      // Env var overrides for testability (shorter windows enable fast test cycles)
      ...(process.env.SUBSPACE_RATE_LIMIT_WINDOW_MS
        ? { rateLimitWindowMs: parseInt(process.env.SUBSPACE_RATE_LIMIT_WINDOW_MS, 10) }
        : {}),
      ...(process.env.SUBSPACE_MAX_CHUNKS_PER_PEER
        ? { maxChunksPerPeerPerWindow: parseInt(process.env.SUBSPACE_MAX_CHUNKS_PER_PEER, 10) }
        : {}),
    },
    subscriptions: { ...DEFAULTS.subscriptions, ...(fileConfig.subscriptions ?? {}) },
    epochs: {
      ...DEFAULT_EPOCH_CONFIG,
      ...(fileConfig.epochs ?? {}),
      ...(process.env.SUBSPACE_EPOCH_DURATION_MS
        ? { epochDurationMs: parseInt(process.env.SUBSPACE_EPOCH_DURATION_MS, 10) }
        : {}),
    },
    // SUBSPACE_RELAY_ADDRS="" disables relay (empty string → empty array)
    // SUBSPACE_RELAY_ADDRS="addr1,addr2" overrides built-in relay list
    relayAddresses: process.env.SUBSPACE_RELAY_ADDRS !== undefined
      ? process.env.SUBSPACE_RELAY_ADDRS.split(',').filter(Boolean)
      : (fileConfig.relayAddresses ?? DEFAULTS.relayAddresses),
  }

  // SUBSPACE_BOOTSTRAP_ADDRS overrides the hardcoded BOOTSTRAP_ADDRESSES in node.ts.
  // Set via env so all created libp2p nodes pick it up without threading it through config.
  // This is the primary mechanism for running tests without the public IPFS network.

  if (!config.agentId) {
    console.warn(
      '[subspace] WARNING: No SUBSPACE_AGENT_ID set — memory provenance will use ' +
        'peer ID as agentId. Set SUBSPACE_AGENT_ID=<your-agent-name> for consistent provenance.'
    )
  }

  return config
}

/**
 * Save config to the per-instance config file in the daemon's dataDir.
 * Each daemon has its own config so multiple instances don't share PSK state.
 * File is written with mode 0o600 (owner-read-write only) because it contains
 * PSK secrets that must not be world-readable.
 */
export async function saveConfig(config: DaemonConfig): Promise<void> {
  const configPath = getConfigPath(config.dataDir)
  await mkdir(config.dataDir, { recursive: true })
  await writeFile(configPath, yamlStringify(config), { encoding: 'utf8', mode: 0o600 })
  // chmod after write handles the case where the file already existed with
  // looser permissions (writeFile mode option only applies on creation).
  await chmod(configPath, 0o600)
}

/**
 * Ensure the ~/.subspace directory and default data dir exist.
 * The subspace directory is created with 0o700 so only the owner can list it.
 */
export async function ensureDirectories(config: DaemonConfig): Promise<void> {
  await mkdir(SUBSPACE_DIR, { recursive: true, mode: 0o700 })
  await mkdir(config.dataDir, { recursive: true })
}
