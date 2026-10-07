import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createPublicClient, webSocket, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS_URL = process.env.ETH_WS_URL;
if (!WS_URL) { console.error('Set ETH_WS_URL in .env (wss:// endpoint)'); process.exit(1); }

const PORT = Number(process.env.PORT || 3000);
const TOP_N = 30;
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS || 7);        // rolling window
const BACKFILL = process.env.BACKFILL !== 'false';
const MIN_TRADES = Number(process.env.MIN_TRADES || 3);          // buys+sells inside the window
const MIN_POOL_WETH = Number(process.env.MIN_POOL_WETH || 20);   // ignore thin pools (scam filter)
const MIN_TRADE_ETH = Number(process.env.MIN_TRADE_ETH || 0.01); // ignore dust
const PUBLISH_MS = 1500;                                         // max delay between a trade and a board refresh
const BLOCKS_PER_DAY = 7200;
const STATE_FILE = path.join(__dirname, 'state-v2.json');
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const E18 = 10n ** 18n;

const ABI = parseAbi([
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
]);
const SWAP = ABI[0];

const client = createPublicClient({ chain: mainnet, transport: webSocket(WS_URL, { reconnect: true }) });

// ---- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, n = 5) { // retries only rate-limit / network errors, not contract reverts
  for (let a = 0; ; a++) {
    try { return await fn(); } catch (e) {
      if (a >= n || !/429|rate|limit|timeout|ECONN|socket/i.test(String(e.message))) throw e;
      await sleep(500 * 2 ** a);
    }
  }
}
async function pmap(items, fn, limit) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// ---- state: wallet -> { pos: { pool: { amt: bigint, cost: ETH } }, ev: [[unixTs, realizedPnlEth, isSell], ...] }
const bigintReplacer = (_, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v);
const bigintReviver = (_, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
let wallets = new Map();
let meta = { lastBlock: 0 };
try {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'), bigintReviver);
  wallets = new Map(Object.entries(s.wallets)); meta = s.meta;
  console.log(`Loaded ${wallets.size} wallets, last block ${meta.lastBlock}`);
} catch { /* first run */ }

function saveState() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ meta, wallets: Object.fromEntries(wallets) }, bigintReplacer));
  fs.renameSync(tmp, STATE_FILE);
}

// ---- caches
const pools = new Map();   // pool -> { wethIs0 } | null
const eoaCache = new Map();

async function poolInfo(addr) {
  if (pools.has(addr)) return pools.get(addr);
  let info = null;
  try {
    const call = (functionName) => retry(() => client.readContract({ address: addr, abi: ABI, functionName }));
    const [t0, t1, res] = await Promise.all([call('token0'), call('token1'), call('getReserves')]);
    const wethIs0 = t0.toLowerCase() === WETH;
    if (wethIs0 || t1.toLowerCase() === WETH) {
      const wethReserve = Number((wethIs0 ? res[0] : res[1]) / E18);
      if (wethReserve >= MIN_POOL_WETH) info = { wethIs0 };
    }
  } catch { /* not a V2-style pool */ }
  pools.set(addr, info);
  return info;
}

async function isEOA(addr) {
  if (eoaCache.has(addr)) return eoaCache.get(addr);
  const code = await retry(() => client.getCode({ address: addr }));
  const ok = !code || code === '0x' || code.startsWith('0xef0100'); // plain or EIP-7702 delegated EOA
  eoaCache.set(addr, ok);
  return ok;
}

// ---- swap -> PnL (same engine for backfill and live)
const stats = { swaps: 0, wethPoolSwaps: 0, buys: 0, sells: 0, sellsNoBasis: 0 };

