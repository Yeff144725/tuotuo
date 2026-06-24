'use strict';
/*
 * aggregator.js — the data engine behind the Token Trackpad.
 *
 * Claude Code logs every turn to ~/.claude/projects/<encoded-cwd>/<session>.jsonl
 * as newline-delimited JSON. Each assistant message carries a `message.usage`
 * object: { input_tokens, output_tokens, cache_creation_input_tokens,
 * cache_read_input_tokens, cache_creation:{ephemeral_5m,ephemeral_1h} }.
 *
 * Two non-obvious facts this engine handles:
 *   1) DEDUP. The same assistant message is copied into multiple files (session
 *      resume, sidechains, compaction). On this machine 59k raw usage lines
 *      collapse to ~15k unique — counting raw inflates output ~4x. We dedup on
 *      message.id (the API's per-generation id), so every generation counts once.
 *   2) INCREMENTAL TAIL. The full tree is ~1GB; re-parsing it every tick would
 *      jank. We cache each file's byte offset and only parse appended bytes,
 *      so live updates are O(new bytes), not O(corpus).
 *
 * Time is bucketed per-minute so rolling windows (today / 7d / 30d) and the
 * sparklines are cheap to recompute on every snapshot.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const MINUTE = 60_000;
const DAY_MIN = 1440;            // minutes per day
const RETAIN_DAYS = 31;

// Per-million-token list price (input, output). Cache is derived from input:
// write-5m = in*1.25, write-1h = in*2, read = in*0.1. Source: claude-api skill.
// Edit these if your plan/rates differ — cost is an estimate, tokens are exact.
// Rates last verified 2026-06 against Anthropic's public list prices. This app is
// 100% offline by design, so prices can't self-update — re-check this table when
// Anthropic changes pricing or ships a model whose family rate differs below.
const PRICES = {
  'claude-fable-5':    { in: 10, out: 50 },
  'claude-opus-4-8':   { in: 5,  out: 25 },
  'claude-opus-4-7':   { in: 5,  out: 25 },
  'claude-opus-4-6':   { in: 5,  out: 25 },
  'claude-opus-4-5':   { in: 5,  out: 25 },
  'claude-sonnet-4-6': { in: 3,  out: 15 },
  'claude-sonnet-4-5': { in: 3,  out: 15 },
  'claude-haiku-4-5':  { in: 1,  out: 5  },
};
// Resolve a model id to { in, out, estimated }. `estimated:false` is an exact,
// trustworthy rate; `estimated:true` means we fell back to the model family's
// current-generation rate because the exact id wasn't in PRICES (a model newer
// or older than this table). Returns null only for a truly unrecognizable id
// (e.g. a non-Claude model) — its tokens then count toward totals but $0 toward
// cost. Stays 100% offline: no network price lookup, ever.
function priceFor(model) {
  if (!model) return null;
  for (const key in PRICES) if (model.startsWith(key)) return { ...PRICES[key], estimated: false };
  // Family fallback — keeps the cost realistic for any Claude model, so an
  // open-source user on a version we didn't hardcode never silently sees $0.
  if (model.includes('opus'))   return { ...PRICES['claude-opus-4-8'],   estimated: true };
  if (model.includes('sonnet')) return { ...PRICES['claude-sonnet-4-6'], estimated: true };
  if (model.includes('haiku'))  return { ...PRICES['claude-haiku-4-5'],  estimated: true };
  if (model.includes('fable') || model.includes('mythos')) return { ...PRICES['claude-fable-5'], estimated: true };
  return null;
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

class TokenAggregator {
  constructor(root = ROOT) {
    this.root = root;
    this.files = new Map();   // path -> { size, offset (bytes) }
    this.seen = new Set();    // dedup keys: message.id (fallback uuid)
    this.buckets = new Map(); // minuteEpoch -> { in, out, cw, cr, cost }
    this.lastEventTs = 0;     // newest message timestamp seen (for "live" pulse)
    this.models = new Map();  // model -> token count (for the model mix)
  }

  _bucket(min) {
    let b = this.buckets.get(min);
    if (!b) { b = { in: 0, out: 0, cw: 0, cr: 0, cost: 0 }; this.buckets.set(min, b); }
    return b;
  }

  _ingestLine(line) {
    if (!line) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const u = o && o.message && o.message.usage;
    if (!u || !o.timestamp) return;
    const id = (o.message && o.message.id) || o.uuid;
    if (!id || this.seen.has(id)) return;     // dedup: count each generation once
    this.seen.add(id);
    const ts = Date.parse(o.timestamp);
    if (!ts) return;

    const inp = u.input_tokens || 0;
    const out = u.output_tokens || 0;
    const cw  = u.cache_creation_input_tokens || 0;
    const cr  = u.cache_read_input_tokens || 0;

    const b = this._bucket(Math.floor(ts / MINUTE));
    b.in += inp; b.out += out; b.cw += cw; b.cr += cr;

    let turnCost = 0;
    const p = priceFor(o.message.model);
    if (p) {
      const inR = p.in / 1e6, outR = p.out / 1e6;
      const cc = u.cache_creation || {};
      const w5 = cc.ephemeral_5m_input_tokens || 0;
      const w1 = cc.ephemeral_1h_input_tokens || 0;
      const wRest = Math.max(0, cw - w5 - w1);  // any unsplit creation → treat as 1h
      turnCost = inp * inR
               + out * outR
               + w5 * inR * 1.25
               + (w1 + wRest) * inR * 2
               + cr * inR * 0.1;
      b.cost += turnCost;
      if (p.estimated) b.est = true;          // cost here used a family-fallback rate → approximate
    } else if (o.message.model) {
      b.unp = true;                           // model has no known price → its tokens are excluded from cost
    }
    if (ts > this.lastEventTs) this.lastEventTs = ts;

    const mTok = inp + out + cw + cr;
    if (o.message.model) {
      this.models.set(o.message.model, (this.models.get(o.message.model) || 0) + mTok);
      // per-model split within this minute → powers the period-accurate breakdown
      const bm = b.m || (b.m = {});
      const e = bm[o.message.model] || (bm[o.message.model] = { tok: 0, cost: 0 });
      e.tok += mTok; e.cost += turnCost;
    }
  }

  // Parse `content`, ingesting every COMPLETE line; return the byte offset up to
  // (and including) the last newline so a trailing partial line is re-read later.
  _ingestText(content) {
    const lastNl = content.lastIndexOf('\n');
    if (lastNl === -1) return 0;
    const complete = content.slice(0, lastNl);
    const lines = complete.split('\n');
    for (let i = 0; i < lines.length; i++) this._ingestLine(lines[i]);
    return Buffer.byteLength(content.slice(0, lastNl + 1), 'utf8');
  }

  async _scanFile(f, full) {
    let stat;
    try { stat = fs.statSync(f); } catch { return; }
    const prev = this.files.get(f);

    if (full || !prev || stat.size < (prev ? prev.size : 0)) {
      // first sight, or truncated/rotated → read whole (seen-set blocks dupes)
      let content;
      try { content = await fs.promises.readFile(f, 'utf8'); } catch { return; }
      const offset = this._ingestText(content);
      this.files.set(f, { size: stat.size, offset });
      return;
    }
    if (stat.size === prev.size) return;        // unchanged
    if (stat.size === prev.offset) {            // grew but no complete new line yet
      this.files.set(f, { size: stat.size, offset: prev.offset });
      return;
    }

    // grew → read only the appended bytes
    let fd;
    try { fd = await fs.promises.open(f, 'r'); } catch { return; }
    try {
      const len = stat.size - prev.offset;
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, prev.offset);
      const consumed = this._ingestText(buf.toString('utf8'));
      this.files.set(f, { size: stat.size, offset: prev.offset + consumed });
    } catch {
      /* leave offset; retry next tick */
    } finally {
      await fd.close();
    }
  }

  _prune() {
    const cutoff = Math.floor((Date.now() - RETAIN_DAYS * 86_400_000) / MINUTE);
    for (const k of this.buckets.keys()) if (k < cutoff) this.buckets.delete(k);
  }

  // One-time full scan, yielding to the event loop so the UI stays responsive.
  async fullScan(onProgress) {
    const files = walk(this.root);
    for (let i = 0; i < files.length; i++) {
      await this._scanFile(files[i], true);
      if (onProgress && (i % 8 === 0 || i === files.length - 1)) onProgress(i + 1, files.length);
      if (i % 8 === 0) await new Promise((r) => setImmediate(r));
    }
    this._prune();
  }

  // Cheap tick: re-stat the tree, parse only deltas.
  async incrementalScan() {
    const files = walk(this.root);
    for (let i = 0; i < files.length; i++) await this._scanFile(files[i], false);
    this._prune();
  }

  snapshot() {
    const now = Date.now();
    const nowMin = Math.floor(now / MINUTE);
    const todayMin = Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / MINUTE);

    const blank = () => ({ in: 0, out: 0, cw: 0, cr: 0, cost: 0, est: false, unp: false });
    const today = blank(), d7 = blank(), d30 = blank();
    const m7 = nowMin - 7 * DAY_MIN, m30 = nowMin - 30 * DAY_MIN;

    // 30-day daily series — "all" (in+out+cache) and "fresh" (in+out only),
    // so the chart can follow the INPUT fresh↔(fresh+cache) toggle.
    const dayTotals = new Array(30).fill(0);
    const dayFresh = new Array(30).fill(0);
    const nowDay = Math.floor(nowMin / DAY_MIN);

    // per-model cost/tokens, accumulated per window for the expandable breakdown
    const bmToday = {}, bmD7 = {}, bmD30 = {};
    const addModel = (acc, name, e) => { const r = acc[name] || (acc[name] = { tok: 0, cost: 0 }); r.tok += e.tok; r.cost += e.cost; };

    for (const [k, b] of this.buckets) {
      const tot = b.in + b.out + b.cw + b.cr;
      if (k >= m30) { d30.in += b.in; d30.out += b.out; d30.cw += b.cw; d30.cr += b.cr; d30.cost += b.cost; d30.est = d30.est || !!b.est; d30.unp = d30.unp || !!b.unp; }
      if (k >= m7)  { d7.in  += b.in; d7.out  += b.out; d7.cw  += b.cw; d7.cr  += b.cr; d7.cost  += b.cost; d7.est  = d7.est  || !!b.est; d7.unp  = d7.unp  || !!b.unp; }
      if (k >= todayMin) { today.in += b.in; today.out += b.out; today.cw += b.cw; today.cr += b.cr; today.cost += b.cost; today.est = today.est || !!b.est; today.unp = today.unp || !!b.unp; }
      const dayIdx = 29 - (nowDay - Math.floor(k / DAY_MIN));
      if (dayIdx >= 0 && dayIdx < 30) { dayTotals[dayIdx] += tot; dayFresh[dayIdx] += b.in + b.out; }
      if (b.m) for (const name in b.m) {
        const e = b.m[name];
        if (k >= m30) addModel(bmD30, name, e);
        if (k >= m7)  addModel(bmD7,  name, e);
        if (k >= todayMin) addModel(bmToday, name, e);
      }
    }

    // last 60 minutes, total tokens/min — the live "trackpad" trace
    const spark = new Array(60), sparkFresh = new Array(60);
    for (let i = 0; i < 60; i++) {
      const b = this.buckets.get(nowMin - (59 - i));
      spark[i] = b ? (b.in + b.out + b.cw + b.cr) : 0;
      sparkFresh[i] = b ? (b.in + b.out) : 0;
    }

    // burn rate = (in+out) over the last 5 minutes, per minute
    let last5 = 0;
    for (let i = 0; i < 5; i++) { const b = this.buckets.get(nowMin - i); if (b) last5 += b.in + b.out; }

    const mix = [...this.models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([model, tok]) => ({ model, tok }));

    // Which seen models are priced approximately (family fallback) or not at all —
    // names the per-window est/unp flags so the UI can explain the asterisk.
    const estModels = [], unpModels = [];
    for (const model of this.models.keys()) {
      const p = priceFor(model);
      if (!p) unpModels.push(model);
      else if (p.estimated) estModels.push(model);
    }

    // per-period rows for the expandable cost breakdown, richest-first
    const mkRows = (acc) => Object.entries(acc).map(([model, r]) => {
      const pr = priceFor(model);
      return { model, tok: r.tok, cost: r.cost, estimated: !!(pr && pr.estimated), unpriced: !pr };
    }).sort((a, b) => b.cost - a.cost || b.tok - a.tok);
    const breakdown = { today: mkRows(bmToday), d7: mkRows(bmD7), d30: mkRows(bmD30) };

    return {
      now, today, d7, d30, spark, sparkFresh, daily: dayTotals, dailyFresh: dayFresh,
      burnPerMin: last5 / 5,
      lastEventTs: this.lastEventTs,
      uniqueEvents: this.seen.size,
      mix, estModels, unpModels, breakdown,
    };
  }
}

