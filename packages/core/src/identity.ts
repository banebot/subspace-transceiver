/**
 * Persistent per-agent Ed25519 identity for Subspace Transceiver.
 *
 * DESIGN INTENT
 * ─────────────
 * The PSK governs NETWORK ACCESS — who may connect to a libp2p swarm.
 * The identity keypair governs CONTENT AUTHORSHIP — who published what,
 * and provides each node with a unique, stable libp2p PeerId.
 *
 * These are intentionally separate:
 *   - One agent identity can participate in many PSK networks.
 *   - Rotating the PSK does NOT change agent identity or authorship history.
 *
 * WHY THIS MATTERS FOR THE ORIGINAL IMPLEMENTATION
 * ─────────────────────────────────────────────────
 * The original code derived the libp2p private key from the PSK, meaning
 * every node on the same PSK network had the SAME PeerId. This breaks DHT
 * peer routing (routing tables require unique PeerIds) and makes chunk
 * signing meaningless (any peer could forge content "as" any other).
 *
 * STORAGE
 * ───────
 * The 32-byte Ed25519 seed is stored at <identityPath> (default:
 * ~/.subspace/identity.key) with mode 0o600 (owner-read only).
 * The seed is regenerated once on first run and never changed.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { keys } from '@libp2p/crypto'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import type { PrivateKey } from '@libp2p/interface'

export const DEFAULT_IDENTITY_PATH = join(homedir(), '.subspace', 'identity.key')

export interface AgentIdentity {
  /** Ed25519 private key — use for signing chunks and as libp2p node identity */
  privateKey: PrivateKey
  /** libp2p PeerId string (base58btc) derived from privateKey */
  peerId: string
}

/**
 * Load the agent's persistent Ed25519 identity from disk, or generate and
 * save a new one if none exists.
 *
 * Idempotent — repeated calls with the same path always return the same identity.
 *
 * @param identityPath  Path to the 32-byte seed file (default: ~/.subspace/identity.key)
 */
export async function loadOrCreateIdentity(
  identityPath: string = DEFAULT_IDENTITY_PATH
): Promise<AgentIdentity> {
  await mkdir(dirname(identityPath), { recursive: true })

  let seed: Buffer

  if (existsSync(identityPath)) {
    seed = await readFile(identityPath)
    if (seed.length !== 32) {
      // Corrupted file — regenerate
      console.warn(
        `[subspace] Identity file at ${identityPath} is corrupt (${seed.length} bytes, expected 32). Regenerating.`
      )
      seed = Buffer.from(randomBytes(32))
      await writeFile(identityPath, seed, { mode: 0o600 })
    }
  } else {
    seed = Buffer.from(randomBytes(32))
    await writeFile(identityPath, seed, { mode: 0o600 })
    console.log(`[subspace] Generated new agent identity. Stored at ${identityPath}`)
  }

  const privateKey = await keys.generateKeyPairFromSeed('Ed25519', seed)
  const peerId = peerIdFromPrivateKey(privateKey).toString()

  return { privateKey, peerId }
}
