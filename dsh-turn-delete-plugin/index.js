/**
 * Host half of the turn-delete bundle.
 *
 * Registers one human command, `/turn-delete <turns>`, whose handler appends a
 * surface replacement over every model-visible event of the named turns. The
 * append-only session log keeps every original event; only the derived model
 * history loses them, which is exactly what compaction already does.
 */

export const inject = ['commands', 'sessions'];

export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: 'turn-delete',
    description: '软删除若干轮对话：模型此后看不到，日志原文保留',
    input: { hint: '<轮次，如 2 或 2,3 或 5-7>' },
    handler: (invocation) => run(invocation, ctx),
  }), 'turn-delete: command');
}

/** Parse "2", "2,3", "5-7" or any mix into a deduplicated turn list. */
function parseTurns(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (text === '') return [];
  const turns = [];
  for (const part of text.split(/[,\s]+/)) {
    if (part === '') continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (match === null) throw new Error('看不懂 "' + part + '"，请写轮次数字，例如 2 或 2,3 或 5-7');
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    for (let turn = low; turn <= high; turn += 1) if (!turns.includes(turn)) turns.push(turn);
  }
  return turns;
}

/** Execute one /turn-delete invocation against the live session log. */
function run(invocation, ctx) {
  const session = ctx.sessions.get(invocation.agent.id);
  if (session === undefined) return { kind: 'error', text: '找不到这个会话，无法删除。' };

  let turns;
  try {
    turns = parseTurns(invocation.rawInput);
  } catch (error) {
    return { kind: 'error', text: String(error && error.message ? error.message : error) };
  }
  if (turns.length === 0) {
    return { kind: 'error', text: '请告诉我要删哪几轮，例如 /turn-delete 2 或 /turn-delete 2,3' };
  }

  const events = session.snapshotEvents();
  const starts = new Map();
  const ends = new Map();
  const lastStep = new Map();
  for (const event of events) {
    if (event.type === 'turn/start') starts.set(event.data.turn, event.seq);
    else if (event.type === 'turn/end') ends.set(event.data.turn, event.seq);
    else if (event.type === 'step/start') {
      const seen = lastStep.get(event.data.turn) ?? 0;
      if (event.data.step > seen) lastStep.set(event.data.turn, event.data.step);
    }
  }

  const removed = [];
  const failed = [];
  for (const turn of [...turns].sort((left, right) => right - left)) {
    const startSeq = starts.get(turn);
    if (startSeq === undefined) { failed.push('第 ' + turn + ' 轮不存在'); continue; }
    if (!ends.has(turn)) { failed.push('第 ' + turn + ' 轮还没结束'); continue; }
    const endSeq = ends.get(turn);
    const surface = session.surface.nodes;
    let nodes = surface.filter((seq) => seq > startSeq && seq <= endSeq);
    // Surface node 0 is the rendered system prompt: the engine only lets a
    // system/message rewrite exactly that node, and a turn range must never
    // carry it away. Keep it and start the replacement right after it.
    if (nodes.length > 0 && nodes[0] === surface[0]) nodes = nodes.slice(1);
    if (nodes.length === 0) { failed.push('第 ' + turn + ' 轮已经不在模型视野里了'); continue; }
    // The log's sourceEventSeqs MUST be a flat, ascending list of integers.
    // Normalize defensively: a nested array here makes the session unloadable
    // after a restart ("must densely contain non-negative safe integers").
    const shadowed = nodes.map((seq) => Number(seq)).filter((seq) => Number.isSafeInteger(seq) && seq >= 0);
    if (shadowed.length !== nodes.length) {
      failed.push('第 ' + turn + ' 轮失败：surface 节点不是纯数字，拒绝写入');
      continue;
    }
    shadowed.sort((left, right) => left - right);
    try {
      // 关键：v4 校验要求 system/message 必须落在【打开的】turn+step 内
      // （"system/message does not match an open turn and step"），而命令是在
      // 轮次之外执行的——所以替换节点必须用 user/message（它不要求 turn/step）。
      // 内容给一小段占位文字：空内容的 user 消息发给模型可能被拒。
      const message = {
        id: 'turn-delete-' + turn + '-' + session.seq,
        role: 'user',
        content: [{ type: 'text', text: '（已移除一轮对话）' }],
        source: { kind: 'user' },
      };
      session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] },
        sourceEventSeqs: shadowed,
      });
      removed.push(turn);
    } catch (error) {
      failed.push('第 ' + turn + ' 轮失败：' + String(error && error.message ? error.message : error));
    }
  }

  if (removed.length === 0) return { kind: 'error', text: failed.join('；') || '没有删除任何内容。' };
  const done = '已移除第 ' + removed.sort((left, right) => left - right).join('、') + ' 轮（模型此后看不到，日志原文保留）';
  return { kind: 'success', text: failed.length === 0 ? done : done + '；' + failed.join('；') };
}
