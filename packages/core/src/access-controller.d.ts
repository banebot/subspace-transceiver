/**
 * SubspaceAccessController — custom OrbitDB v2 access controller that validates
 * incoming CRDT oplog entries at the replication layer.
 *
 * ## Problem
 * OrbitDB's default IPFSAccessController only checks that the entry was signed by
 * a known OrbitDB identity. It does NOT validate the chunk's schema, content size,
 * or Ed25519 authorship. A malicious peer on the GossipSub topic can inject arbitrary
 * documents into the oplog, consuming disk space and crashing queries.
 *
 * ## Solution
 * This access controller validates every incoming PUT operation against:
 * 1. A metadata-level schema check (id, type, namespace, topic[], source, confidence)
 * 2. Content size limits (encrypted blobs are bounded even if content is opaque)
 * 3. Ed25519 signature verification (when present and source.peerId is an Ed25519 PeerId)
 *
 * ## Encryption compatibility
 * When envelope encryption is enabled (the default), `content` is stored as an
 * empty string and the actual ciphertext lives in `encryptedContent`. This AC
 * validates the encrypted-document shape rather than the plaintext content field.
 *
 * ## OrbitDB integration
 * Register this controller ONCE at startup with `useAccessController(SubspaceAccessController)`,
 * then pass `AccessController: SubspaceAccessController(options)` to `orbitdb.open()`.
 *
 * The controller is stateless — no IPFS storage required, no manifest block fetched.
 * This makes it safe to use with private networks where storing manifest CIDs in the
 * public IPFS blockstore would leak metadata.
 */
export interface SubspaceAccessControllerOptions {
    /**
     * Maximum allowed byte size of the `content` field (or `encryptedContent` blob).
     * Default: 65_536 (64KB) — matches SecurityConfig.maxChunkContentBytes.
     */
    maxContentBytes?: number;
    /**
     * Maximum allowed byte size of `encryptedEnvelopeBody` (or `contentEnvelope.body`).
     * Default: 262_144 (256KB) — matches SecurityConfig.maxEnvelopeBodyBytes.
     */
    maxEnvelopeBodyBytes?: number;
    /**
     * When true, entries without a valid Ed25519 signature are REJECTED.
     * Default: false (signature is verified if present, but absence is allowed).
     */
    requireSignatures?: boolean;
}
/**
 * Factory function matching the OrbitDB AccessController interface.
 * Call `SubspaceAccessController(options)` to get an async factory, then
 * pass it to `orbitdb.open()` as `AccessController`.
 *
 * Also register globally: `useAccessController(SubspaceAccessController)`
 * so that existing databases (with 'subspace' in their manifest) can be
 * reopened without providing the factory explicitly.
 */
declare const SubspaceAccessController: {
    (options?: SubspaceAccessControllerOptions): ({ name, address }: {
        orbitdb?: unknown;
        identities?: unknown;
        name?: string;
        address?: string;
    }) => Promise<{
        type: string;
        address: string;
        canAppend: (entry: {
            payload?: {
                op?: string;
                key?: string;
                value?: Record<string, unknown>;
            };
        }) => Promise<boolean>;
    }>;
    type: string;
};
export { SubspaceAccessController };
//# sourceMappingURL=access-controller.d.ts.map