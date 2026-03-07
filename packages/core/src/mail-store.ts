/**
 * Mail store — persists MailEnvelopes (relay side) and InboxMessages (recipient side).
 *
 * Design philosophy:
 *   - Relay store: holds encrypted envelopes for offline peers. Envelopes are
 *     stored by recipientPeerId so the relay can efficiently answer "check" queries.
 *   - Inbox store: holds decrypted messages for the local agent. Persisted to disk
 *     so they survive daemon restarts.
 *
 * Both stores use simple JSON file persistence for now — LevelDB can be
 * introduced for larger deployments without changing the IMailStore interface.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MailEnvelope, InboxMessage, OutboxMessage } from './mail.js'
import { isEnvelopeExpired } from './mail.js'

// ---------------------------------------------------------------------------
// Relay store — holds envelopes on behalf of offline peers
// ---------------------------------------------------------------------------

export interface IRelayStore {
  /** Store an envelope for a recipient. Returns false if quota exceeded. */
  deposit(envelope: MailEnvelope): Promise<boolean>
  /** Retrieve pending envelopes for a recipient. */
  check(recipientPeerId: string, since?: number, limit?: number): Promise<MailEnvelope[]>
  /** Acknowledge receipt — relay deletes the envelopes. */
  ack(envelopeIds: string[]): Promise<number>
  /** Evict expired envelopes. Returns count evicted. */
  evict(): Promise<number>
  /** Total envelope count for a recipient. */
  count(recipientPeerId: string): Promise<number>
}

/**
 * In-memory relay store. Suitable for development/testing and small deployments.
 * Data is lost on daemon restart (use FileRelayStore for persistence).
 */
export class MemoryRelayStore implements IRelayStore {
  private envelopes = new Map<string, MailEnvelope>()  // id → envelope
  private byRecipient = new Map<string, Set<string>>()  // peerId → Set<id>
  private maxEnvelopesPerRecipient: number
  private maxTotalEnvelopes: number

  constructor(opts: { maxPerRecipient?: number; maxTotal?: number } = {}) {
    this.maxEnvelopesPerRecipient = opts.maxPerRecipient ?? 1000
    this.maxTotalEnvelopes = opts.maxTotal ?? 100_000
  }

  async deposit(envelope: MailEnvelope): Promise<boolean> {
    if (isEnvelopeExpired(envelope)) return false
    if (this.envelopes.size >= this.maxTotalEnvelopes) return false

    const recipientSet = this.byRecipient.get(envelope.to) ?? new Set()
    if (recipientSet.size >= this.maxEnvelopesPerRecipient) return false

    this.envelopes.set(envelope.id, envelope)
    recipientSet.add(envelope.id)
    this.byRecipient.set(envelope.to, recipientSet)
    return true
  }

  async check(recipientPeerId: string, since?: number, limit = 50): Promise<MailEnvelope[]> {
    const ids = this.byRecipient.get(recipientPeerId) ?? new Set()
    const result: MailEnvelope[] = []
    for (const id of ids) {
      const env = this.envelopes.get(id)
      if (!env || isEnvelopeExpired(env)) continue
      if (since !== undefined && env.timestamp <= since) continue
      result.push(env)
      if (result.length >= limit) break
    }
    return result.sort((a, b) => a.timestamp - b.timestamp)
  }

  async ack(envelopeIds: string[]): Promise<number> {
    let count = 0
    for (const id of envelopeIds) {
      const env = this.envelopes.get(id)
      if (!env) continue
      this.envelopes.delete(id)
      this.byRecipient.get(env.to)?.delete(id)
      count++
    }
    return count
  }

  async evict(): Promise<number> {
    let count = 0
    for (const [id, env] of this.envelopes) {
      if (isEnvelopeExpired(env)) {
        this.envelopes.delete(id)
        this.byRecipient.get(env.to)?.delete(id)
        count++
      }
    }
    return count
  }

