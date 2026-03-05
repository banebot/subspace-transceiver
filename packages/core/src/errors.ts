/**
 * Typed error hierarchy for Subspace Transceiver.
 * All errors carry a machine-readable ErrorCode for programmatic handling.
 */

export const ErrorCode = {
  // Crypto errors
  PSK_TOO_SHORT: 'PSK_TOO_SHORT',
  DECRYPT_FAILED: 'DECRYPT_FAILED',
  // Store errors
  INVALID_CHUNK: 'INVALID_CHUNK',
  CHUNK_NOT_FOUND: 'CHUNK_NOT_FOUND',
  STORE_WRITE_FAILED: 'STORE_WRITE_FAILED',
  STORE_READ_FAILED: 'STORE_READ_FAILED',
  // Network errors
  JOIN_FAILED: 'JOIN_FAILED',
  PEER_DIAL_FAILED: 'PEER_DIAL_FAILED',
  NETWORK_NOT_FOUND: 'NETWORK_NOT_FOUND',
  // Daemon errors
  DAEMON_TIMEOUT: 'DAEMON_TIMEOUT',
  DAEMON_NOT_RUNNING: 'DAEMON_NOT_RUNNING',
  DAEMON_ALREADY_RUNNING: 'DAEMON_ALREADY_RUNNING',
  API_ERROR: 'API_ERROR',
  // Security errors
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  PROOF_OF_WORK_INVALID: 'PROOF_OF_WORK_INVALID',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  CONTENT_TOO_LARGE: 'CONTENT_TOO_LARGE',
  STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',
  PEER_BLACKLISTED: 'PEER_BLACKLISTED',
  PSK_ROTATION_FAILED: 'PSK_ROTATION_FAILED',
  // URI / addressing errors
  URI_PARSE_ERROR: 'URI_PARSE_ERROR',
  RESOLUTION_FAILED: 'RESOLUTION_FAILED',
} as const

export type ErrorCode = typeof ErrorCode[keyof typeof ErrorCode]

/**
 * Base error class for all subspace errors.
 * Always includes a typed error code and optional original cause.
 */
export class AgentNetError extends Error {
  readonly code: ErrorCode

  constructor(message: string, code: ErrorCode, cause?: unknown) {
    super(message)
    this.name = 'AgentNetError'
    this.code = code
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

/** Errors related to cryptographic operations (HKDF, AES-GCM, PSK). */
export class CryptoError extends AgentNetError {
  constructor(message: string, code: ErrorCode, cause?: unknown) {
    super(message, code, cause)
    this.name = 'CryptoError'
  }
}

/** Errors from the memory store layer (OrbitDB, validation, IO). */
export class StoreError extends AgentNetError {
  constructor(message: string, code: ErrorCode, cause?: unknown) {
    super(message, code, cause)
    this.name = 'StoreError'
  }
}

/** Errors from p2p network operations (libp2p, join, dial). */
export class NetworkError extends AgentNetError {
  constructor(message: string, code: ErrorCode, cause?: unknown) {
    super(message, code, cause)
    this.name = 'NetworkError'
  }
}

/** Errors from the daemon process (start/stop, IPC, API). */
export class DaemonError extends AgentNetError {
  constructor(message: string, code: ErrorCode, cause?: unknown) {
    super(message, code, cause)
    this.name = 'DaemonError'
  }
}
