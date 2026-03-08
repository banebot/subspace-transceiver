/*!
 * Tests for ALPN protocol constants and endpoint configuration.
 */

use subspace_engine::protocols::alpn;

#[test]
fn test_alpn_constants_are_valid_utf8() {
    for alpn_bytes in alpn::ALL {
        assert!(
            std::str::from_utf8(alpn_bytes).is_ok(),
            "ALPN must be valid UTF-8: {:?}",
            alpn_bytes
        );
    }
}

#[test]
fn test_alpn_constants_start_with_subspace_prefix() {
    for alpn_bytes in alpn::ALL {
        let alpn_str = std::str::from_utf8(alpn_bytes).unwrap();
        assert!(
            alpn_str.starts_with("/subspace/"),
            "ALPN must start with /subspace/: {}",
            alpn_str
        );
    }
}

#[test]
fn test_alpn_constants_have_version() {
    for alpn_bytes in alpn::ALL {
        let alpn_str = std::str::from_utf8(alpn_bytes).unwrap();
        assert!(
            alpn_str.ends_with("/1.0.0"),
            "ALPN must end with /1.0.0: {}",
            alpn_str
        );
    }
}

#[test]
fn test_all_alpns_are_unique() {
    use std::collections::HashSet;
    let set: HashSet<&&[u8]> = alpn::ALL.iter().collect();
    assert_eq!(set.len(), alpn::ALL.len(), "All ALPN constants must be unique");
}

#[test]
fn test_specific_alpn_values() {
    assert_eq!(alpn::BROWSE, b"/subspace/browse/1.0.0");
    assert_eq!(alpn::QUERY, b"/subspace/query/1.0.0");
    assert_eq!(alpn::MANIFEST, b"/subspace/manifest/1.0.0");
    assert_eq!(alpn::MAILBOX, b"/subspace/mailbox/1.0.0");
    assert_eq!(alpn::NEGOTIATE, b"/subspace/negotiate/1.0.0");
}

#[test]
fn test_alpn_all_count() {
    assert_eq!(alpn::ALL.len(), 5, "Should have exactly 5 Subspace protocols");
}
