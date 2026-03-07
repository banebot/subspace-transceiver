How the E2E tests work

 ### The fundamental constraint they solve

 The normal daemon is designed to connect to public IPFS bootstrap nodes the moment it starts. You can't use that in tests — it'd be
 slow, flaky, and would contaminate a shared public network with test garbage. So the first thing we had to build was a way to run
 the system in isolation.

 The isolation mechanism is a single env var: SUBSPACE_BOOTSTRAP_ADDRS=""

 When that's set to empty string, the code in packages/core/src/node.ts replaces the hardcoded IPFS bootstrap list with nothing. The
 daemon still starts a full libp2p node — TCP transport, mDNS, DHT, GossipSub, everything — but it doesn't try to dial any external
 peers. Instead, agents find each other via mDNS multicast on localhost, which works automatically when two processes are on the
 same machine.

 Similarly SUBSPACE_RELAY_ADDRS="" disables the circuit relay (NAT traversal) nodes, and SUBSPACE_MANIFEST_INTERVAL_MS=2000 shrinks
 the 60-second discovery broadcast to 2 seconds so discovery tests don't take two minutes.

 ────────────────────────────────────────────────────────────────────────────────

 ### What npm run test:e2e actually does

 1. Vitest reads e2e/vitest.config.ts, which tells it: find all *.e2e.ts files under e2e/, run them one at a time
    (fileParallelism: false, maxConcurrency: 1), each in its own forked process, with 120-second test timeouts.
    fileParallelism: false is critical — each test file spawns 2–4 daemon processes, and running them concurrently would create
    20–30 daemons simultaneously, exhausting ports and causing GossipSub mesh failures and latency regressions.
 2. Each test file creates a TestHarness in its beforeAll. The harness is what manages the daemon processes for that file.
 3. harness.startAgents(['alpha', 'beta']) — for each name, the harness:
     - Generates a random 4-byte run ID
     - Creates a temp directory under /tmp/subspace-e2e-<runId>-<i>/
     - Spawns node packages/daemon/dist/index.js --foreground --port 174XX as a child process with those isolation env vars set
     - Registers the process's stdout/stderr to print prefixed lines like [alpha] [subspace] Connected... to your terminal (via
       stderr so it doesn't pollute test output)
     - Creates a typed DaemonClient pointed at http://127.0.0.1:174XX
 4. startAgents then polls GET /health on every agent in parallel using pollUntil(), which loops every 500ms until the daemon
    responds { status: "ok" } or 30 seconds pass. This is when agent.peerId gets populated.
 5. The test body runs. Every API call goes through DaemonClient, which is a thin typed wrapper around fetch(). A failed HTTP
    response (!res.ok) throws a typed error with .status and .code on it, which is why tests can do rejects.toMatchObject({ status: 429 }).
 6. For P2P assertions, instead of expect(beta.searchMemory(...)).toBe(...) which would race, tests use pollUntil() — it retries the
    check every 500ms until it passes or times out. This is the right pattern for eventual consistency. A typical replication test
    looks like:

 ```
   Alpha writes chunk → pollUntil(Beta finds it via search, 60s) → assert content matches
 ```

    When Beta calls searchMemory("marker"), the daemon fans that out via the /subspace/query/1.0.0 libp2p protocol to all connected
    peers — so it dials Alpha's libp2p port directly and asks for matching chunks. The response comes back through the HTTP API.

 7. afterAll(() => harness.teardown()) — sends SIGTERM to all child processes, waits 1 second, SIGKILLs any stragglers, then rm -rfs
    all the temp directories.

 ────────────────────────────────────────────────────────────────────────────────

 ### Port allocation — avoiding conflicts

 Each harness run uses BASE_PORT (17432) + i + (runId % 100). The runId is 4 random bytes, so runId.slice(0,2) parsed as hex gives
 0–255, modulo 100 gives 0–99. This means two different test files running simultaneously (if file parallelism were ever re-enabled)
 won't clash on ports, and they also won't clash with a real daemon the developer has running on 7432.

 ────────────────────────────────────────────────────────────────────────────────

 ### How the two execution modes differ

 Localhost mode (default, E2E_MODE=localhost): the harness spawns daemon processes directly. Fast — a daemon comes up in ~3–5
 seconds. The daemon logs stream to your terminal prefixed with [alpha].

 Docker mode (E2E_MODE=docker, npm run test:e2e:docker): docker compose up starts three agent containers (agent-alpha, agent-beta,
 agent-gamma) and a runner container. The agents are already running before the runner starts — Docker Compose's depends_on:
 condition: service_healthy ensures this. The runner container just runs vitest with E2E_MODE=docker, and the harness's
 startDockerAgents reads ALPHA_URL=http://agent-alpha:7432 from env instead of spawning anything. The tests themselves are identical
 — the harness abstraction hides the difference completely.

 ────────────────────────────────────────────────────────────────────────────────

 ### How discovery manifests work in tests

 PSK-network peers exchange discovery manifests — compact bloom-filter summaries of what content each agent holds — via two paths:

 1. GossipSub broadcast (every SUBSPACE_MANIFEST_INTERVAL_MS, default 60s, set to 2s in tests)
 2. Direct /subspace/manifest/1.0.0 exchange triggered on every new peer connection

 Path 2 is the reliable one for tests: as soon as two PSK peers connect (in joinAllToPsk()), the daemon immediately dials the
 remote's manifest protocol and reads their manifest. The peerIndex is populated within milliseconds of connection, not 2 seconds.

 For tests that add new content and want discovery to reflect it, call harness.client('alpha').rebroadcastManifests(). This hits
 POST /discovery/rebroadcast on the daemon, which both re-publishes via GossipSub and actively pulls manifests from all connected
 PSK peers. The discovery tests use this after putting content to force a fast manifest sync rather than waiting for the 2s interval.

 ────────────────────────────────────────────────────────────────────────────────

 ### The tricky part — OrbitDB replication vs query protocol

 OrbitDB's CRDT replication channel uses GossipSub internally. Due to a stream API mismatch between
 @chainsafe/libp2p-gossipsub@14 and libp2p@3, OrbitDB's automatic sync does not replicate chunks between agents' local stores.

 Content is still accessible cross-agent via the /subspace/query/1.0.0 protocol — Beta dials Alpha and asks for chunks matching the
 query. The replication tests use this path (searchMemory → query protocol → Alpha's local store) rather than asserting that chunks
 magically appear in Beta's local store. Once the OrbitDB 4.x upgrade lands, both the query-protocol path and automatic local-store
 replication will satisfy the same assertions.

 Discovery manifests and browse protocol are NOT affected by this bug — they run on their own libp2p protocols.

 ────────────────────────────────────────────────────────────────────────────────

 ### A concrete example: the replication test

 ```
   beforeAll:
     harness.startAgents(['alpha', 'beta'])   → two daemons on ports 17432, 17433
     harness.waitForMesh(1, 45_000)           → poll until both have globalPeers >= 1
                                                 (mDNS kicks in within ~5s)
     harness.joinAllToPsk()                   → POST /networks {psk: random hex}
                                                 on both, wait until peers >= 1

   it('Beta finds Alpha's chunk'):
     uniqueMarker = "alpha-marker-1741291234567"

     harness.client('alpha').putMemory({...content: uniqueMarker...})
     → POST http://127.0.0.1:17432/memory
     → daemon signs it, stamps PoW, writes to OrbitDB
     → returns chunk with id + signature

     pollUntil(60_000, () => {
       results = harness.client('beta').searchMemory(uniqueMarker)
       → POST http://127.0.0.1:17433/memory/search {freetext: uniqueMarker}
       → daemon fans out: GET /subspace/query/1.0.0 on all connected peers
       → Alpha's daemon receives the query, runs it against its local store
       → returns chunks whose content contains uniqueMarker
       return results.some(c => c.id === chunk.id)
     })

     assert: found.source.peerId === alpha's peerId  ✓
     assert: found.signature is truthy               ✓
 ```

 The first time through the poll loop Beta probably gets an empty result because the query protocol connection isn't established
 yet. By the 2nd or 3rd tick (1–1.5 seconds) the libp2p connection is live and Alpha responds. The 60-second timeout is the safety
 net for slow machines or high load.
