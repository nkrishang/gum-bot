# gum-bot

Perpetual live-volume testing for [Gum](https://gum.money). A funder key keeps 50 mover keys in gas on
Monad, Base and Arbitrum. Each mover holds 1 USDC and spends every cycle paying a fresh Gum deposit
whose receiver is itself. Settlement sends the USDC back, so the same 50 USDC circulate indefinitely
through the real production path: API → indexer → engine → `PaymentFactory` → settlement. A live
dashboard shows every deposit, mover, chain and latency stage.

```
            ┌──────────────── cycle ────────────────┐
 mover #i ──POST /v1/deposit {receiver: mover #i}──▶ Gum
 mover #i ──USDC.transfer(payment_address, 1 USDC)──▶ chain
                          Gum detects → confirms → settles ──▶ 1 USDC back to mover #i
            └─ all settled (or settle timeout) → next cycle ─┘
 funder ── gas top-up whenever a mover's MON/ETH < threshold
```

## The cycle

1. **Select.** Every enabled mover without an open deposit, with ≥ 1 USDC and some gas, joins. Mover
   *i* pays on `MOVER_CHAIN_ROTATION[i % n]`, or on whichever enabled chain holds its USDC.
2. **Create.** One `POST /v1/deposit` per mover: `chain_id` = its chain, `token` = `USDC`,
   `amount` = `1000000`, `receiver` = the mover, `expires_at` = now + 30 min, plus an
   `Idempotency-Key` so client retries can't create duplicates. All Gum calls share a client-side
   token bucket (40/s, burst 60) under Gum's per-key limit (50/s, burst 100). 429s back off and honor
   `Retry-After`.
3. **Verify.** Before sending any money, the bot checks the response: receiver, amount, chain and
   token must match, and `payment_address` must equal `PaymentFactory.paymentAddress(...)` evaluated
   on-chain from the deposit's terms. A mismatch is never paid. It is counted and raised as an alert,
   because it would mean a Gum bug that loses funds.
4. **Pay.** The mover transfers 1 USDC to the payment address and waits for the receipt.
5. **Settle.** Status comes from one `GET /v1/deposit?created_after=…` per poll, however many deposits
   are open. Signed webhooks can also feed it (optional). When the cycle's deposits are terminal, the
   bot re-reads balances and the next cycle starts after `CYCLE_MIN_INTERVAL_MS`. Deposits still open
   after `CYCLE_SETTLE_TIMEOUT_MS` carry over. The bot keeps tracking them, and their movers sit out
   until they resolve.
6. **Fuel.** Every `BALANCE_REFRESH_MS` a batched sweep reads every wallet on every chain. Movers below
   `GAS_MIN_<CHAIN>` get `GAS_TOPUP_<CHAIN>` from the funder. Top-ups go one at a time per chain, so the
   funder's nonces never race.

Every finished deposit's full Gum timeline (`GET /v1/deposit/id/{id}`) is fetched once. That timeline
gives a per-stage latency breakdown: create API → broadcast → inclusion → Gum detects → confirmations →
settlement submitted → included → settled.

## Run it locally

Needs Node ≥ 22.13, [pnpm](https://pnpm.io) 10 (`corepack enable` picks the pinned version) and
[Foundry](https://getfoundry.sh) (`anvil`).

```sh
pnpm install
pnpm local             # → http://localhost:8080
```

This starts three Anvil chains with the real Monad, Base and Arbitrum chain ids. It deploys the real
`PaymentFactory` and a mock USDC (from gum-contracts' build, `dev/artifacts/`) on each, and starts a
**mock Gum API** that settles through the factory. It gives 50 movers 1 USDC and no gas, then runs the
bot against all of it. The bot's first job is to fuel the movers, so the first cycles ramp from a few
movers to all 50. The mock copies gum-server's request validation, response shapes, statuses,
idempotency, rate limit, event timeline and webhook signatures.

```sh
pnpm local --movers 9 --fail-rate 0.1   # inject settlement failures
pnpm local --api-latency 150            # slow API
pnpm local --infra-only                 # chains + mock only; prints env for `pnpm dev`
pnpm dev:web                            # dashboard with hot reload (proxies to :8080)
```

Tests:

```sh
pnpm test             # unit: config, rate limiting, webhook signatures, deposit state machine
pnpm test:e2e         # full local stack with injected failures; asserts the bot's books match Gum's
```

## Run it for real

1. **Fund the funder** on each chain: gas (MON on Monad, ETH on Base and Arbitrum), plus 1 USDC per
   mover that will pay on that chain (17 / 17 / 16 for 50 movers).
2. **Create and fund the movers.** Put `FUNDER_PRIVATE_KEY` and the three `RPC_URL_*` in `.env`,
   then run `pnpm setup-movers`. It generates the 50 mover keys, shows the plan, and after you
   confirm, sends each mover 1 USDC on its chain. The keys go to `.movers/state.json` (mode 600,
   gitignored; **back it up, it is the only copy**). The bot's `MOVER_PRIVATE_KEYS` line is written
   to `.movers/movers.env`. The script is safe to re-run after a crash, a stuck transaction or an RPC
   error: it resumes where it stopped and never pays a mover twice. Each transfer is bound to one
   funder nonce, fee bumps replace it rather than duplicate it, and every signed transaction is
   recorded before it is broadcast. Movers need no gas up front; the bot tops them up on its first
   balance sweep.
3. **Configure.** `cp .env.example .env`, then fill in `GUM_API_KEY` (use a dedicated key: the bot is
   designed to own its 50 req/s), `FUNDER_PRIVATE_KEY`, `MOVER_PRIVATE_KEYS` and the three RPC URLs.
   Tune `GAS_*` per chain.
4. **When movers lose their USDC** (deposits that expired after payment):
   - `pnpm recover-stranded <file>` sends the stranded USDC to Gum's recovery address. It runs
     `PaymentFactory.execute` for each expired payment, with the funder paying gas. `<file>` lists the
     deposits and their terms (see `.movers/stranded-*.json`).
   - `pnpm setup-movers --refill <label>` then refills the movers that are short. On its first run a
     round takes every mover below one deposit that has no live deposit in flight. Re-running the same
     label resumes that exact set and never pays a mover twice; a new incident gets a new label.

   Both scripts are crash-safe and re-runnable, like the initial funding.
5. `pnpm dev`, or build and run: `pnpm build && pnpm start`.

### Railway (long-running)

The repo includes a `Dockerfile` and `railway.json` (health check `/readyz`, always restart, one
replica, no deploy overlap, and a required `/data` volume).

1. `railway init` (preferably a project of its own, separate from Gum's production services), then
   `railway add --service gum-bot` and `railway volume add --mount-path /data`.
2. Set the variables:

   | Variable | Value | Notes |
   |---|---|---|
   | `GUM_API_KEY`, `FUNDER_PRIVATE_KEY`, `MOVER_PRIVATE_KEYS` | from your `.env` | secrets |
   | `RPC_URL_MONAD` | your Monad RPC | secret |
   | `CHAINS`, `MOVER_CHAIN_ROTATION` | `monad` | |
   | `MAX_DEPOSITS_PER_MINUTE` | `50` | the hard cap (§ below) |
   | `RPC_RPS_MONAD` | `25` | leaves headroom on a 50/s QuickNode plan |
   | `BALANCE_REFRESH_MS` | `60000` | a full balance sweep once a minute is plenty at this rate |
   | `CYCLE_SETTLE_TIMEOUT_MS` | `120000` | a stuck deposit holds its mover, not the whole fleet |
   | `RETAIN_DAYS` | `7` | ~500k deposit rows at 50/min |
   | `DASHBOARD_PASSWORD` | long random string | **required**: the bot refuses to start on Railway without it |
   | `METRICS_TOKEN` | random string | protects `/metrics` |
   | `ALERT_WEBHOOK_URL` | Slack/Discord incoming webhook | recommended: nobody watches a background bot |
   | `RAILWAY_RUN_UID` | `0` | **required with the volume**: Railway mounts `/data` owned by root, and the image runs as `node` (without it the bot crash-loops on "unable to open database file") |

3. `railway up --detach`, then `railway domain` for the dashboard URL.

**Rate cap.** `MAX_DEPOSITS_PER_MINUTE` is a hard ceiling. No rolling 60 s window, as Gum's own
`created_at` sees it, ever holds more than that many deposits. Each deposit holds its slot from the
request until a full minute after Gum's response, so latency jitter can't let two bursts overlap. The
window is re-seeded from the database on restart. Deposits are created in bursts, not spread evenly.
With 50 movers and a cap of 50 that means one cycle a minute.

**One instance only.** Two bots sharing the mover keys would fight over nonces and USDC. `railway.json`
pins one replica. At startup the bot also asks Gum for deposits to its movers created in the last 2
minutes that it didn't create. If it finds any, another instance is running (e.g. `pnpm dev` on your
laptop while the Railway service is up), so it refuses to start. Stop one, wait 2 minutes, start the
other.

**Deploys and restarts** are safe. On SIGTERM the bot stops starting cycles, lets in-flight transfers
land (≤ 20 s), persists and exits. Open deposits are picked up again on the next boot, and counters
survive even a hard kill.

**Payments** are signed locally and their hash recorded before broadcast. Retries resend the same signed
bytes (same nonce), so RPC errors can never cause a double payment, and the bot always knows which
transaction to look for.

## Observability

**Dashboard** (`/`): live over SSE, one snapshot a second.

- **Alerts**: RPC down, funder low, movers without USDC or gas, deposits paid but unsettled for
  over 10 min, runner paused.
- **KPIs**: settled (all time, last hour, volume), created, paid, settlement success rate,
  failed/expired (unpaid expiries counted separately), open deposits.
- **Throughput**: settled, created or failed per minute, stacked by chain, last hour.
- **Cycle**: planned → created → paid → settled progress, elapsed time, why movers are sitting out,
  recent cycle durations.
- **Where the time goes**: median and p90 per pipeline stage, per chain. Pay-inclusion, detect,
  settle and end-to-end percentiles by chain.
- **Gum API**: live req/s against the limit, per-endpoint latency, status codes (429s and 5xx
  highlighted), webhook count, which chains get address verification.
- **Chains**: RPC health and latency, head block, funder balance with top-ups remaining,
  per-chain outcomes and gas settings.
- **Movers**: 50 tiles with health (icon + label), phase, USDC, gas vs threshold, pending top-up.
  Click one for balances on every chain, history, a manual top-up and enable/disable.
- **Deposits**: live table. Click a row for the merged timeline: the bot's own steps, Gum's events,
  and webhook lag.
- **Activity**: cycles, top-ups, failures, expiries, refusals, operator actions.

**Prometheus** (`/metrics`): `gumbot_deposits_created_total{chain}`,
`gumbot_deposit_outcomes_total{chain,status}`, `gumbot_payment_address_mismatch_total`,
`gumbot_settlement_seconds{chain}`, `gumbot_detect_seconds`, `gumbot_end_to_end_seconds`,
`gumbot_payment_inclusion_seconds`, `gumbot_gum_requests_total{op,status}`,
`gumbot_gum_request_seconds{op}`, `gumbot_webhooks_total`, `gumbot_webhook_lag_seconds`,
`gumbot_gas_topups_total{chain,outcome}`, `gumbot_movers{health}`,
`gumbot_mover_native_balance{mover,chain}`, `gumbot_mover_token_balance`,
`gumbot_funder_native_balance{chain}`, `gumbot_open_deposits`, `gumbot_rpc_errors_total`,
`gumbot_cycle_seconds`, `gumbot_paused`, plus process metrics. Worth alerting on: any
`deposit_outcomes{status!="settled"}` increase, any address mismatch, `movers{health="no_token"} > 0`,
settlement p90, and a low funder balance.

**Logs**: one JSON line per event on stdout (`LOG_FORMAT=pretty` locally). Keys are redacted.

**API**: `GET /api/snapshot`, `GET /api/stream` (SSE), `GET /api/deposits?mover=&chain=&status=`,
`GET /api/deposits/:id` (includes Gum's live view), `GET /api/movers/:i`,
`POST /api/control/{pause,resume}`, `POST /api/movers/:i/{enable,disable,topup}`,
`POST /api/balances/refresh`. Health checks are at `/healthz` and `/readyz`.

## Notes

- Gum's deposit field is `receiver` (not `recipient`), and `expires_at` is required, at least 5 min
  out. The bot uses 30 min.
- USDC addresses (Circle's native USDC) and block explorers per chain are constants in
  `src/config.ts` (`CHAIN_INFO`), not configuration. At boot the bot warns if Gum's `/v1/chains` lists a
  different USDC, since every deposit on that chain would then be refused.
- A failed or expired settlement leaves that mover's USDC with Gum's recovery address. The mover goes
  to **No USDC** and sits out until `pnpm bootstrap --execute` refunds it. The bot deliberately
  never moves USDC by itself: the funder only ever sends gas.
- Monad charges gas by gas limit, which is why its default thresholds are much larger than Base's
  and Arbitrum's. Tune `GAS_*_MONAD` to the network's current fees.

## Layout

```
src/        runner (cycle), tracker (status polling), treasury (balances + top-ups), bot (state),
            gum (API client), server (HTTP, SSE, webhooks), snapshot (dashboard model), db (SQLite)
web/        dashboard (React + Vite, built into dist/web and served by the bot)
dev/        local stack: anvil orchestration, mock Gum, contract artifacts
scripts/    setup-movers (one-time mover creation + funding), bootstrap (refills)
test/       unit tests + local end-to-end
```
