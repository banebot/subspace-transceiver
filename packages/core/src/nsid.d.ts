/**
 * NSID (Namespaced Identifiers) — AT Protocol-inspired schema naming.
 *
 * NSIDs use reverse-DNS notation to uniquely identify schemas and record types:
 *   net.subspace.memory.skill   — built-in skill memory type
 *   com.example.task.item       — third-party task record type
 *   io.agent.market.listing     — marketplace listing
 *
 * Rules (following AT Protocol conventions):
 *   - At least 3 segments separated by dots
 *   - Each segment: lowercase alphanumeric + hyphens, no leading digits
 *   - Max 253 characters total
 *   - Controlled by domain owner (social convention)
 *   - Prefix matching supported via '*' wildcard (e.g., 'net.subspace.*')
 */
/**
 * Check if a string is a valid NSID.
 */
export declare function isValidNSID(nsid: string): boolean;
/**
 * Parsed NSID structure.
 */
export interface ParsedNSID {
    /** Full NSID string, e.g. 'com.example.task.item' */
    nsid: string;
    /**
     * Domain authority (first 2+ segments reversed), e.g. 'example.com'
     * For 'net.subspace.memory.skill': authority = 'subspace.net'
     */
    authority: string;
    /**
     * Name (remaining segments after authority), e.g. 'memory.skill'
     */
    name: string;
    /** All segments in NSID order */
    segments: string[];
    toString(): string;
}
/**
 * Parse an NSID string into its components.
 * Throws if the NSID is invalid.
 */
export declare function parseNSID(nsid: string): ParsedNSID;
/**
 * Check if an NSID matches a pattern.
 * Patterns support a trailing '*' wildcard:
 *   'net.subspace.*'  matches 'net.subspace.memory.skill', 'net.subspace.blob.manifest', etc.
 *   'net.subspace.memory.skill'  matches only that exact NSID
 */
export declare function nsidMatches(nsid: string, pattern: string): boolean;
/**
 * Built-in NSIDs — maps old MemoryType enum values to their NSID equivalents.
 */
export declare const BUILT_IN_NSIDS: {
    readonly skill: "net.subspace.memory.skill";
    readonly project: "net.subspace.memory.project";
    readonly context: "net.subspace.memory.context";
    readonly pattern: "net.subspace.memory.pattern";
    readonly result: "net.subspace.memory.result";
    readonly document: "net.subspace.memory.document";
    readonly schema: "net.subspace.schema.definition";
    readonly thread: "net.subspace.memory.thread";
    readonly 'blob-manifest': "net.subspace.blob.manifest";
    readonly profile: "net.subspace.identity.profile";
    readonly 'mail.envelope': "net.subspace.mail.envelope";
};
export type BuiltInMemoryType = keyof typeof BUILT_IN_NSIDS;
/**
 * Convert a legacy MemoryType string to its NSID equivalent.
 * Returns null if not a known built-in type.
 */
export declare function memoryTypeToNSID(type: string): string | null;
/**
 * Convert an NSID back to a legacy MemoryType string (for backward compat).
 * Returns null if the NSID is not a known built-in.
 */
export declare function nsidToMemoryType(nsid: string): string | null;
//# sourceMappingURL=nsid.d.ts.map