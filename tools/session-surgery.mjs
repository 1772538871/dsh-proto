#!/usr/bin/env node
/**
 * session-surgery.mjs —— DSH 会话"物理整理"（方案 B 的实现）
 *
 *   node session-surgery.mjs <sessionDir> <turns> [--apply]
 *     <turns>  要删掉的轮次，如 "2"、"2,5,6"、"4-6"
 *     --apply  真正落盘（默认只读：规划 + 校验）
 *
 * 步骤：读日志 → 按轮区间剔除 → 重编号 seq → 重映射所有 seq 引用 →
 *       六项校验（含用 DSH 自己的 Session 引擎派生一遍）→ 备份 → 原子替换。
 *
 * 安全：不 --apply 绝不写盘；--apply 一定先留 .jsonl.zstd 备份。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

/** 读会话目录：返回 { file, header, events }，events 不含文件头行。 */
function readSession(dir) {
  const names = fs.readdirSync(dir).filter((n) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(n));
  if (!names.length) throw new Error('目录里没有会话日志：' + dir);
  const ranked = names.map((name) => {
    const gen = /\.v(\d+)\./.exec(name);
    return { name, gen: gen ? Number(gen[1]) : 1, zstd: name.endsWith('.zstd') };
  }).sort((a, b) => (b.gen - a.gen) || (Number(b.zstd) - Number(a.zstd)));
  const picked = ranked[0];
  const file = path.join(dir, picked.name);
  const buf = fs.readFileSync(file);
  let text = '';
  if (picked.zstd) {
    const frames = [];
    for (let at = buf.indexOf(ZSTD_MAGIC); at !== -1; at = buf.indexOf(ZSTD_MAGIC, at + 4)) frames.push(at);
    for (const offset of frames) {
      try {
        const chunk = zlib.zstdDecompressSync(buf.subarray(offset)).toString('utf8');
        if (chunk.startsWith('{')) text += chunk;
      } catch { /* 假阳性帧起点 */ }
    }
  } else text = buf.toString('utf8');
  const lines = text.split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  if (header.type !== 'session') throw new Error('首行不是 session 头');
  const events = lines.slice(1).map((line) => JSON.parse(line));
  events.forEach((e, i) => { if (e.seq !== i) throw new Error(`读入时 seq 不连续：第 ${i} 条是 ${e.seq}`); });
  return { file, header, events };
}

function parseTurns(raw) {
  const out = [];
  for (const part of String(raw || '').split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error('看不懂的轮次：' + part);
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    for (let t = Math.min(a, b); t <= Math.max(a, b); t += 1) if (!out.includes(t)) out.push(t);
  }
  return out.sort((x, y) => x - y);
}

function turnRanges(events) {
  const starts = new Map();
  const ends = new Map();
  for (const e of events) {
    if (e.type === 'turn/start') starts.set(e.data.turn, e.seq);
    else if (e.type === 'turn/end') ends.set(e.data.turn, e.seq);
  }
  const ranges = new Map();
  for (const [turn, start] of starts) ranges.set(turn, { start, end: ends.has(turn) ? ends.get(turn) : Infinity });
  return ranges;
}

/** 修好 replace 节点被写坏的 sourceEventSeqs：以实际遮蔽集合为准 */
function repairReplaceRefs(events) {
  const nodes = [];
  let repaired = 0;
  for (const e of events) {
    if (!SURFACE_TYPES.has(e.type)) continue;
    if (e.surfaceOp === undefined || e.surfaceOp === 'append') { nodes.push(e.seq); continue; }
    const a = nodes.indexOf(e.surfaceOp.startSeq);
    const b = nodes.indexOf(e.surfaceOp.endSeq);
    if (a < 0 || b < 0) throw new Error(`seq ${e.seq}: replace 区间不在 surface 上`);
    const shadowed = nodes.slice(a, b + 1).slice().sort((x, y) => x - y);
    const current = Array.isArray(e.sourceEventSeqs) ? e.sourceEventSeqs.filter((v) => Number.isSafeInteger(v)) : [];
    const covered = shadowed.every((s) => current.includes(s)) && current.length === shadowed.length;
    if (!covered) { e.sourceEventSeqs = shadowed; repaired += 1; }
    nodes.splice(a, shadowed.length, e.seq);
  }
  return repaired;
}

