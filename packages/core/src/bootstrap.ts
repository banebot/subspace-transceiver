/**
 * Iroh relay configuration for Subspace Transceiver.
 *
 * Replaces libp2p bootstrap peer configuration with Iroh relay server URLs.
 * Iroh uses relay servers for:
 * - DERP (Designated Encrypted Relay for Packets) — relay when direct fails
 * - STUN — UDP hole punching coordination
 * - Fallback connectivity for strict NATs
 *
 * The default Iroh relay infrastructure is provided by Iroh's public servers.
 * Custom relay servers can be specified via the SUBSPACE_RELAY_URL env var
 * or the `relayAddresses` option in network configuration.
 */

/**
 * Iroh public relay server URLs.
 * These are provided by the iroh team at n0.computer.
 */
export const IROH_PUBLIC_RELAYS = [
  'https://use1-1.relay.iroh.network.',
  'https://euw1-1.relay.iroh.network.',
  'https://aps1-1.relay.iroh.network.',
] as const

/**
 * Get relay URL(s) to use for this deployment.
 *
 * Priority:
 * 1. SUBSPACE_RELAY_URL env var (custom relay)
 * 2. Provided relay addresses (from daemon config)
 * 3. Default: use Iroh's built-in relay infrastructure
 *
 * @returns Relay URL string or undefined (use Iroh defaults)
 */
export function getRelayUrl(customAddresses?: string[]): string | undefined {
  if (process.env.SUBSPACE_RELAY_URL) {
    return process.env.SUBSPACE_RELAY_URL
  }
  if (customAddresses && customAddresses.length > 0) {
    return customAddresses[0]
  }
  // Return undefined → Iroh uses its built-in public relay infrastructure
  return undefined
}

/**
 * Trusted bootstrap peers (Iroh EndpointIds + optional addresses).
 * These are Iroh peer addresses that can bootstrap new peers into the network.
 * Format: "<EndpointId>" or "<EndpointId>/<IP>:<port>"
 */
export type BootstrapPeer = string

/**
 * Parse a bootstrap peer address string.
 * Returns the EndpointId and optional direct address.
 */
export function parseBootstrapPeer(addr: string): {
  endpointId: string
  directAddr?: string
} {
  const parts = addr.split('/')
  return {
    endpointId: parts[0],
    directAddr: parts.length > 1 ? parts.slice(1).join('/') : undefined,
  }
}
