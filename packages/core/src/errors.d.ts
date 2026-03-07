/**
 * Typed error hierarchy for Subspace Transceiver.
 * All errors carry a machine-readable ErrorCode for programmatic handling.
 */
export declare const ErrorCode: {
    readonly PSK_TOO_SHORT: "PSK_TOO_SHORT";
    readonly DECRYPT_FAILED: "DECRYPT_FAILED";
    readonly INVALID_CHUNK: "INVALID_CHUNK";
    readonly CHUNK_NOT_FOUND: "CHUNK_NOT_FOUND";
    readonly STORE_WRITE_FAILED: "STORE_WRITE_FAILED";
    readonly STORE_READ_FAILED: "STORE_READ_FAILED";
    readonly JOIN_FAILED: "JOIN_FAILED";
    readonly PEER_DIAL_FAILED: "PEER_DIAL_FAILED";
    readonly NETWORK_NOT_FOUND: "NETWORK_NOT_FOUND";
    readonly DAEMON_TIMEOUT: "DAEMON_TIMEOUT";
    readonly DAEMON_NOT_RUNNING: "DAEMON_NOT_RUNNING";
    readonly DAEMON_ALREADY_RUNNING: "DAEMON_ALREADY_RUNNING";
    readonly API_ERROR: "API_ERROR";
    readonly SIGNATURE_INVALID: "SIGNATURE_INVALID";
    readonly PROOF_OF_WORK_INVALID: "PROOF_OF_WORK_INVALID";
    readonly RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED";
    readonly CONTENT_TOO_LARGE: "CONTENT_TOO_LARGE";
    readonly STORAGE_QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED";
    readonly PEER_BLACKLISTED: "PEER_BLACKLISTED";
    readonly PSK_ROTATION_FAILED: "PSK_ROTATION_FAILED";
    readonly URI_PARSE_ERROR: "URI_PARSE_ERROR";
    readonly RESOLUTION_FAILED: "RESOLUTION_FAILED";
};
export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode];
/**
 * Base error class for all subspace errors.
 * Always includes a typed error code and optional original cause.
 */
export declare class AgentNetError extends Error {
    readonly code: ErrorCode;
    constructor(message: string, code: ErrorCode, cause?: unknown);
}
/** Errors related to cryptographic operations (HKDF, AES-GCM, PSK). */
export declare class CryptoError extends AgentNetError {
    constructor(message: string, code: ErrorCode, cause?: unknown);
}
/** Errors from the memory store layer (OrbitDB, validation, IO). */
export declare class StoreError extends AgentNetError {
    constructor(message: string, code: ErrorCode, cause?: unknown);
}
/** Errors from p2p network operations (libp2p, join, dial). */
export declare class NetworkError extends AgentNetError {
    constructor(message: string, code: ErrorCode, cause?: unknown);
}
/** Errors from the daemon process (start/stop, IPC, API). */
export declare class DaemonError extends AgentNetError {
    constructor(message: string, code: ErrorCode, cause?: unknown);
}
//# sourceMappingURL=errors.d.ts.map