/** 最小 surface 折叠；非法就抛。 */
function foldSurface(events) {
  const nodes = [];
  for (const e of events) {
    if (!SURFACE_TYPES.has(e.type)) continue;
    if (e.surfaceOp === undefined || e.surfaceOp === 'append') { nodes.push(e.seq); continue; }
    const a = nodes.indexOf(e.surfaceOp.startSeq);
    const b = nodes.indexOf(e.surfaceOp.endSeq);
    if (a < 0 || b < 0) throw new Error(`seq ${e.seq}: replace 区间 ${e.surfaceOp.startSeq}..${e.surfaceOp.endSeq} 不在 surface 上`);
    if (a > b) throw new Error(`seq ${e.seq}: replace 区间颠倒`);
    const shadowed = nodes.slice(a, b + 1);
    const sources = new Set(e.sourceEventSeqs || []);
    const missing = shadowed.filter((s) => !sources.has(s));
    if (missing.length) throw new Error(`seq ${e.seq}: sourceEventSeqs 缺 ${missing.join(',')}`);
    nodes.splice(a, shadowed.length, e.seq);
  }
  return nodes;
}

function validate(events) {
  const rows = [];
  const ok = (name, extra = '') => rows.push({ name, pass: true, extra });
  const bad = (name, extra) => rows.push({ name, pass: false, extra });

  let contiguous = true;
  events.forEach((e, i) => { if (e.seq !== i) contiguous = false; });
  contiguous ? ok('seq 连续 0..' + (events.length - 1)) : bad('seq 连续', '出现断号');

  try { ok('surface 折叠', foldSurface(events).length + ' 个可见节点'); }
  catch (error) { bad('surface 折叠', error.message); }

  const calls = new Set();
  let pair = true;
  let pairWhy = '';
  for (const e of events) {
    if (e.type === 'tool/call') calls.add(e.data.callId);
    else if (e.type === 'tool/result' && !calls.has(e.data.callId)) { pair = false; pairWhy = 'seq ' + e.seq + ' 无对应调用'; break; }
  }
  pair ? ok('tool call / result 配对') : bad('tool call / result 配对', pairWhy);

  const openTurns = new Set();
  const openSteps = new Set();
  let struct = true;
  let structWhy = '';
  for (const e of events) {
    if (e.type === 'turn/start') openTurns.add(e.data.turn);
    else if (e.type === 'turn/end') { if (!openTurns.delete(e.data.turn)) { struct = false; structWhy = 'seq ' + e.seq; break; } }
    else if (e.type === 'step/start') openSteps.add(e.data.turn + ':' + e.data.step);
    else if (e.type === 'step/end') { if (!openSteps.delete(e.data.turn + ':' + e.data.step)) { struct = false; structWhy = 'seq ' + e.seq; break; } }
  }
  if (struct && openTurns.size) { struct = false; structWhy = openTurns.size + ' 个 turn 未闭合'; }
  struct ? ok('turn / step 配对') : bad('turn / step 配对', structWhy);

  let refs = true;
  let refWhy = '';
  for (const e of events) {
    for (const s of e.sourceEventSeqs || []) if (s >= e.seq || s < 0) { refs = false; refWhy = 'seq ' + e.seq + ' 引用 ' + s; break; }
    if (!refs) break;
  }
  refs ? ok('seq 引用均指向更早事件') : bad('seq 引用', refWhy);

  const surface = events.filter((e) => SURFACE_TYPES.has(e.type)).length;
  ok('可见消息事件', surface + ' 条');
  return rows;
}

