# Benchmarks

| | |
|---|---|
| Status | Phase 2, Stage 4 — first measurement |
| Measured | 2026-11-10 (UTC) |
| Raw data | [`benchmarks/2026-11-10-browser.json`](benchmarks/2026-11-10-browser.json), [`benchmarks/2026-11-10-builds.json`](benchmarks/2026-11-10-builds.json) |
| Re-run | `npm run bench` (browser, ≈ 5 min) and `npm run bench:builds` (Node, lite vs full, ≈ 5 min) |

These are the **only** source for engine timings in the docs or the UI (testing strategy §5). The numbers are from one machine and must not be presented to users as promises.

## 1. Machine and method

| | |
|---|---|
| CPU | 11th Gen Intel Core i5-11400H @ 2.70 GHz, 6 cores / 12 threads (`hardwareConcurrency` 12 → default pool `clamp(12 − 1, 1, 4)` = **4**) |
| RAM | 15.8 GB |
| OS | Windows 11 Home, build 10.0.26300 |
| Browser | Chromium 156.0.8078.4 (Playwright, headless), production build (`vite build` + `vite preview`, with the production CSP) |
| Engine | npm `stockfish` 19.0.1, lite single-threaded WASM (`nn-61e7af4bb97d.nnue`) |
| Node (build comparison) | v24.22.1, engine as a child process |

