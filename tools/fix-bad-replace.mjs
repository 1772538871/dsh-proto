#!/usr/bin/env node
/**
 * fix-bad-replace.mjs —— 修"关闭轮次后追加的 system/message 替换节点"
 *
 *   背景：v4 校验要求 system/message 必须落在【打开的】turn+step 内
 *   （`system/message does not match an open turn and step`）。
 *   命令是在轮次之外执行的，所以那种写法会让会话重启后直接读不出来。
 *
 *   修法：把这条替换节点改成 user/message（user/message 不要求 turn/step），
 *   surfaceOp / sourceEventSeqs / seq 全部保持不变，删除语义不变。
 *
 *   node fix-bad-replace.mjs <sessionDir> [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

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

const dir = process.argv[2];
const apply = process.argv.includes('--apply');
if (!dir) { console.error('用法: node fix-bad-replace.mjs <sessionDir> [--apply]'); process.exit(2); }

const { file, header, events } = read(dir);

// 重放 turn/step 状态，找出"在轮次之外写的 system/message 替换节点"
const open = { turn: null, step: null };
const bad = [];
for (const e of events) {
  if (e.type === 'turn/start') open.turn = e.data.turn;
  else if (e.type === 'turn/end') { open.turn = null; open.step = null; }
  else if (e.type === 'step/start') open.step = e.data.step;
  else if (e.type === 'step/end') open.step = null;
  if (e.type === 'system/message' && e.surfaceOp && e.surfaceOp !== 'append') {
    const inStep = open.turn !== null && open.step !== null && e.data.turn === open.turn && e.data.step === open.step;
    if (!inStep) bad.push(e);
  }
}

console.log('[检查]', path.basename(dir), '｜事件', events.length, '｜需转换', bad.length);
for (const e of bad) {
  console.log('  seq ' + e.seq + ' system/message(turn=' + e.data.turn + ',step=' + e.data.step + ') → user/message');
}

// 早前修过、但内容是空数组的替换节点，补上占位文字
let filled = 0;
for (const e of events) {
  if (e.type !== 'user/message') continue;
  if (!e.surfaceOp || e.surfaceOp === 'append') continue;
  if (!Array.isArray(e.data.content) || e.data.content.length === 0) {
    e.data.content = [{ type: 'text', text: '（已移除一轮对话）' }];
    filled += 1;
  }
}
if (filled) console.log('  另补占位文字', filled, '处');

if (!bad.length && !filled) { console.log('无需修复'); process.exit(0); }
if (!apply) { console.log('dry-run：未写盘（加 --apply）'); process.exit(0); }

for (const e of bad) {
  const old = e.data;
  e.type = 'user/message';
  e.data = {
    id: old.message && old.message.id ? old.message.id : 'turn-delete-' + e.seq,
    role: 'user',
    content: [{ type: 'text', text: '（已移除一轮对话）' }],
    source: { kind: 'user' },
  };
}

const text = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n';
const packed = zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
fs.mkdirSync('E:/dsh-proto/backups', { recursive: true });
const bk = 'E:/dsh-proto/backups/' + path.basename(dir) + '-fixreplace-' + Date.now() + '.zstd';
fs.copyFileSync(file, bk);
const tmp = file + '.tmp';
fs.writeFileSync(tmp, packed);
fs.renameSync(tmp, file);
console.log('[备份]', bk);
console.log('[落盘]', file, packed.length, 'bytes');