async function engineCheck(header, events) {
  try {
    const modPath = 'E:/Local/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js';
    const { Session } = await import('file:///' + modPath);
    const session = Session.create(header.id, events, header, 0);
    const messages = session.deriveMessages();
    return { ok: true, count: messages.length, roles: messages.map((m) => m.role).join(',') };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** 剔除 + 重编号 + 重映射 */
function rebuild(events, kill) {
  const kept = events.filter((e) => !kill.has(e.seq));
  const keptSeqs = new Set(kept.map((e) => e.seq));

  // 第一遍：确定存活（headerSeq 指向被删事件时，这条 developer/message 只能丢）
  const alive = [];
  for (const e of kept) {
    const target = e.data && Number.isSafeInteger(e.data.headerSeq) ? e.data.headerSeq : undefined;
    if (target !== undefined && !keptSeqs.has(target)) continue;
    alive.push(e);
  }

  const map = new Map();
  alive.forEach((e, index) => map.set(e.seq, index));
  const seqOf = (old) => (map.has(old) ? map.get(old) : undefined);

  const out = [];
  for (const e of alive) {
    const next = { ...e, seq: map.get(e.seq) };
    if (Array.isArray(e.sourceEventSeqs)) {
      const refs = e.sourceEventSeqs.map(seqOf).filter((v) => v !== undefined).sort((a, b) => a - b);
      if (refs.length) next.sourceEventSeqs = refs; else delete next.sourceEventSeqs;
    }
    if (e.surfaceOp && typeof e.surfaceOp === 'object') {
      const start = seqOf(e.surfaceOp.startSeq);
      const end = seqOf(e.surfaceOp.endSeq);
      if (start === undefined || end === undefined) {
        next.surfaceOp = 'append';           // 被遮蔽区间已被物理删除 → 退化为普通追加
        delete next.sourceEventSeqs;
      } else {
        next.surfaceOp = { op: 'replace', startSeq: start, endSeq: end };
      }
    }
    if (e.data && typeof e.data === 'object') {
      const data = { ...e.data };
      if (Number.isSafeInteger(data.headerSeq)) data.headerSeq = seqOf(data.headerSeq);
      if (Number.isSafeInteger(data.sourceEventSeq)) {
        const mapped = seqOf(data.sourceEventSeq);
        if (mapped === undefined) delete data.sourceEventSeq; else data.sourceEventSeq = mapped;
      }
      if (Array.isArray(data.shadowedSeqs)) {
        const refs = data.shadowedSeqs.map(seqOf).filter((v) => v !== undefined).sort((a, b) => a - b);
        if (refs.length) data.shadowedSeqs = refs; else delete data.shadowedSeqs;
      }
      next.data = data;
    }
    out.push(next);
  }
  out.forEach((e, index) => { e.seq = index; });
  return { events: out, dropped: kept.length - alive.length };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((a) => !a.startsWith('--'));
  const dir = positional[0];
  const turns = parseTurns(positional[1] || '');
  if (!dir || !turns.length) { console.error('用法: node session-surgery.mjs <sessionDir> <turns> [--apply]'); process.exit(2); }

  const { file, header, events } = readSession(dir);
  console.log('[读]', file);
  console.log('     事件', events.length, '｜可见事件', events.filter((e) => SURFACE_TYPES.has(e.type)).length, '｜轮', turnRanges(events).size);

  const ranges = turnRanges(events);
  const kill = new Set();
  for (const turn of turns) {
    const range = ranges.get(turn);
    if (!range) { console.log('[跳过] 第', turn, '轮不存在'); continue; }
    if (!Number.isFinite(range.end)) { console.log('[跳过] 第', turn, '轮未结束'); continue; }
    for (let s = range.start; s <= range.end; s += 1) kill.add(s);
    console.log('[删] 第 ' + turn + ' 轮 → seq ' + range.start + '..' + range.end + '（' + (range.end - range.start + 1) + ' 条）');
  }
  if (!kill.size) { console.log('没有可删的内容'); return; }

  const { events: rebuilt, dropped } = rebuild(events, kill);
  const repaired = repairReplaceRefs(rebuilt);
  console.log('[重建]', events.length, '→', rebuilt.length, '条事件' + (dropped ? '（另丢 ' + dropped + ' 条挂空引用的 developer/message）' : '') + (repaired ? '（修复 ' + repaired + ' 处 sourceEventSeqs）' : ''));

  console.log('[校验]');
  let pass = true;
  for (const row of validate(rebuilt)) {
    console.log('  ' + (row.pass ? '✅' : '❌') + ' ' + row.name + (row.extra ? ' — ' + row.extra : ''));
    if (!row.pass) pass = false;
  }
  const engine = await engineCheck(header, rebuilt);
  console.log('  ' + (engine.ok ? '✅' : '❌') + ' DSH 引擎派生 — ' + (engine.ok ? engine.count + ' 条消息（' + engine.roles + '）' : engine.error));
  if (!engine.ok) pass = false;

  if (!pass) { console.log('\n校验不通过，未写盘。'); process.exit(1); }
  console.log('\n全部通过。');

  if (!apply) { console.log('dry-run：未写盘（加 --apply 落盘）'); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = 'E:/dsh-proto/backups';
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, path.basename(dir) + '-' + stamp + '.jsonl.zstd');
  fs.copyFileSync(file, backup);
  console.log('[备份]', backup);

  const text = [JSON.stringify(header), ...rebuilt.map((e) => JSON.stringify(e))].join('\n') + '\n';
  const packed = zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, packed);
  fs.renameSync(tmp, file);
  console.log('[落盘]', file, '→', packed.length, 'bytes');
}

main().catch((error) => { console.error('失败：', error && error.message ? error.message : error); process.exit(1); });
