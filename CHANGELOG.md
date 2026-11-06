# 变更记录

## 1.0.1 — 2026-11-06（安全补丁，务必升级）

**修复：删除后重启 DSH 会让会话打不开。**

- 症状：`SessionFormatError: system/message does not match an open turn and step`，
  会话无法加载（原本还能正常聊天，只是重启后才炸）。
- 原因：v4 日志要求 `system/message` 必须写在**打开的** turn+step 内；删除命令在轮次之外执行，
  旧版用 `system/message` 当替换节点，写入时没被拦，**重启重新读盘时被校验器拒绝**。
- 修法：替换节点改用 `user/message`（v4 对它不要求 turn/step），并把被遮蔽节点列表
  强制规整成扁平、升序的数字数组；顺带给替换节点一句占位正文，避免空 content 被模型接口拒绝。
- 已写坏的会话可用 `tools/fix-bad-replace.mjs` 修复；`tools/doctor.mjs` 可全库体检。

**同时修复：`sourceEventSeqs` 曾被写成嵌套数组**（`[[8,12],20]`），
同样会导致重启后加载失败（`must densely contain non-negative safe integers`）。
写入端已加固，历史会话用 `tools/repair-refs.mjs` 修复。

## 1.0.0 — 2026-11-05

- 首个版本：`/turn-delete` 命令 + 选择弹窗 + 变浅/删除线展示。
- 附带离线手术工具 `session-surgery.mjs`（物理重建，默认 dry-run）。
