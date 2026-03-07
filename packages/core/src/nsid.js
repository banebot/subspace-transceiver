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
// ---------------------------------------------------------------------------
// NSID validation regex
// ---------------------------------------------------------------------------
const SEGMENT_RE = /^[a-z][a-z0-9-]*$/;
const MAX_NSID_LEN = 253;
const MIN_SEGMENTS = 3;
/**
 * Validate a single NSID segment.
 * Segments must start with a lowercase letter and contain only lowercase
 * alphanumeric characters and hyphens.
 */
function isValidSegment(seg) {
    return seg.length > 0 && SEGMENT_RE.test(seg);
}
/**
 * Check if a string is a valid NSID.
 */
export function isValidNSID(nsid) {
    if (!nsid || nsid.length > MAX_NSID_LEN)
        return false;
    const segments = nsid.split('.');
    if (segments.length < MIN_SEGMENTS)
        return false;
    return segments.every(isValidSegment);
}
/**
 * Parse an NSID string into its components.
 * Throws if the NSID is invalid.
 */
export function parseNSID(nsid) {
    if (!isValidNSID(nsid)) {
        throw new Error(`Invalid NSID: "${nsid}". Must have ≥3 dot-separated lowercase segments.`);
    }
    const segments = nsid.split('.');
    // Authority = first 2 segments reversed (reverse-DNS convention)
    const authority = segments.slice(0, 2).reverse().join('.');
    const name = segments.slice(2).join('.');
    return {
        nsid,
        authority,
        name,
        segments,
        toString: () => nsid,
    };
}
/**
 * Check if an NSID matches a pattern.
 * Patterns support a trailing '*' wildcard:
 *   'net.subspace.*'  matches 'net.subspace.memory.skill', 'net.subspace.blob.manifest', etc.
 *   'net.subspace.memory.skill'  matches only that exact NSID
 */
export function nsidMatches(nsid, pattern) {
    if (pattern === '*')
        return true;
    if (pattern.endsWith('.*')) {
        const prefix = pattern.slice(0, -2); // remove '.*'
        return nsid === prefix || nsid.startsWith(prefix + '.');
    }
    return nsid === pattern;
}
/**
 * Built-in NSIDs — maps old MemoryType enum values to their NSID equivalents.
 */
export const BUILT_IN_NSIDS = {
    skill: 'net.subspace.memory.skill',
    project: 'net.subspace.memory.project',
    context: 'net.subspace.memory.context',
    pattern: 'net.subspace.memory.pattern',
    result: 'net.subspace.memory.result',
    document: 'net.subspace.memory.document',
    schema: 'net.subspace.schema.definition',
    thread: 'net.subspace.memory.thread',
    'blob-manifest': 'net.subspace.blob.manifest',
    profile: 'net.subspace.identity.profile',
    // Mail
    'mail.envelope': 'net.subspace.mail.envelope',
};
/**
 * Convert a legacy MemoryType string to its NSID equivalent.
 * Returns null if not a known built-in type.
 */
export function memoryTypeToNSID(type) {
    return BUILT_IN_NSIDS[type] ?? null;
}
/**
 * Convert an NSID back to a legacy MemoryType string (for backward compat).
 * Returns null if the NSID is not a known built-in.
 */
export function nsidToMemoryType(nsid) {
    for (const [type, n] of Object.entries(BUILT_IN_NSIDS)) {
        if (n === nsid)
            return type;
    }
    return null;
}
//# sourceMappingURL=nsid.js.map