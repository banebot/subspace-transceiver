/*!
 * Subspace Engine — binary entrypoint.
 *
 * Spawned by the Node.js daemon as a child process. Communicates via stdio
 * JSON-RPC. See `bridge.rs` for the protocol details.
 *
 * Usage: subspace-engine [--log-level <level>]
 */

use anyhow::Result;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging to stderr only (stdout is reserved for JSON-RPC)
    tracing_subscriber::registry()
        .with(fmt::layer().with_writer(std::io::stderr))
        .with(EnvFilter::from_default_env().add_directive("subspace_engine=debug".parse()?))
        .init();

    let bridge = subspace_engine::bridge::Bridge::new();
    bridge.run().await?;

    Ok(())
}
