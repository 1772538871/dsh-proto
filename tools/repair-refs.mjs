#!/usr/bin/env node
/**
 * repair-refs.mjs —— 修 v4 会话里被写坏的 sourceEventSeqs（不改 seq，不删事件）
 *
 *   node repair-refs.mjs <sessionDir> [--apply]
 *
 * 只处理 surface 替换节点：它的 sourceEventSeqs 必须是被遮蔽节点 seq 的扁平数组。
 * 发现嵌套数组 / 缺项 / 多项时，按实际遮蔽集合重写。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

function read(dir) {
  const name = fs.readdirSync(dir).find((n) => /^session(\.v\d+)?\.jsonl\.zstd$/.test(n));
  if (!name) throw new Error('没有 .zstd 日志');
  const file = path.join(dir, name);
  const buf = fs.readFileSync(file);
  let text = '';
  for (let at = buf.indexOf(M); at !== -1; at = buf.indexOf(M, at + 4)) {
    try {
      const chunk = zlib.zstdDecompressSync(buf.subarray(at)).toString('utf8');
      if (chunk.startsWith('{')) text += chunk;
    } catch { /* 假阳性 */ }
  }
  const lines = text.split('\n').filter(Boolean);
  return { file, header: JSON.parse(lines[0]), events: lines.slice(1).map((l) => JSON.parse(l)) };
}

function repair(events) {
  const nodes = [];
  const fixes = [];
  for (const e of events) {
    if (!SURFACE.has(e.type)) continue;
    if (!e.surfaceOp || e.surfaceOp === 'append') { nodes.push(e.seq); continue; }
    const a = nodes.indexOf(e.surfaceOp.startSeq);
    const b = nodes.indexOf(e.surfaceOp.endSeq);
    if (a < 0 || b < 0) throw new Error(`seq ${e.seq}: replace 区间不在 surface 上`);
    const shadowed = nodes.slice(a, b + 1).slice().sort((x, y) => x - y);
    const current = Array.isArray(e.sourceEventSeqs) ? e.sourceEventSeqs : [];
    const okShape = current.length === shadowed.length && current.every((v) => Number.isSafeInteger(v)) && shadowed.every((s) => current.includes(s));
    if (!okShape) {
      fixes.push({ seq: e.seq, from: JSON.stringify(current), to: JSON.stringify(shadowed) });
      e.sourceEventSeqs = shadowed;
    }
    nodes.splice(a, shadowed.length, e.seq);
  }
  return fixes;
}

const dir = process.argv[2];
const apply = process.argv.includes('--apply');
if (!dir) { console.error('用法: node repair-refs.mjs <sessionDir> [--apply]'); process.exit(2); }

const { file, header, events } = read(dir);
const fixes = repair(events);
console.log('[检查]', path.basename(dir), '｜事件', events.length, '｜需修', fixes.length);
for (const f of fixes) console.log('  seq ' + f.seq + ': ' + f.from + ' → ' + f.to);
if (!fixes.length) { console.log('无需修复'); process.exit(0); }
if (!apply) { console.log('dry-run：未写盘（加 --apply）'); process.exit(0); }

const text = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n';
const packed = zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
const bk = 'E:/dsh-proto/backups/' + path.basename(dir) + '-repair-' + Date.now() + '.zstd';
fs.mkdirSync('E:/dsh-proto/backups', { recursive: true });
fs.copyFileSync(file, bk);
const tmp = file + '.tmp';
fs.writeFileSync(tmp, packed);
fs.renameSync(tmp, file);
console.log('[备份]', bk);
console.log('[落盘]', file, packed.length, 'bytes');