function applySwap(log, wallet, ts) {
  const pool = pools.get(log.address);
  if (!pool) return;
  const { amount0In: a0In, amount1In: a1In, amount0Out: a0Out, amount1Out: a1Out } = log.args;
  const [wethIn, wethOut, tokIn, tokOut] = pool.wethIs0 ? [a0In, a0Out, a1In, a1Out] : [a1In, a1Out, a0In, a0Out];
  const isBuy = wethIn > 0n && tokOut > 0n && wethOut === 0n;
  const isSell = tokIn > 0n && wethOut > 0n && wethIn === 0n;
  if (!isBuy && !isSell) return;
  const ethAmt = Number(isBuy ? wethIn : wethOut) / 1e18;
  if (ethAmt < MIN_TRADE_ETH) return;

  const w = wallets.get(wallet) ?? { pos: {}, ev: [] };
  const pos = w.pos[log.address]; // position tracked per pool: good enough for MVP
  if (isBuy) {
    if (pos) { pos.amt += tokOut; pos.cost += ethAmt; } else w.pos[log.address] = { amt: tokOut, cost: ethAmt };
    w.ev.push([ts, 0, 0]); stats.buys++;
  } else {
    if (!pos || pos.amt < tokIn) { stats.sellsNoBasis++; return; } // no known cost basis -> skip, never invent profit
    const costPart = pos.cost * (Number(tokIn) / Number(pos.amt));
    pos.amt -= tokIn; pos.cost -= costPart;
    if (pos.amt === 0n) delete w.pos[log.address];
    w.ev.push([ts, +(ethAmt - costPart).toFixed(6), 1]); stats.sells++;
  }
  wallets.set(wallet, w);
  schedulePublish();
}

// ---- leaderboard (rolling window: only events newer than the cutoff count)
let top = [], topSig = '', pubTimer = null, computing = false, statusText = '';

async function computeTop() {
  const cutoff = Date.now() / 1000 - WINDOW_DAYS * 86400;
  const rows = [];
  for (const [address, w] of wallets) {
    let pnl = 0, trades = 0, sells = 0;
    for (const e of w.ev) if (e[0] >= cutoff) { trades++; if (e[2]) { sells++; pnl += e[1]; } }
    if (trades >= MIN_TRADES && sells >= 1 && pnl > 0) rows.push({ address, pnl, trades });
  }
  rows.sort((a, b) => b.pnl - a.pnl);
  const out = [];
  for (const r of rows) { // contract check only for wallets that reach the top region
    if (await isEOA(r.address)) out.push({ rank: out.length + 1, address: r.address, pnlEth: +r.pnl.toFixed(4), trades: r.trades });
    if (out.length >= TOP_N) break;
  }
  return out;
}

function broadcast(obj) {
  const m = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(m);
}
function setStatus(text) { statusText = text; broadcast({ type: 'status', text }); }

function schedulePublish() {
  if (pubTimer) return;
  pubTimer = setTimeout(async () => {
    pubTimer = null;
    if (computing) return schedulePublish();
    computing = true;
    try {
      const next = await computeTop();
      const sig = next.map((r) => r.address + r.pnlEth).join('|');
      if (sig !== topSig) { topSig = sig; top = next; broadcast({ type: 'leaderboard', data: top, ts: Date.now() }); }
    } catch (e) { console.error('publish error:', e.message); }
    computing = false;
  }, PUBLISH_MS);
}

// ---- backfill: getLogs in block chunks + one getBlock(full txs) per block to get tx.from and timestamp
let backfillEnd = 0;

