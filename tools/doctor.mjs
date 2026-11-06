#!/usr/bin/env node
/**
 * doctor.mjs —— 全库体检：找出加载不了的会话，并修复本插件可能写坏的那一类
 *
 *   node tools/doctor.mjs                 # 只体检（默认，安全）
 *   node tools/doctor.mjs --fix           # 备份后修复本插件写坏的替换节点
 *   node tools/doctor.mjs --root <目录>    # 指定 sessions 根目录
 *
 * 判定用的是 DSH 自己的 v4 关系校验器（assertReleasedV4Relationships），
 * 和宿主启动时读盘用的是同一套规则——它能过，会话就能打开。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DSH = 'E:/Local/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const rootArg = args.indexOf('--root');
const root = rootArg >= 0 ? args[rootArg + 1] : path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'sessions');

const v4 = await import(pathToFileURL(path.join(DSH, 'dsh-session-format-v3-to-v4/lib/index.js')).href);
const KNOWN = v4.RELEASED_V3_EVENT_TYPES;

function readLog(file) {
  const buf = fs.readFileSync(file);
  let text = '';
  for (let at = buf.indexOf(ZSTD_MAGIC); at !== -1; at = buf.indexOf(ZSTD_MAGIC, at + 4)) {
    try {
      const chunk = zlib.zstdDecompressSync(buf.subarray(at)).toString('utf8');
      if (chunk.startsWith('{')) text += chunk;
    } catch { /* 假阳性帧起点 */ }
  }
  const lines = text.split('\n').filter(Boolean);
  return { header: JSON.parse(lines[0]), events: lines.slice(1).map((l) => JSON.parse(l)) };
}

function check(header, events) {
  v4.assertReleasedV4Relationships({ header, events, inheritedEventCount: 0 }, KNOWN);
}

/** 把"轮次之外写的 system/message 替换节点"改成 user/message；空内容补占位 */
function repairShape(events) {
  const open = { turn: null, step: null };
  const changed = [];
  for (const e of events) {
    if (e.type === 'turn/start') open.turn = e.data.turn;
    else if (e.type === 'turn/end') { open.turn = null; open.step = null; }
    else if (e.type === 'step/start') open.step = e.data.step;
    else if (e.type === 'step/end') open.step = null;

    if (e.type === 'system/message' && e.surfaceOp && e.surfaceOp !== 'append') {
      const inStep = open.turn !== null && open.step !== null && e.data.turn === open.turn && e.data.step === open.step;
      if (!inStep) {
        e.type = 'user/message';
        e.data = {
          id: (e.data.message && e.data.message.id) || 'turn-delete-' + e.seq,
          role: 'user',
          content: [{ type: 'text', text: '（已移除一轮对话）' }],
          source: { kind: 'user' },
        };
        changed.push(e.seq);
        continue;
      }
    }
    if (e.type === 'user/message' && e.surfaceOp && e.surfaceOp !== 'append'
      && (!Array.isArray(e.data.content) || e.data.content.length === 0)) {
      e.data.content = [{ type: 'text', text: '（已移除一轮对话）' }];
      changed.push(e.seq);
    }
  }
  return changed;
}

function writeLog(file, header, events) {
  const text = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n';
  const packed = zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
  const backupDir = path.resolve('backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, path.basename(path.dirname(file)) + '-doctor-' + Date.now() + '.zstd');
  fs.copyFileSync(file, backup);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, packed);
  fs.renameSync(tmp, file);
  return backup;
}

if (!fs.existsSync(root)) { console.error('找不到 sessions 目录：' + root); process.exit(2); }

let total = 0;
const broken = [];
const fixedRows = [];

for (const project of fs.readdirSync(root)) {
  const projectDir = path.join(root, project);
  if (!fs.statSync(projectDir).isDirectory()) continue;
  for (const session of fs.readdirSync(projectDir)) {
    const sessionDir = path.join(projectDir, session);
    if (!fs.statSync(sessionDir).isDirectory()) continue;
    const file = fs.readdirSync(sessionDir).find((n) => /^session(\.v\d+)?\.jsonl\.zstd$/.test(n));
    if (!file) continue;
    total += 1;
    const full = path.join(sessionDir, file);
    let parsed;
    try { parsed = readLog(full); } catch (error) { broken.push({ session, why: '读不出来: ' + error.message }); continue; }
    if (!parsed.header || parsed.header.version !== 4) continue;   // 老代际由宿主迁移，跳过
    let why = '';
    try { check(parsed.header, parsed.events); continue; }
    catch (error) { why = String(error && error.message ? error.message : error); }

    const changed = repairShape(parsed.events);
    if (changed.length === 0) { broken.push({ session, why }); continue; }
    try { check(parsed.header, parsed.events); } catch (error) {
      broken.push({ session, why: why + '（修了 ' + changed.length + ' 条仍不过：' + String(error && error.message ? error.message : error) + '）' });
      continue;
    }
    if (fix) {
      const backup = writeLog(full, parsed.header, parsed.events);
      fixedRows.push({ session, seqs: changed, backup });
    } else {
      fixedRows.push({ session, seqs: changed, backup: '(dry-run)' });
    }
  }
}

console.log('体检范围：' + root);
console.log('会话总数：' + total);
console.log('可修复：' + fixedRows.length + (fix ? '（已修）' : '（未修，加 --fix 落盘）'));
for (const row of fixedRows) console.log('  ✓ ' + row.session.slice(0, 30) + ' 修 seq ' + row.seqs.join(',') + '  →  ' + row.backup);
console.log('仍不可用：' + broken.length);
for (const row of broken) console.log('  ✗ ' + row.session.slice(0, 30) + '  ' + row.why.slice(0, 120));
