# Top 100 Profitable Ethereum Wallets (MVP)

Live leaderboard of the most profitable wallets over a rolling time window (default 7 days), ranked by **realized PnL in ETH**. Only wallets with positive PnL are listed.

## Run

```bash
npm install
cp .env.example .env     # add your wss:// RPC URL (e.g. from Alchemy)
npm start                # needs Node 20.6+
# open http://localhost:3000
```

Project layout:

```
server.js
package.json
.env
public/index.html
```

## Configuration (.env)

| Variable | Default | Meaning |
|---|---|---|
| `ETH_WS_URL` | required | Ethereum mainnet WebSocket endpoint (`wss://...`) |
| `WINDOW_DAYS` | 7 | Rolling window. Only trades newer than this count toward PnL |
| `BACKFILL` | true | Scan past blocks on startup. `false` = only trades seen since start |
| `MIN_TRADES` | 3 | Minimum buys+sells inside the window to be listed |
| `MIN_POOL_WETH` | 20 | Ignore pools with less WETH liquidity than this (scam filter) |
| `MIN_TRADE_ETH` | 0.01 | Ignore trades smaller than this |
| `PORT` | 3000 | HTTP port |

## How it works

1. **Backfill.** On startup it scans the last `WINDOW_DAYS` of blocks (about 7,200 blocks per day) for Uniswap V2-style `Swap` events, fetching each block with full transactions to get the real sender (`tx.from`) and timestamp. Progress shows on the page.
2. **Live.** Then it follows new swaps over WebSocket. Live trades wait until the backfill finishes.
3. **PnL engine.** Per wallet, per pool, average cost basis in ETH. A sell with no known cost basis is skipped, so it never invents profit.
4. **Rolling window.** Each trade is stored with a timestamp. Ranking sums only trades inside the window, so old trades drop out over time.
5. **Filters.** WETH-paired pools above `MIN_POOL_WETH`, trades above `MIN_TRADE_ETH`, wallets with at least `MIN_TRADES` and one completed sell, PnL above zero, and EOAs only (contract wallets are checked when a wallet reaches the top region).
6. **Delivery.** The board is recomputed at most every 1.5 seconds after a trade and pushed over WebSocket only if the ranking changed.
7. **State.** Saved to `state-v2.json` every 60 seconds and on exit. On restart it resumes from the last processed block, so downtime is caught up.

## Changing the window

If you change `WINDOW_DAYS` (for example from 1 to 7), delete `state-v2.json` and restart. Otherwise the app only scans blocks newer than the saved ones, and the older part of the new window stays empty. The old `state.json` from the first version is no longer used and can be deleted.

## Known limits (read before trusting the numbers)

- **Coverage is narrow.** Uniswap V2-style pools paired with WETH only. No Uniswap V3, no stablecoin pairs, no aggregator or other-venue accounting. The true top wallets on Ethereum are probably not in this list.
- **Realized PnL only,** in ETH, not USD. A buy and sell must both fall inside the covered range. A wallet that bought before the window and sold inside it is skipped.
- **`tx.from` is not always the true trader** (smart wallets, relayers). Some bot EOAs can still appear.
- **Pool liquidity filter** uses each pool's current reserves, not reserves at trade time.
- **Small samples.** A high PnL from a few trades can be luck, not skill.
- **Token transfers and airdrops** are ignored.
- **Cost.** The first backfill makes many RPC calls (one block request per block with swaps, plus pool lookups). Check your provider's usage. Test with `WINDOW_DAYS=1` first.
- **Performance.** Ranking is recomputed in memory over all stored trades. Fine for a prototype. Move state to Postgres and the leaderboard to a Redis sorted set if it grows.

## Verify before relying on it

Wait until the status shows plain "Live" (backfill finished), then check the top few wallets on Etherscan or DeBank and compare their trades with the app's numbers.

## Next steps

1. Verify PnL against a few real wallets.
2. Add Uniswap V3 and stablecoin pairs.
3. Add USD-denominated PnL.
4. Move to Postgres and Redis.