- **Browser benchmark** (`tests/benchmark/benchmark.spec.ts`).
  - Each run uses a **fresh browser context**: an empty IndexedDB, so nothing is reused. It imports the game through the UI, picks the preset and engine count in the debug view, and presses **Analyse game**.
  - Per-position times (`timeMs`: from the search's `readyok` to `bestmove`) and nodes are read from the stored `RawAnalysis`.
  - Wall time runs from the click to "Completed".
  - Long tasks over 50 ms are recorded by a `PerformanceObserver` on the page. The E2E test proves the observer works with a deliberate 120 ms task.
- **Fixture games:** `02-blitz` (77 positions, master blitz), `21-daily` (87, amateur daily), `23-daily` (21), `07-bullet` (39).

## 2. Results (Chromium)

### 2.1 Engine start
| | `uci` → `uciok` | → `readyok` |
|---|---|---|
| Cold (fresh context) | 116 ms | 119 ms |
| Warm (5 runs) | 104–107 ms | 105–110 ms |

### 2.2 Cost per position, one engine (no contention)
| Preset (nodes, depth cap, MultiPV) | Game | Positions | p50 | p95 | Max | Depth p50 (min) | Nodes/s p50 |
|---|---|---|---|---|---|---|---|
| Quick (150 000, 18, 1) | 02-blitz | 77 | 236 ms | 368 ms | 466 ms | 17 (13) | 574 728 |
| Quick | 21-daily (amateur) | 87 | 225 ms | 279 ms | 362 ms | 16 (12) | 581 465 |
| Standard (600 000, 22, 2) | 02-blitz | 77 | 1 051 ms | 1 191 ms | 1 253 ms | 18 (15) | 564 461 |
| Deep (2 500 000, 30, 2) | 23-daily | 21 | 4 343 ms | 4 681 ms | 4 765 ms | 22 (19) | 563 192 |

The node budget ends almost every search. The depth cap applies only in simple positions, such as forced mates.

### 2.3 Whole game by engine count (02-blitz, 77 positions)
| Preset | 1 engine | 2 engines | 3 engines | 4 engines | Speed-up at 4 |
|---|---|---|---|---|---|
| Quick | 20.6 s | 9.3 s | 6.7 s | 5.9 s | 3.5× |
| Standard | 79.1 s | — | — | 19.6 s | 4.0× |

At the default pool (4), a Deep game of about 80 positions is estimated at 80 × 4.34 s / 4 ≈ **87 s**. That figure is derived from §2.2, not measured as a whole game.

### 2.4 Main-thread responsiveness
**0 long tasks over 50 ms in every run**, including 1–4 engines, all three presets, and the throttled run in §2.6. This meets the roadmap's Phase 2 exit criterion. The E2E test `analysis.spec.ts` asserts it on every run, with a control task proving the observer works.

### 2.5 Memory
| Engines | Renderer private bytes before → peak | Per engine (approx.) |
|---|---|---|
| 1 | 50.2 → 223.5 MB | ≈ 173 MB |
| 4 | 50.8 → 631.9 MB | ≈ 145 MB |

**Method:**
- The private bytes of all Chromium renderer processes are summed (`SystemInfo.getProcessInfo` + Windows `Get-Process`); dedicated workers run inside the renderer.
- The peak during the run minus the value before Start, divided by the engine count.

**Caveats:** this is approximate, because it includes the app's own allocations during the run. Per-worker heap APIs (`measureUserAgentSpecificMemory`) require cross-origin isolation, which this app deliberately avoids (D7).

### 2.6 Simulated slower hardware
- **Setup:** CDP `Emulation.setCPUThrottlingRate` at 4×, Quick, one engine, 07-bullet. Result: per-position p50 **234 ms**, against 222 ms unthrottled.
- **What it shows:** CDP throttling slows the page's main thread, **not dedicated workers**. So this run measures a slow UI thread (still 0 long tasks), **not** a slower engine.
- **Engine speed on weaker machines** isn't simulated here. Engine time per position scales with nodes ÷ nodes-per-second, so a machine with half the speed takes twice the per-position times in §2.2. Running fewer engines is the other lever, and the setting is user-configurable.

### 2.7 IndexedDB
Standard analysis record for a 77-position game: 41 963 bytes of JSON.

| | p50 | p95 |
|---|---|---|
| Read (`get`) | 0.50 ms | 0.60 ms |
| Write (`put`) | 1.00 ms | 1.20 ms |

Saving at most once per 250 ms (decision D12) costs well under 1% of the main thread.

## 3. Lite vs full build (decision U4)

Node child processes, same 33 positions (every 8th position of 02-blitz and 21-daily, plus the 12 engine fixture positions), at the Deep preset (2 500 000 nodes, depth 30, MultiPV 2).

| | Lite single (`stockfish-19-lite-single`) | Full single (`stockfish-19-single`) |
|---|---|---|
| Download | 1.8 MB | 99.2 MB |
| Start to `readyok` | 158 ms | 526 ms |
| Process private memory (idle / peak) | 154 / 156 MB | 438 / 440 MB |
| Nodes/s p50 | 569 686 | 318 455 (1.8× slower) |
| Time per position p50 / p95 | 4.37 s / 4.86 s | 7.64 s / 9.68 s |
| Same best move as the other build | 24 of 33 (73%) | |
| Top-line difference where both are centipawns (23 positions) | p50 19 cp, p95 103 cp, max 165 cp | |

## 4. Conclusions and decisions

| Item | Decision | Evidence |
|---|---|---|
| **Preset node budgets** | **Kept as in spec D8** (Quick 150k/18/1, Standard 600k/22/2, Deep 2.5M/30/2). | Targets set here for a typical 80-position game at the default pool: Quick ≤ 10 s, Standard ≤ 30 s, Deep ≤ 2 min. Measured: 5.9 s, 19.6 s, ≈ 87 s. Even with one engine (a proxy for a small machine), Quick takes 21 s and Standard 79 s. Search depth (p50 17 / 18 / 22) rises usefully between presets. A change would also change the settings hash (new analyses), so there's no reason to change values that meet the targets. |
| **Default pool size** | **Kept: `clamp(hardwareConcurrency − 1, 1, 4)`** (4 here). User-configurable (1–4) in the debug view. | Speed-up of 3.5× (Quick) and 4.0× (Standard) at 4 engines, with diminishing returns from 3 to 4 at Quick. About 145–173 MB per engine. |
| **Search time cap** | **Changed: `10 s + nodes / 50 000`** (was `15 s + nodes / 20 000`): Quick 13 s, Standard 22 s, Deep 60 s. | It assumes at least 50k nodes/s, about 11× below the measured median. That is 13–28× the slowest measured search per preset (asserted in `timeouts.test.ts`), so a hung engine is detected within a minute instead of 2.4 min at Deep. |
| **Other watchdogs** | Kept: init 10 s (measured 0.12 s), inactivity 30 s, stop 2 s (measured 20–53 ms). | §2.1; Stage 1 spike |
| **U4: full build for Deep** | **Decided 2026-11-11 (owner): don't add it. Lite only.** | The full build costs a 99 MB download, about 2.8× the memory per engine (the pool would need to shrink to 1–2), and 1.8× fewer nodes per second. Its evaluations differ (same best move in 73% of positions, median 19 cp apart), so mixing builds would make results incomparable. That is why the engine identity is part of the key. Lite at Deep already reaches depth 22 (p50) in about 4.3 s per position. Revisit if Phase 3 classification shows instability that a stronger network would fix. |

## 5. Limitations and follow-ups
- One machine (a 6-core laptop). Slower or lower-memory machines weren't measured: §2.6 explains why CPU throttling can't stand in for them.
- **Memory on low-RAM devices:** 4 engines ≈ 0.6 GB. A future improvement could cap the "auto" engine count by `navigator.deviceMemory` (Chromium only). This is not in Phase 2 scope; it's recorded as a risk in the roadmap.
- Firefox was not benchmarked: Playwright's Firefox can't start on this machine (R14).
- Re-run `npm run bench` after any engine, preset or pool change, and update this file.