  async count(recipientPeerId: string): Promise<number> {
    return this.byRecipient.get(recipientPeerId)?.size ?? 0
  }
}

// ---------------------------------------------------------------------------
// Inbox / Outbox stores — local agent's messages
// ---------------------------------------------------------------------------

export interface IInboxStore {
  /** Save a decrypted message to the inbox. */
  save(message: InboxMessage): Promise<void>
  /** List all inbox messages, newest first. */
  list(): Promise<InboxMessage[]>
  /** Get a specific message by ID. */
  get(id: string): Promise<InboxMessage | null>
  /** Delete a message from the inbox. */
  delete(id: string): Promise<boolean>
  /** Total message count. */
  count(): Promise<number>
}

export interface IOutboxStore {
  /** Record a sent message. */
  save(message: OutboxMessage): Promise<void>
  /** List all outbox messages, newest first. */
  list(): Promise<OutboxMessage[]>
  /** Get a specific message by ID. */
  get(id: string): Promise<OutboxMessage | null>
  /** Update the status of a sent message. */
  updateStatus(id: string, status: OutboxMessage['status']): Promise<boolean>
}

/** Simple in-memory inbox. Use FileInboxStore for persistence. */
export class MemoryInboxStore implements IInboxStore {
  private messages = new Map<string, InboxMessage>()

  async save(message: InboxMessage): Promise<void> {
    this.messages.set(message.id, message)
  }

  async list(): Promise<InboxMessage[]> {
    return [...this.messages.values()].sort((a, b) => b.receivedAt - a.receivedAt)
  }

  async get(id: string): Promise<InboxMessage | null> {
    return this.messages.get(id) ?? null
  }

  async delete(id: string): Promise<boolean> {
    return this.messages.delete(id)
  }

  async count(): Promise<number> {
    return this.messages.size
  }
}

/** Simple in-memory outbox. Use FileOutboxStore for persistence. */
export class MemoryOutboxStore implements IOutboxStore {
  private messages = new Map<string, OutboxMessage>()

  async save(message: OutboxMessage): Promise<void> {
    this.messages.set(message.id, message)
  }

  async list(): Promise<OutboxMessage[]> {
    return [...this.messages.values()].sort((a, b) => b.sentAt - a.sentAt)
  }

  async get(id: string): Promise<OutboxMessage | null> {
    return this.messages.get(id) ?? null
  }

  async updateStatus(id: string, status: OutboxMessage['status']): Promise<boolean> {
    const msg = this.messages.get(id)
    if (!msg) return false
    this.messages.set(id, { ...msg, status })
    return true
  }
}

// ---------------------------------------------------------------------------
// File-backed stores — durable across daemon restarts
// ---------------------------------------------------------------------------

/**
 * File-backed relay store. Persists envelopes as a JSON file.
 * Suitable for single-node deployments; for distributed relay, use LevelDB.
 */
export class FileRelayStore extends MemoryRelayStore {
  private readonly path: string
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(storePath: string, opts: { maxPerRecipient?: number; maxTotal?: number } = {}) {
    super(opts)
    this.path = storePath
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8')
      const envelopes: MailEnvelope[] = JSON.parse(raw)
      for (const env of envelopes) {
        await super.deposit(env)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[mail-store] Could not load relay store:', err)
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush().catch(e => console.warn('[mail-store] Relay flush error:', e))
    }, 2000)
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    try {
      await mkdir(join(this.path, '..'), { recursive: true })
      const all = await this.check('', 0, Number.MAX_SAFE_INTEGER)  // list all
      await writeFile(this.path, JSON.stringify(all), 'utf8')
      this.dirty = false
    } catch (err) {
      console.warn('[mail-store] Relay save error:', err)
    }
  }

  override async deposit(envelope: MailEnvelope): Promise<boolean> {
    const ok = await super.deposit(envelope)
    if (ok) { this.dirty = true; this.scheduleSave() }
    return ok
  }

  override async ack(envelopeIds: string[]): Promise<number> {
    const count = await super.ack(envelopeIds)
    if (count > 0) { this.dirty = true; this.scheduleSave() }
    return count
  }

  override async evict(): Promise<number> {
    const count = await super.evict()
    if (count > 0) { this.dirty = true; this.scheduleSave() }
    return count
  }
}

