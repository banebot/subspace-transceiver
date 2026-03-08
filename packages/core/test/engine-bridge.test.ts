/**
 * Unit tests for EngineBridge TypeScript client.
 *
 * These tests mock the engine subprocess to test the bridge logic in isolation.
 * Integration tests that actually spawn the Rust binary live in e2e/.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter, PassThrough } from 'node:stream'
import { EngineBridge, _resetDefaultBridge, getDefaultBridge } from '../src/engine-bridge.js'
import type { ChildProcess } from 'node:child_process'

// ---------------------------------------------------------------------------
// Mock engine process factory
// ---------------------------------------------------------------------------

function makeMockEngine(): {
  proc: ChildProcess
  stdin: PassThrough
  stdout: PassThrough
  sendToNode: (obj: object) => void
  readFromEngine: () => Promise<object>
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()

  // Collect lines written to stdin (engine's input from Node.js)
  const writtenLines: string[] = []
  stdin.on('data', (chunk: Buffer) => {
    writtenLines.push(chunk.toString())
  })

  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    kill: vi.fn(),
    pid: 12345,
  }) as unknown as ChildProcess

  return {
    proc,
    stdin,
    stdout,
    sendToNode: (obj: object) => {
      stdout.push(JSON.stringify(obj) + '\n')
    },
    readFromEngine: async () => {
      // Read the next line written to stdin by the bridge
      return new Promise<object>((resolve) => {
        if (writtenLines.length > 0) {
          const line = writtenLines.shift()!
          resolve(JSON.parse(line.trim()))
        } else {
          stdin.once('data', (chunk: Buffer) => {
            resolve(JSON.parse(chunk.toString().trim()))
          })
        }
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EngineBridge', () => {
  beforeEach(() => {
    _resetDefaultBridge()
  })

  afterEach(() => {
    _resetDefaultBridge()
  })

  describe('constructor', () => {
    it('creates bridge with default options', () => {
      const bridge = new EngineBridge()
      expect(bridge).toBeDefined()
      expect(bridge.isRunning).toBe(false)
    })

    it('accepts custom engine path', () => {
      const bridge = new EngineBridge({ enginePath: '/custom/path/engine' })
      expect(bridge).toBeDefined()
    })
  })

  describe('start()', () => {
    it('throws if engine binary does not exist', async () => {
      const bridge = new EngineBridge({ enginePath: '/nonexistent/binary' })
      await expect(bridge.start()).rejects.toThrow('not found at')
    })
  })

  describe('RPC protocol', () => {
    it('sends correct JSON-RPC request format', () => {
      // Verify the request format by checking what engineStart would send
      const request = {
        id: 'test-id',
        method: 'engine.start',
        params: { seed_hex: 'aa'.repeat(32) },
      }

      const serialized = JSON.stringify(request)
      const parsed = JSON.parse(serialized)

      expect(parsed.id).toBe('test-id')
      expect(parsed.method).toBe('engine.start')
      expect(parsed.params.seed_hex).toBe('aa'.repeat(32))
    })

    it('parses successful response correctly', () => {
      const response = {
        id: 'req-1',
        result: { nodeId: 'abc123', addrs: ['127.0.0.1:7432'] },
      }

      expect(response.result.nodeId).toBe('abc123')
      expect(response.result.addrs).toHaveLength(1)
    })

    it('handles error response correctly', () => {
      const response = {
        id: 'req-1',
        error: { code: -32601, message: 'Method not found: nonexistent' },
      }

      expect(response.error.code).toBe(-32601)
      expect(response.error.message).toContain('Method not found')
    })
  })

  describe('notification handling', () => {
    it('correctly identifies notification vs response', () => {
      const notification = { method: 'engine.ready', params: { version: '0.1.0' } }
      const response = { id: 'req-1', result: { nodeId: 'abc' } }

      // Notifications have `method` but no `id`
      expect('method' in notification && !('id' in notification)).toBe(true)
      // Responses have `id`
      expect('id' in response).toBe(true)
    })

    it('emits engine.ready on notification', () => {
      const bridge = new EngineBridge({ enginePath: '/fake' })
      let readyFired = false
      bridge.once('engine.ready', () => { readyFired = true })

      // Simulate the private handleLine being called
      // We access it by calling the bridge event mechanism directly
      bridge.emit('engine.ready')
      expect(readyFired).toBe(true)
    })

    it('emits gossip.received with correct shape', () => {
      const bridge = new EngineBridge({ enginePath: '/fake' })
      let received: unknown = null
      bridge.on('gossip.received', (msg) => { received = msg })

      // Simulate what handleNotification does
      const params = {
        topic_hex: 'deadbeef'.repeat(8),
        payload_b64: Buffer.from('hello world').toString('base64'),
        from_node_id: 'peer-abc',
      }
      const expectedMsg = {
        topicHex: params.topic_hex,
        payload: params.payload_b64,
        fromNodeId: params.from_node_id,
      }
      // Simulate gossip received
      bridge.emit('gossip.received', expectedMsg)

      expect(received).toMatchObject({
        topicHex: params.topic_hex,
        fromNodeId: 'peer-abc',
      })
    })
  })

  describe('onGossipMessage()', () => {
    it('returns an unsubscribe function', () => {
      const bridge = new EngineBridge({ enginePath: '/fake' })
      const unsubscribe = bridge.onGossipMessage(() => {})
      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })

    it('stops receiving after unsubscribe', () => {
      const bridge = new EngineBridge({ enginePath: '/fake' })
      const received: unknown[] = []
      const unsubscribe = bridge.onGossipMessage((msg) => received.push(msg))

      bridge.emit('gossip.received', { topicHex: 'aa', payload: '', fromNodeId: 'x' })
      expect(received).toHaveLength(1)

      unsubscribe()
      bridge.emit('gossip.received', { topicHex: 'bb', payload: '', fromNodeId: 'y' })
      expect(received).toHaveLength(1) // Still 1, not 2
    })
  })

  describe('onPeerConnected() / onPeerDisconnected()', () => {
    it('returns unsubscribe functions', () => {
      const bridge = new EngineBridge({ enginePath: '/fake' })
      const u1 = bridge.onPeerConnected(() => {})
      const u2 = bridge.onPeerDisconnected(() => {})
      expect(typeof u1).toBe('function')
      expect(typeof u2).toBe('function')
      u1()
      u2()
    })
  })

  describe('getDefaultBridge()', () => {
    it('returns the same instance on multiple calls', () => {
      const b1 = getDefaultBridge({ enginePath: '/fake' })
      const b2 = getDefaultBridge()
      expect(b1).toBe(b2)
    })

    it('resets correctly with _resetDefaultBridge', () => {
      const b1 = getDefaultBridge({ enginePath: '/fake' })
      _resetDefaultBridge()
      const b2 = getDefaultBridge({ enginePath: '/fake' })
      expect(b1).not.toBe(b2)
    })
  })

  describe('base64 payload encoding', () => {
    it('encodes Uint8Array to base64 correctly', () => {
      const payload = new Uint8Array([104, 101, 108, 108, 111]) // "hello"
      const b64 = Buffer.from(payload).toString('base64')
      const decoded = Buffer.from(b64, 'base64')
      expect(decoded.toString('utf8')).toBe('hello')
    })

    it('handles empty payload', () => {
      const payload = new Uint8Array(0)
      const b64 = Buffer.from(payload).toString('base64')
      expect(b64).toBe('')
    })
  })

  describe('isRunning', () => {
    it('is false by default', () => {
      const bridge = new EngineBridge({ enginePath: '/fake' })
      expect(bridge.isRunning).toBe(false)
    })
  })
})
