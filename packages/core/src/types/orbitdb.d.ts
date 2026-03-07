/**
 * Minimal type declarations for @orbitdb/core v2.
 * The package ships no TypeScript types — these are hand-crafted from the API.
 */
declare module '@orbitdb/core' {
  import type { Helia } from 'helia'

  export interface DocumentsDatabase {
    put(doc: Record<string, unknown>): Promise<unknown>
    get(id: string): Promise<Record<string, unknown> | null>
    query(fn: (doc: Record<string, unknown>) => boolean): Promise<Record<string, unknown>[]>
    del(id: string): Promise<unknown>
    close(): Promise<void>
    events: EventEmitter
    address: string
    name: string
  }

  export interface OrbitDB {
    open(
      name: string,
      options?: { type?: string; [key: string]: unknown }
    ): Promise<DocumentsDatabase>
    stop(): Promise<void>
    ipfs: Helia
    directory: string
    identity: unknown
    peerId: string
  }

  export function createOrbitDB(options: {
    ipfs: Helia
    directory?: string
    id?: string
  }): Promise<OrbitDB>
}
