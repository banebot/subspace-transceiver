/**
 * Network join/leave orchestration for Subspace Transceiver.
 *
 * A "network" is defined by a PSK. All peers with the same PSK share:
 * - The same DHT announcement key (peer discovery)
 * - The same GossipSub topic (OrbitDB CRDT replication channel)
 * - The same envelope encryption key (message privacy)
 * - The same libp2p private network PSK (connection filter)
 *
 * Each node has a UNIQUE identity keypair (from identity.ts) that is
 * separate from the PSK. The PSK governs network access; the identity
 * governs content authorship and PeerId uniqueness.
 *
 * Each network has TWO namespaces:
 * - 'skill'  — portable across projects (global agent knowledge)
 * - 'project' — scoped to a specific project/repo
 *
 * Internal NetworkSession holds live references (Libp2p node, stores, discovery).
 * External NetworkInfoDTO is serialisable and safe for API responses.
 */
import { deriveNetworkKeys, validatePSK } from './crypto.js';
import { createLibp2pNode, derivePeerId } from './node.js';
import { createOrbitDBContext } from './orbitdb-store.js';
import { EpochManager, DEFAULT_EPOCH_CONFIG } from './epoch-manager.js';
import { BacklinkIndex } from './backlink-index.js';
import { DiscoveryManager } from './discovery.js';
import { NetworkError, ErrorCode } from './errors.js';
import path from 'node:path';
import crypto from 'node:crypto';
// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------
/**
 * Derive a stable network ID from a PSK.
 * Uses SHA-256(PSK) as a fingerprint — does not expose the PSK itself.
 */
export function deriveNetworkId(psk) {
    return crypto.createHash('sha256').update(psk, 'utf8').digest('hex');
}
/**
 * Derive a PSK-specific Ed25519 private key from the agent's identity key.
 *
 * WHY: Each daemon process runs a global libp2p node AND one libp2p node per
 * PSK network — all using the same agent private key → same PeerId.  mDNS
 * then advertises the SAME PeerId on multiple TCP ports (global port + PSK
 * port).  When peers try to dial using the query protocol they may connect to
 * the wrong port (the global node's port), causing "Protocol not supported".
 *
 * FIX: Give each PSK session its own deterministic libp2p key so mDNS
 * advertises distinct PeerIds for the global node and each PSK node.  The
 * derived key is HKDF(agentKey, salt="subspace:psk-peer-id:v1", info=psk).
 * Content signatures still use the agent's global key (source.peerId is the
 * agent's global PeerId, not the PSK PeerId).
 */
async function derivePskPrivateKey(agentPrivateKey, psk) {
    const { generateKeyPairFromSeed } = await import('@libp2p/crypto/keys');
    const salt = Buffer.from('subspace:psk-peer-id:v1');
    const ikm = Buffer.from(agentPrivateKey.raw);
    const info = Buffer.from(psk);
    // HKDF-extract: prk = HMAC-SHA256(salt, ikm)
    const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
    // HKDF-expand: okm = HMAC-SHA256(prk, info || 0x01) — first block
    const okm = crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
    // Generate Ed25519 key pair from the 32-byte seed
    return generateKeyPairFromSeed('Ed25519', okm);
}
/**
 * Join (or create) a network identified by the given PSK.
 * Starting a node, initialising OrbitDB stores, and connecting to peers
 * all happen here. Returns a live NetworkSession.
 *
 * @param psk             The pre-shared key for this network.
 * @param agentPrivateKey Persistent agent identity key (from loadOrCreateIdentity).
 * @param options         Network join options.
 */
