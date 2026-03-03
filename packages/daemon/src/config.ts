/**
 * Daemon configuration — load/save ~/.agent-net/config.yaml.
 *
 * agentId precedence:
 *   1. AGENT_NET_AGENT_ID environment variable
 *   2. Value in config.yaml
 *   3. null → daemon will log a warning and use its libp2p peer ID as agentId
 *
 * The 'unknown' agentId is explicitly prohibited — every chunk must carry
 * a meaningful provenance identifier.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'

export const AGENT_NET_DIR = join(homedir(), '.agent-net')
export const CONFIG_PATH = join(AGENT_NET_DIR, 'config.yaml')
export const PID_PATH = join(AGENT_NET_DIR, 'daemon.pid')
export const DEFAULT_PORT = 7432
export const DEFAULT_DATA_DIR = join(AGENT_NET_DIR, 'data')

export interface NetworkConfig {
  psk: string
  name?: string
}

export interface DaemonConfig {
  port: number
  dataDir: string
  /** Agent identity string. Null if not configured — daemon uses peer ID as fallback. */
  agentId: string | null
  networks: NetworkConfig[]
}

const DEFAULTS: DaemonConfig = {
  port: DEFAULT_PORT,
  dataDir: DEFAULT_DATA_DIR,
  agentId: null,
  networks: [],
}

/**
 * Load the daemon config from ~/.agent-net/config.yaml.
 * Merges with defaults for any missing fields.
 * AGENT_NET_AGENT_ID env var takes priority over config file value.
 */
export async function loadConfig(): Promise<DaemonConfig> {
  let fileConfig: Partial<DaemonConfig> = {}

  try {
    const raw = await readFile(CONFIG_PATH, 'utf8')
    fileConfig = yamlParse(raw) ?? {}
  } catch (err: unknown) {
    // File not found is fine — use defaults
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[agent-net] Could not read config at ${CONFIG_PATH}:`, err)
    }
  }

  const config: DaemonConfig = {
    port: fileConfig.port ?? DEFAULTS.port,
    dataDir: fileConfig.dataDir ?? DEFAULTS.dataDir,
    agentId: process.env.AGENT_NET_AGENT_ID ?? fileConfig.agentId ?? null,
    networks: fileConfig.networks ?? DEFAULTS.networks,
  }

  if (!config.agentId) {
    console.warn(
      '[agent-net] WARNING: No AGENT_NET_AGENT_ID set — memory provenance will use ' +
        'peer ID as agentId. Set AGENT_NET_AGENT_ID=<your-model-id> for consistent provenance.'
    )
  }

  return config
}

/**
 * Save config to ~/.agent-net/config.yaml.
 * Creates the directory if it does not exist.
 */
export async function saveConfig(config: DaemonConfig): Promise<void> {
  await mkdir(AGENT_NET_DIR, { recursive: true })
  await writeFile(CONFIG_PATH, yamlStringify(config), 'utf8')
}

/**
 * Ensure the ~/.agent-net directory and default data dir exist.
 */
export async function ensureDirectories(config: DaemonConfig): Promise<void> {
  await mkdir(AGENT_NET_DIR, { recursive: true })
  await mkdir(config.dataDir, { recursive: true })
}
