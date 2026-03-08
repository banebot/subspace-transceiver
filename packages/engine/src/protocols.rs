/*!
 * ALPN protocol identifiers and handler scaffolding for Iroh QUIC connections.
 *
 * Each Subspace protocol has an ALPN identifier that peers use to negotiate
 * which protocol to run over a QUIC connection. This mirrors libp2p's protocol
 * IDs but runs over Iroh QUIC with the Router dispatch mechanism.
 *
 * ## Registration
 * Use `iroh::protocol::Router::builder(endpoint).accept(ALPN, handler).spawn()`.
 * The Router dispatches incoming connections to the appropriate handler.
 */

/// ALPN protocol identifiers (must match TypeScript constants in protocol.ts)
pub mod alpn {
    pub const BROWSE: &[u8] = b"/subspace/browse/1.0.0";
    pub const QUERY: &[u8] = b"/subspace/query/1.0.0";
    pub const MANIFEST: &[u8] = b"/subspace/manifest/1.0.0";
    pub const MAILBOX: &[u8] = b"/subspace/mailbox/1.0.0";
    pub const NEGOTIATE: &[u8] = b"/subspace/negotiate/1.0.0";

    /// All Subspace protocol ALPNs (for endpoint configuration)
    pub const ALL: &[&[u8]] = &[BROWSE, QUERY, MANIFEST, MAILBOX, NEGOTIATE];
}