export async function joinNetwork(psk, agentPrivateKey, options) {
    validatePSK(psk);
    const networkKeys = deriveNetworkKeys(psk);
    const networkId = deriveNetworkId(psk);
    const networkDataDir = path.join(options.dataDir, 'networks', networkId);
    const localPeerId = derivePeerId(agentPrivateKey);
    // Helper: detect "Database failed to open" LevelDB LOCK errors so we can retry.
    const isDbLockError = (err) => {
        const msg = String(err);
        return msg.includes('Database failed to open') || msg.includes('LOCK') || msg.includes('ERR_OPEN_FAILED');
    };
    let node;
    let pruner = null;
    let ctx;
    try {
        // Derive a PSK-specific libp2p key so the PSK node has a different PeerId
        // from the global node.  This avoids mDNS address confusion where two
        // nodes with the same PeerId advertise on different TCP ports and peers
        // dial the wrong port for the query protocol.
        const pskPrivateKey = await derivePskPrivateKey(agentPrivateKey, psk);
        ({ node, pruner } = await createLibp2pNode(pskPrivateKey, {
            port: options.port,
            minConnections: options.minConnections,
            maxConnections: options.maxConnections,
            trustedBootstrapPeers: options.trustedBootstrapPeers,
            relayAddresses: options.relayAddresses,
        }));
        // Create a single Helia + OrbitDB context shared by both namespaces.
        // Pass networkId so OrbitDB always uses the same signing identity across restarts.
        // Retry on "Database failed to open" — after a daemon restart the OS may need
        // a brief moment to fully release LevelDB file locks from the previous process.
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                ctx = await createOrbitDBContext(node, networkDataDir, networkId);
                break;
            }
            catch (err) {
                if (attempt < 2 && isDbLockError(err)) {
                    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                    continue;
                }
                throw err;
            }
        }
        if (!ctx)
            throw new Error('createOrbitDBContext returned undefined after retries');
        const epochConfig = options.epochConfig ?? DEFAULT_EPOCH_CONFIG;
        const [skillManager, projectManager] = await Promise.all([
            EpochManager.create(ctx.orbitdb, networkKeys, 'skill', epochConfig, networkDataDir),
            EpochManager.create(ctx.orbitdb, networkKeys, 'project', epochConfig, networkDataDir),
        ]);
        // Build backlink index from existing store contents
        const backlinkIndex = new BacklinkIndex();
        await Promise.all([
            backlinkIndex.build(skillManager),
            backlinkIndex.build(projectManager),
        ]);
        // Wire up backlink index to update on replication events
        const updateBacklinks = async (store) => {
            const all = await store.list().catch(() => []);
            // Rebuild index slice for this store on every replication
            // (incremental updates are complex with OrbitDB's merge semantics)
            for (const chunk of all) {
                backlinkIndex.indexChunk(chunk);
            }
        };
        skillManager.on('replicated', () => { void updateBacklinks(skillManager); });
        projectManager.on('replicated', () => { void updateBacklinks(projectManager); });
        // Create and start the discovery manager.
        // For PSK sessions, localPeerId is the PSK node's peer ID (derived key) and
        // agentPeerId is the GLOBAL identity peer ID (so remote peers can map between them).
        const pskNodePeerId = node.peerId.toString();
        const globalPeerId = localPeerId; // derivePeerId(agentPrivateKey) = GLOBAL peer ID
        const discovery = new DiscoveryManager(node, [skillManager, projectManager], {
            localPeerId: pskNodePeerId,
            agentPeerId: pskNodePeerId !== globalPeerId ? globalPeerId : undefined,
            displayName: options.displayName,
            subscribedTopics: options.subscribedTopics,
            subscribedPeers: options.subscribedPeers,
            // Proof-of-work
            stampCache: options.stampCache,
            powBitsForRequests: options.powBitsForRequests,
            powWindowMs: options.powWindowMs,
            requirePoW: options.requirePoW,
        });
        // Subscribe immediately so we can receive other peers' manifests from the start.
        // The first self-broadcast is deferred so peers have time to connect and join
        // the GossipSub mesh.  triggerRebroadcast() (called after each write) forces
        // a re-broadcast once data is in the store.
        void discovery.start();
        const session = {
            id: networkId,
            name: options.name,
            node,
            pruner,
            helia: ctx.helia,
            orbitdb: ctx.orbitdb,
            stores: { skill: skillManager, project: projectManager },
            epochManagers: { skill: skillManager, project: projectManager },
            backlinkIndex,
            discovery,
            networkKeys,
            agentPrivateKey,
            closeLevelStores: ctx.closeLevelStores,
        };
        return session;
    }
    catch (err) {
        // Clean up in reverse order if init failed
        if (ctx) {
            await ctx.helia.stop().catch(() => { });
            await ctx.closeLevelStores().catch(() => { });
        }
        if (node) {
            await Promise.resolve(node.stop()).catch(() => { });
        }
        throw new NetworkError(`Failed to join network: ${String(err)}`, ErrorCode.JOIN_FAILED, err);
    }
}
/**
 * Leave a network — stop discovery, close all stores and stop the libp2p node.
 * After this call, the session should be discarded.
 */