async function processRange(from, to) {
  let size = 200, cur = from;
  while (cur <= to) {
    const end = Math.min(cur + size - 1, to);
    let logs;
    try { logs = await retry(() => client.getLogs({ event: SWAP, fromBlock: BigInt(cur), toBlock: BigInt(end) })); }
    catch (e) { if (size > 1) { size = Math.max(1, size >> 1); continue; } throw e; } // too many results -> smaller chunk
    logs = logs.filter((l) => !l.removed);
    stats.swaps += logs.length;
    await pmap([...new Set(logs.map((l) => l.address))], poolInfo, 10);
    const good = logs.filter((l) => pools.get(l.address));
    stats.wethPoolSwaps += good.length;
    const blocks = new Map();
    await pmap([...new Set(good.map((l) => l.blockNumber))], async (bn) => {
      const b = await retry(() => client.getBlock({ blockNumber: bn, includeTransactions: true }));
      blocks.set(bn, { ts: Number(b.timestamp), from: new Map(b.transactions.map((t) => [t.hash, t.from.toLowerCase()])) });
    }, 8);
    for (const l of good) {
      const b = blocks.get(l.blockNumber), w = b?.from.get(l.transactionHash);
      if (w) applySwap(l, w, b.ts);
    }
    meta.lastBlock = end; cur = end + 1;
    if (logs.length < 4000 && size < 1000) size *= 2;
    setStatus(`Backfilling history: ${Math.round(((end - from + 1) / (to - from + 1)) * 100)}% (block ${end} of ${to})`);
  }
}

async function startup() {
  const head = Number(await client.getBlockNumber());
  if (!BACKFILL) { backfillEnd = head; meta.lastBlock = head; setStatus('Live (no backfill)'); return; }
  const windowStart = head - Math.floor(WINDOW_DAYS * BLOCKS_PER_DAY);
  let from = Math.max(windowStart, meta.lastBlock + 1);
  console.log(`Backfilling blocks ${from} -> ${head} (${head - from + 1} blocks)`);
  while (true) { // loop until caught up with the chain head
    const h = Number(await client.getBlockNumber());
    if (from > h) break;
    await processRange(from, h);
    from = h + 1;
  }
  backfillEnd = from - 1;
  saveState();
  console.log('Backfill done');
  setStatus('Live');
  schedulePublish();
}
const ready = startup().catch((e) => { console.error('backfill failed:', e.shortMessage || e.message); setStatus('Backfill failed: ' + (e.shortMessage || e.message)); });

// ---- live ingestion (queued behind backfill; sequential so buys are processed before later sells)
let lastTx = { hash: null, from: null };
async function handleLive(log) {
  if (log.removed || Number(log.blockNumber) <= backfillEnd) return; // already covered by backfill
  stats.swaps++;
  if (!(await poolInfo(log.address))) return;
  stats.wethPoolSwaps++;
  if (lastTx.hash !== log.transactionHash) {
    const tx = await retry(() => client.getTransaction({ hash: log.transactionHash }));
    lastTx = { hash: log.transactionHash, from: tx.from.toLowerCase() };
  }
  applySwap(log, lastTx.from, Math.floor(Date.now() / 1000));
  meta.lastBlock = Math.max(meta.lastBlock, Number(log.blockNumber));
}

let chain = ready;
client.watchEvent({
  event: SWAP,
  onLogs: (logs) => {
    chain = chain.then(async () => {
      for (const l of logs) { try { await handleLive(l); } catch (e) { console.error('log error:', e.shortMessage || e.message); } }
    });
  },
  onError: (e) => console.error('watch error:', e.shortMessage || e.message),
});

// ---- http + ws
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/leaderboard', (_, res) => res.json(top));
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (c) => {
  c.send(JSON.stringify({ type: 'leaderboard', data: top, ts: Date.now() }));
  if (statusText) c.send(JSON.stringify({ type: 'status', text: statusText }));
});

setInterval(() => { if (backfillEnd) saveState(); }, 60_000);
setInterval(() => { // drop events that left the window
  const cutoff = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400;
  for (const [a, w] of wallets) {
    w.ev = w.ev.filter((e) => e[0] >= cutoff);
    if (!w.ev.length && !Object.keys(w.pos).length) wallets.delete(a);
  }
}, 600_000);
setInterval(() => console.log(`[stats] ${JSON.stringify(stats)} wallets=${wallets.size} board=${top.length} | ${statusText}`), 15_000);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { if (backfillEnd) saveState(); process.exit(0); });
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
