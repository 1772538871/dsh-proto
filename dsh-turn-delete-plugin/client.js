/**
 * Client half of the turn-delete bundle.
 *
 * Adds "选择对话" to the session header. Clicking it opens a picker that lists
 * every loaded turn with its prompt preview, so a turn can be picked without
 * scrolling to the end of a long answer. The delete action runs the Host
 * command `/turn-delete`, which appends a surface replacement: the model stops
 * seeing those turns while the session log keeps every original event.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-turn-delete',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'turnDelete';
    const COMMAND = 'turn-delete';

    const ZH = {
      'action.select': '选择对话',
      'action.selected': '已选 {count} 轮',
      'action.cancel': '取消',
      'action.delete': '删除 {count} 轮',
      'action.deleting': '删除中…',
      'select.turn': '第 {turn} 轮',
      'mark.deleted': '已从上下文移除',
      'dialog.title': '选择要删除的轮次',
      'dialog.hint': '删除后模型不再看到这几轮；聊天记录与磁盘日志原文都保留。',
      'dialog.empty': '这个会话还没有可选的轮次。',
      'dialog.noPrompt': '（本页未加载提问内容）',
      'dialog.ask': '你问：',
      'dialog.answer': '它答：',
      'dialog.loading': '正在加载更早的轮次…',
      'dialog.loadOlderBtn': '加载更早的轮次',
      'dialog.noSession': '拿不到这个会话的句柄，无法继续翻页',
      'dialog.noLoadOlder': '这个会话不支持继续翻页',
      'dialog.loadFailed': '加载失败：',
      'dialog.loaded': '已加载到第 ',
      'dialog.loadedEnd': ' 轮',
      'dialog.running': '生成中',
      'toast.done': '已删除',
      'error.call': '调用失败',
      'error.rejected': '这条命令没有被接受',
      'error.failed': '删除失败：',
      'error.notRegistered': '宿主端没有注册 /turn-delete 命令（插件可能没启用）',
      'dialog.noCommand': '警告：宿主端命令表里没有 turn-delete，删除会失败。已注册的命令有：',
    };
    const EN = {
      'action.select': 'Select turns',
      'action.selected': '{count} selected',
      'action.cancel': 'Cancel',
      'action.delete': 'Delete {count}',
      'action.deleting': 'Deleting…',
      'select.turn': 'Turn {turn}',
      'mark.deleted': 'Removed from context',
      'dialog.title': 'Select turns to delete',
      'dialog.hint': 'The model stops seeing these turns; the transcript and the log keep every word.',
      'dialog.empty': 'This session has no selectable turns yet.',
      'dialog.noPrompt': '(prompt not loaded on this page)',
      'dialog.ask': 'You: ',
      'dialog.answer': 'It: ',
      'dialog.loading': 'Loading earlier turns…',
      'dialog.loadOlderBtn': 'Load earlier turns',
      'dialog.noSession': 'No live session handle; cannot page back',
      'dialog.noLoadOlder': 'This session cannot page back',
      'dialog.loadFailed': 'Load failed: ',
      'dialog.loaded': 'Loaded back to turn ',
      'dialog.loadedEnd': '',
      'dialog.running': 'running',
      'toast.done': 'Deleted',
      'error.call': 'Call failed',
      'error.rejected': 'The command was not accepted',
      'error.failed': 'Delete failed: ',
      'error.notRegistered': 'The Host has no /turn-delete command registered (plugin inactive?)',
      'dialog.noCommand': 'Warning: the Host command table has no turn-delete; deleting will fail. Registered: ',
    };

    const states = new Map();
    const listeners = new Set();

    function stateOf(sessionId) {
      let state = states.get(sessionId);
      if (state === undefined) {
        state = { selecting: false, selected: new Set() };
        states.set(sessionId, state);
      }
      return state;
    }

    function update(sessionId, patch) {
      Object.assign(stateOf(sessionId), patch);
      for (const listener of Array.from(listeners)) listener();
    }

    function useSelection(sessionId) {
      const [, bump] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        listeners.add(bump);
        return () => { listeners.delete(bump); };
      }, []);
      return stateOf(sessionId);
    }

    const ghost = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      boxSizing: 'border-box',
      height: 26,
      padding: '0 10px',
      borderRadius: 'var(--dsw-radius-sm)',
      border: '0.5px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      cursor: 'pointer',
    };

    const overlay = {
      position: 'fixed',
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      zIndex: 2147483000,
      background: 'rgba(0, 0, 0, 0.45)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    };

    const panel = {
      boxSizing: 'border-box',
      width: 'min(640px, 100%)',
      maxHeight: '76vh',
      display: 'flex',
      flexDirection: 'column',
      padding: 18,
      borderRadius: 'var(--dsw-radius-panel, 12px)',
      border: '0.5px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-overlay)',
      color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 24px 64px rgba(0, 0, 0, 0.45)',
    };

    const row = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      padding: '8px 10px',
      borderRadius: 'var(--dsw-radius-sm)',
      cursor: 'pointer',
    };

    /** Clamp one preview to a fixed number of lines without breaking the layout. */
    function clamp(lines) {
      return {
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: String(lines),
        overflow: 'hidden',
        fontSize: 12.5,
        lineHeight: '19px',
        wordBreak: 'break-word',
      };
    }

    /** Render a turn start time as a short local stamp. */
    function formatWhen(ms) {
      try {
        const date = new Date(ms);
        if (Number.isNaN(date.getTime())) return '';
        const pad = (value) => String(value).padStart(2, '0');
        return (date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
      } catch (error) {
        return '';
      }
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'turn-delete: dictionaries');

      // 被软删除的轮次在聊天里仍然存在，这里把它做成"看得出来的删除"：
      // 整轮变浅 + 正文加删除线。锚点是每轮尾部我们自己渲染的标记，
      // 用 :has() 从标记反查到这一轮的容器，不碰宿主任何 class。
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = '@local/dsh-turn-delete';
        tag.textContent = [
          ':is([data-chat-group-key],[data-chat-anchor-key]):has([data-td-deleted="1"]){opacity:.45;filter:saturate(.45)}',
          '[data-td-dim="1"]{opacity:.45;filter:saturate(.45)}',
          '[data-td-dim="1"] :is(p,li,h1,h2,h3,h4,td,th,pre,code,blockquote){text-decoration:line-through;text-decoration-thickness:1px}',
          ':is([data-chat-group-key],[data-chat-anchor-key]):has([data-td-deleted="1"]) :is(p,li,h1,h2,h3,h4,td,th,pre,code,blockquote,strong,em){text-decoration:line-through;text-decoration-thickness:1px}',
          '*:has(> [data-td-deleted="1"]){opacity:.6}',
        ].join('\n');
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'turn-delete: styles');

      const t = ctx.locale.bind(NS);

      function HeaderAction(props) {
        const sessionId = props.sessionId;
        const state = useSelection(sessionId);
        const [busy, setBusy] = React.useState(false);
        const [note, setNote] = React.useState(null);
        const [errorMsg, setErrorMsg] = React.useState('');

        const useChat = props.useChat;
        const loaded = useChat ? useChat((snapshot) => {
          try {
            return snapshot.navigation.items();
          } catch (error) {
            return [];
          }
        }) : null;
        const turnTimings = useChat ? useChat((snapshot) => snapshot.legacy.turnTimings) : null;

        // `turnOutline` is the Host projection of EVERY started turn of the
        // Session, so the picker never depends on which window the Chat has
        // paged in. The loaded rail only fills gaps in the projection.
        const outline = props.useProjection ? props.useProjection('turnOutline') : null;
        const items = React.useMemo(() => {
          const loadedByTurn = new Map();
          for (const item of loaded || []) loadedByTurn.set(item.turn, item);
          if (!Array.isArray(outline) || outline.length === 0) return loaded || [];
          const merged = [];
          for (const entry of outline) {
            if (!entry || typeof entry.turn !== 'number') continue;
            const hit = loadedByTurn.get(entry.turn);
            merged.push({
              turn: entry.turn,
              prompt: typeof entry.prompt === 'string' && entry.prompt !== '' ? entry.prompt : (hit ? hit.prompt : ''),
              response: typeof entry.response === 'string' && entry.response !== '' ? entry.response : (hit ? hit.response : ''),
            });
          }
          merged.sort((left, right) => left.turn - right.turn);
          return merged;
        }, [outline, loaded]);

        React.useEffect(() => {
          if (note === null) return undefined;
          const timer = setTimeout(() => setNote(null), 7000);
          return () => clearTimeout(timer);
        }, [note]);

        const close = React.useCallback(() => update(sessionId, { selecting: false }), [sessionId]);

        React.useEffect(() => {
          if (!state.selecting) return undefined;
          const onKey = (event) => { if (event.key === 'Escape') close(); };
          window.addEventListener('keydown', onKey);
          return () => window.removeEventListener('keydown', onKey);
        }, [state.selecting, close]);

        const count = state.selected.size;
        const toggle = (turn) => {
          const next = new Set(state.selected);
          if (next.has(turn)) next.delete(turn);
          else next.add(turn);
          update(sessionId, { selected: next });
        };
        const start = () => update(sessionId, { selecting: true, selected: new Set() });

        const submit = async () => {
          const turns = Array.from(state.selected).sort((left, right) => left - right);
          if (turns.length === 0 || busy) return;
          setBusy(true);
          setErrorMsg('');
          const line = '/' + COMMAND + ' ' + turns.join(',');
          try {
            const res = await ctx.remote.commands.execute(sessionId, line, []);
            if (!res || res.ok !== true) {
              throw new Error((res && res.error && res.error.message) || t('error.call'));
            }
            const exec = res.value;
            if (!exec) throw new Error(t('error.notRegistered') + ' (' + line + ')');
            if (exec.result && exec.result.kind === 'error') throw new Error(exec.result.text);
            update(sessionId, { selecting: false, selected: new Set() });
            setNote(exec.result && exec.result.text ? exec.result.text : t('toast.done'));
          } catch (error) {
            const text = String((error && error.message) || error);
            setErrorMsg(t('error.failed') + text);
            try { console.error('[turn-delete] failed:', error); } catch (ignored) { /* no console */ }
          } finally {
            setBusy(false);
          }
        };

        React.useEffect(() => {
          if (!state.selecting) return undefined;
          let cancelled = false;
          (async () => {
            try {
              const res = await ctx.remote.commands.list(sessionId);
              if (cancelled) return;
              const list = res && res.ok === true && Array.isArray(res.value) ? res.value : [];
              const names = list.map((item) => (item && item.name) || '').filter(Boolean);
              if (!names.includes(COMMAND)) {
                setErrorMsg(t('dialog.noCommand') + ' [' + names.join(', ') + ']');
              }
            } catch (error) {
              if (!cancelled) setErrorMsg(t('dialog.noCommand') + ' ' + String((error && error.message) || error));
            }
          })();
          return () => { cancelled = true; };
        }, [state.selecting, sessionId]);

        const rows = (items || []).map((item) => {
          const checked = state.selected.has(item.turn);
          const timing = turnTimings && typeof turnTimings.get === 'function' ? turnTimings.get(item.turn) : undefined;
          const when = timing && timing.startTime ? formatWhen(timing.startTime) : '';
          return h('label', {
            key: 'turn-' + item.turn,
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '8px 10px',
              borderRadius: 'var(--dsw-radius-sm)',
              cursor: 'pointer',
              background: checked ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            },
          },
            h('input', {
              type: 'checkbox',
              checked,
              onChange: () => toggle(item.turn),
              'data-td': 'row-' + item.turn,
              style: { width: 14, height: 14, margin: '4px 0 0', flex: '0 0 14px', cursor: 'pointer', accentColor: 'var(--dsw-alias-button-primary-fill)' },
            }),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 } },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-caption)' } },
                h('span', { style: { fontWeight: 600, fontSize: 12.5, color: 'var(--dsw-alias-label-primary)' } }, t('select.turn', { turn: item.turn })),
                when === '' ? null : h('span', null, when)),
              item.prompt === ''
                ? h('div', { style: { ...clamp(2), color: 'var(--dsw-alias-label-caption)' } }, t('dialog.noPrompt'))
                : h('div', { style: clamp(3) }, t('dialog.ask') + item.prompt),
              item.response === ''
                ? null
                : h('div', { style: { ...clamp(2), color: 'var(--dsw-alias-label-caption)' } }, t('dialog.answer') + item.response),
            ));
        });

        const dialog = state.selecting ? h('div', { style: overlay },
          h('div', { style: panel, role: 'dialog', 'aria-modal': 'true', onClick: (event) => event.stopPropagation() },
            h('div', { style: { fontSize: 14, fontWeight: 600 } }, t('dialog.title')),
            h('div', { style: { fontSize: 12, marginTop: 4, color: 'var(--dsw-alias-label-caption)' } }, t('dialog.hint')),
            h('div', { style: { marginTop: 10, overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 2 } },
              rows.length === 0 ? h('div', { style: { padding: 12, fontSize: 13, color: 'var(--dsw-alias-label-caption)' } }, t('dialog.empty')) : rows),
            errorMsg === ''
              ? null
              : h('div', { style: { marginTop: 10, fontSize: 12, lineHeight: '18px', wordBreak: 'break-word', color: 'var(--dsw-alias-state-error-primary)' } }, errorMsg),
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 14 } },
              h('span', { style: { marginRight: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-caption)' } }, t('action.selected', { count })),
              h('button', { type: 'button', onClick: close, style: ghost, 'data-td': 'cancel' }, t('action.cancel')),
              h('button', {
                type: 'button',
                disabled: busy || count === 0,
                onClick: submit,
                'data-td': 'submit',
                style: {
                  ...ghost,
                  opacity: busy || count === 0 ? 0.5 : 1,
                  cursor: busy || count === 0 ? 'default' : 'pointer',
                  borderColor: count > 0 ? 'var(--dsw-alias-state-business-primary)' : undefined,
                  color: count > 0 ? 'var(--dsw-alias-state-business-primary)' : undefined,
                },
              }, busy ? t('action.deleting') : t('action.delete', { count }))),
          )) : null;

        const children = [];
        children.push(h('button', { key: 'start', type: 'button', onClick: start, style: ghost, 'data-td': 'entry' }, t('action.select')));
        if (note !== null) {
          children.push(h('span', {
            key: 'note',
            style: { fontSize: 12, color: 'var(--dsw-alias-label-caption)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, note));
        }
        return h(React.Fragment, null, h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, children), dialog);
      }

      function TurnTail(props) {
        const sessionId = props.sessionId;
        const state = useSelection(sessionId);
        const turn = props.turn;
        const useChat = props.useChat;
        const nodes = useChat ? useChat((snapshot) => snapshot.legacy.nodes) : null;

        // 成功的 /turn-delete 回执里就写着删了哪几轮；日志里有它，所以刷新后也在。
        const deleted = React.useMemo(() => {
          const set = new Set();
          for (const node of nodes || []) {
            if (!node || node.kind !== 'command' || node.name !== COMMAND) continue;
            const outcome = node.outcome;
            if (outcome && outcome.kind && outcome.kind !== 'success') continue;
            for (const part of String(node.args || '').split(/[,\s]+/).filter(Boolean)) {
              const m = /^(\d+)(?:-(\d+))?$/.exec(part);
              if (!m) continue;
              const a = Number(m[1]);
              const b = m[2] === undefined ? a : Number(m[2]);
              for (let x = Math.min(a, b); x <= Math.max(a, b); x += 1) set.add(x);
            }
          }
          return set;
        }, [nodes]);

        const markerRef = React.useRef(null);
        const isDeletedNow = Boolean(turn) && deleted.has(turn.turn);

        if (!turn) return null;
        const number = turn.turn;
        const isDeleted = deleted.has(number);
        if (!state.selecting && !isDeleted) return null;

        // 聊天流里每一行都带 data-chat-turn="N"（实测确认），所以按轮号写规则即可。
        const css = isDeleted
          ? '[data-chat-turn="' + number + '"]{opacity:.45;filter:saturate(.45)}\n'
            + '[data-chat-turn="' + number + '"] :is(p,li,h1,h2,h3,h4,td,th,pre,code,blockquote){text-decoration:line-through;text-decoration-thickness:1px}'
          : null;

        const checked = state.selected.has(number);
        const children = [];
        if (isDeleted) {
          children.push(h('span', { key: 'chip', style: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 999, border: '0.5px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-caption)' } }, t('mark.deleted')));
        }
        if (state.selecting) {
          children.push(h('label', { key: 'pick', style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked,
              onChange: () => {
                const next = new Set(state.selected);
                if (next.has(number)) next.delete(number);
                else next.add(number);
                update(sessionId, { selected: next });
              },
              style: { width: 14, height: 14, margin: 0, cursor: 'pointer', accentColor: 'var(--dsw-alias-button-primary-fill)' },
            }),
            h('span', null, t('select.turn', { turn: number }))));
        }
        return h(React.Fragment, null,
          css ? h('style', { key: 'css' }, css) : null,
          h('div', {
            ref: markerRef,
            'data-td-deleted': isDeleted ? '1' : undefined,
            style: { display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 2px', fontSize: 12, color: 'var(--dsw-alias-label-caption)' },
          }, children));
      }

      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'turn-delete:entry',
        order: -5,
        locale: NS,
      }, HeaderAction));

      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        id: 'turn-delete:turn',
        order: 40,
        locale: NS,
      }, TurnTail));
    }

    return { inject: ['slots', 'locale', 'remote', 'remote.commands', 'sessions'], apply };
  },
});
