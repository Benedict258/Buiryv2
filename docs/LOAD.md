# Load and latency (Phase 10, 2026-11-17)

`scripts/load/run.ts`. Local runs use the real HTTP server over mocks (PGlite, one Windows development machine, sequential calls), so absolute numbers are indicative only. The testnet run uses the real relayer and the Tatum gateway. Raw results are in `.buiry-local/load/`.

## Local, one project

| Operation (over HTTP)                     | 1k memories p50 / p95 | 10k memories p50 / p95 |
| ----------------------------------------- | --------------------- | ---------------------- |
| Briefing (`buiry_check`)                  | 132 / 192 ms          | 257 / 390 ms           |
| Recall                                    | 53 / 61 ms            | 111 / 166 ms           |
| Remember                                  | 54 / 72 ms            | 124 / 225 ms           |
| Dashboard memory list (50)                | 23 / 30 ms            | 61 / 112 ms            |
| Dashboard list, filtered by type and text | 22 / 31 ms            | 33 / 44 ms             |

- **SSE:** 20 open activity streams all received a new event; p50 444 ms, max 1.1 s. The server polls every second.
- **Backpressure:** a burst of 50 writes from an agent limited to 20 a minute gave 20 accepted and 30 refused with `budget_exceeded` and a retry-after. With the backlog cap below the queue size, writes are refused with "write backlog is full; storage is catching up".
- **Seeding speed:** 10k memories in 20-item bulk writes took about 17 minutes on PGlite (about 9 writes a second at 10k). The conflict scan runs on every write.

## Fixes from this phase

- **Write latency grew with project size.** The per-write conflict scan fetched 300 full rows; it now reads four columns, plus an index on recent memories. Remember p50 went from 76 to 54 ms at 1k and from 147 to 124 ms at 10k.
- **One briefing in 20 failed with "fetch failed"** right after a long idle period, in both 10k runs. Agent reads are now retried once after a network failure with no response (writes never are), and errors keep the cause.

## Testnet (light)

| Operation                          | Result                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Remember (accept)                  | p50 113 ms; 4 of 10 refused by the default agent budget (6 writes a minute), as designed |
| Store on Walrus                    | 6 of 6 stored within 120 s                                                               |
| Briefing                           | p50 49 ms                                                                                |
| Recall (relayer with Seal session) | p50 1.9 s, p95 6.6 s (the first recall builds the Seal session)                          |

## Not measured

- Concurrent agents against Postgres.
- Several API tasks behind a load balancer.
- Relayer rate limits under sustained load (the mock enforces the documented limits; the tests show the drain never trips them).
- Projects beyond 10k memories.