module.exports = TokenAggregator;

// ── Standalone CLI: `node aggregator.js --test` — verify real numbers, no UI ──
if (require.main === module) {
  (async () => {
    const t0 = Date.now();
    const agg = new TokenAggregator();
    process.stdout.write('Scanning ~/.claude/projects ');
    await agg.fullScan((d, t) => { if (d === t) process.stdout.write(`${t} files\n`); });
    const s = agg.snapshot();
    const n = (x) => Math.round(x).toLocaleString();
    const card = (label, w) => {
      const total = w.in + w.out + w.cw + w.cr;
      console.log(`\n${label}  —  ${n(total)} tokens total   (≈ $${w.cost.toFixed(2)})`);
      console.log(`   fresh in: ${n(w.in)}   output: ${n(w.out)}   cache write: ${n(w.cw)}   cache read: ${n(w.cr)}`);
      console.log(`   IN (prompt-side): ${n(w.in + w.cw + w.cr)}   OUT (generated): ${n(w.out)}`);
    };
    console.log(`\n══ TOKEN TRACKPAD — dedup'd report ══`);
    console.log(`unique generations counted: ${n(s.uniqueEvents)}   scan: ${Date.now() - t0}ms`);
    card('TODAY', s.today);
    card('LAST 7 DAYS', s.d7);
    card('LAST 30 DAYS', s.d30);
    console.log(`\nburn (last 5m): ${n(s.burnPerMin)} tok/min`);
    console.log('model mix (30d):', s.mix.map((m) => `${m.model.replace('claude-', '')} ${n(m.tok)}`).join('  ·  '));
    if (s.estModels.length) console.log(`⚠ estimated rate (family fallback): ${s.estModels.join(', ')}`);
    if (s.unpModels.length) console.log(`⚠ no price, excluded from cost: ${s.unpModels.join(', ')}`);
  })();
}