export async function leaveNetwork(session) {
    const errors = [];
    // Stop connection pruner first — clears pending timers
    session.pruner?.stop();
    // Stop discovery manager first (unregisters protocols)
    await session.discovery.stop().catch((e) => errors.push(e));
    // Close stores first (they hold DB handles on top of OrbitDB)
    await session.stores.skill.close().catch((e) => errors.push(e));
    await session.stores.project.close().catch((e) => errors.push(e));
    // Then close OrbitDB, Helia, and the libp2p node in order
    await Promise.resolve(session.orbitdb.stop()).catch((e) => errors.push(e));
    await session.helia.stop().catch((e) => errors.push(e));
    // Close raw Level databases — Helia.stop() does NOT close these
    await session.closeLevelStores().catch((e) => errors.push(e));
    await Promise.resolve(session.node.stop()).catch((e) => errors.push(e));
    if (errors.length > 0) {
        console.warn('[subspace] Errors during network leave:', errors);
    }
}
/**
 * Convert a live NetworkSession to a serialisable NetworkInfoDTO.
 */
export function sessionToDTO(session) {
    const peerId = session.node.peerId.toString();
    const peers = session.node.getPeers().length;
    const knownPeers = session.discovery.getKnownPeers().length;
    const multiaddrs = session.node.getMultiaddrs().map(ma => ma.toString());
    return {
        id: session.id,
        name: session.name,
        peerId,
        peers,
        namespaces: ['skill', 'project'],
        knownPeers,
        multiaddrs,
    };
}
/**
 * Join the global Subspace network — connect to bootstrap/relay infrastructure,
 * start broadcasting public discovery manifests, and register the browse protocol
 * handler so any peer can browse this agent's public content.
 *
 * This is called once at daemon startup, before any PSK networks are joined.
 * It gives the agent global presence and addressability from first start.
 *
 * @param agentPrivateKey  Persistent Ed25519 identity key from identity.ts.
 * @param options          Connection and discovery configuration.
 */
export async function joinGlobalNetwork(agentPrivateKey, options = {}) {
    const localPeerId = derivePeerId(agentPrivateKey);
    const { node, pruner } = await createLibp2pNode(agentPrivateKey, {
        port: options.port,
        minConnections: options.minConnections,
        maxConnections: options.maxConnections,
        trustedBootstrapPeers: options.trustedBootstrapPeers,
        relayAddresses: options.relayAddresses,
    });
    // Empty stores — the global session has no private memory stores.
    // The DiscoveryManager handles this gracefully: it publishes an empty bloom
    // filter and serves empty browse stubs until PSK sessions add content.
    const discovery = new DiscoveryManager(node, [], {
        localPeerId,
        displayName: options.displayName,
        subscribedTopics: options.subscribedTopics,
        subscribedPeers: options.subscribedPeers,
        stampCache: options.stampCache,
        powBitsForRequests: options.powBitsForRequests,
        powWindowMs: options.powWindowMs,
        requirePoW: options.requirePoW,
    });
    // Start discovery after a short delay to let the node connect to some peers
    setTimeout(() => { void discovery.start(); }, 2000);
    return { node, pruner, discovery, localPeerId, port: options.port ?? 7432 };
}
/**
 * Leave the global network — stop discovery and shut down the libp2p node.
 * Called during daemon shutdown, after all PSK sessions have been left.
 */
export async function leaveGlobalNetwork(session) {
    const errors = [];
    // Stop pruner first — clears pending timers
    session.pruner?.stop();
    await session.discovery.stop().catch((e) => errors.push(e));
    await Promise.resolve(session.node.stop()).catch((e) => errors.push(e));
    if (errors.length > 0) {
        console.warn('[subspace] Errors during global network leave:', errors);
    }
}
//# sourceMappingURL=network.js.map