/**
 * File-backed inbox store. Persists as a JSON file in the data directory.
 */
export class FileInboxStore implements IInboxStore {
  private readonly path: string
  private messages = new Map<string, InboxMessage>()
  private loaded = false

  constructor(storePath: string) {
    this.path = storePath
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(this.path, 'utf8')
      const messages: InboxMessage[] = JSON.parse(raw)
      for (const msg of messages) {
        this.messages.set(msg.id, msg)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[mail-store] Could not load inbox:', err)
      }
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.path, '..'), { recursive: true })
    const all = [...this.messages.values()]
    await writeFile(this.path, JSON.stringify(all), 'utf8')
  }

  async save(message: InboxMessage): Promise<void> {
    await this.load()
    this.messages.set(message.id, message)
    await this.persist()
  }

  async list(): Promise<InboxMessage[]> {
    await this.load()
    return [...this.messages.values()].sort((a, b) => b.receivedAt - a.receivedAt)
  }

  async get(id: string): Promise<InboxMessage | null> {
    await this.load()
    return this.messages.get(id) ?? null
  }

  async delete(id: string): Promise<boolean> {
    await this.load()
    const existed = this.messages.delete(id)
    if (existed) await this.persist()
    return existed
  }

  async count(): Promise<number> {
    await this.load()
    return this.messages.size
  }
}

/**
 * File-backed outbox store.
 */
export class FileOutboxStore implements IOutboxStore {
  private readonly path: string
  private messages = new Map<string, OutboxMessage>()
  private loaded = false

  constructor(storePath: string) {
    this.path = storePath
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await readFile(this.path, 'utf8')
      const messages: OutboxMessage[] = JSON.parse(raw)
      for (const msg of messages) {
        this.messages.set(msg.id, msg)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[mail-store] Could not load outbox:', err)
      }
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.path, '..'), { recursive: true })
    const all = [...this.messages.values()]
    await writeFile(this.path, JSON.stringify(all), 'utf8')
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.load()
    this.messages.set(message.id, message)
    await this.persist()
  }

  async list(): Promise<OutboxMessage[]> {
    await this.load()
    return [...this.messages.values()].sort((a, b) => b.sentAt - a.sentAt)
  }

  async get(id: string): Promise<OutboxMessage | null> {
    await this.load()
    return this.messages.get(id) ?? null
  }

  async updateStatus(id: string, status: OutboxMessage['status']): Promise<boolean> {
    await this.load()
    const msg = this.messages.get(id)
    if (!msg) return false
    this.messages.set(id, { ...msg, status })
    await this.persist()
    return true
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Create file-backed mail stores from a data directory.
 * Stores are created in <dataDir>/mail/.
 */
export async function createFileMailStores(dataDir: string): Promise<{
  relay: FileRelayStore
  inbox: FileInboxStore
  outbox: FileOutboxStore
}> {
  const mailDir = join(dataDir, 'mail')
  await mkdir(mailDir, { recursive: true })

  const relay = new FileRelayStore(join(mailDir, 'relay.json'))
  const inbox = new FileInboxStore(join(mailDir, 'inbox.json'))
  const outbox = new FileOutboxStore(join(mailDir, 'outbox.json'))

  await relay.load()
  await inbox.load()
  await outbox.load()

  return { relay, inbox, outbox }
}

/** Check if a file-based store path exists (for conditional loading). */
export function mailStoreExists(dataDir: string): boolean {
  return existsSync(join(dataDir, 'mail'))
}
