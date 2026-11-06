# 安装指南（让 AI 帮你装）

这个仓库的核心是一个 DSH 插件包：`dsh-turn-delete-plugin/`。
下面两种装法，**第一种最省事**——把一段话发给你的 AI，它自己会装。

---

## 方式一：把这段话发给 AI（推荐）

先让 AI 确认仓库在本机（没克隆就让它克隆），然后把下面整段复制给**任意能操作 DSH 的 AI**
（DSH 自带的 Agent 最好用，因为它能直接调用 `plugin_manager`）：

```text
请帮我安装一个 DSH 插件，按这个流程做，不要跳步：

1. 找到本机这个仓库里的插件目录：dsh-turn-delete-plugin
   （里面应该有 package.json、index.js、client.js、cordis.patch.yml）。
   如果本机还没有这个仓库，先执行：
   git clone https://github.com/1772538871/dsh-proto
   克隆到你认为合适的位置（不要放在 C:\Users\...\AppData 这类系统目录）。

2. 拿到那个目录的【绝对路径】后，调用：
   plugin_manager(action="install_bundle", target="<上面那个绝对路径>")

3. 读返回值：
   - application == "applied" 且 enabled == true  → 成功，继续第 4 步；
   - 否则把 error / warnings / nextStep 的原文贴给我，不要自己猜着改。

4. 成功后，检查插件行是否存在且启用：
   plugin_manager(action="list_plugins")，
   找到 entryId 为 include:dsh-turn-delete 的那一行，确认 enabled: true。

5. 最后告诉我三件事：
   - 插件装到了哪个 profile；
   - 我需要按什么键刷新页面（一般是 Ctrl+F5）；
   - 装完之后在会话右上角应该看到什么按钮。

不要修改插件目录里的任何文件；不要自己编造路径，先把绝对路径找出来再装。
```

### AI 装完之后你该看到什么

1. **按 Ctrl+F5 刷新页面**（客户端插件在页面启动时加载，不刷新看不到）；
2. 打开任意会话，**右上角（文件夹图标左边）出现「选择对话」按钮**；
3. 点它 → 弹出「选择要删除的轮次」→ 勾选 → 「删除 N 轮」；
4. 被删的那一轮在聊天里变浅 + 加删除线，轮尾出现「已从上下文移除」；
5. 打开「上下文」标签页，被删那轮的用户消息 / 助手消息应该是 **0 项**。

五条里前三条是"装好了"，后两条是"工作正常"。

---

## 方式二：手动安装（没有 AI 可用时）

1. 克隆仓库到本机任意位置：

   ```bash
   git clone https://github.com/1772538871/dsh-proto
   ```

   也可以直接下载 ZIP 解压。插件目录就是里面的 `dsh-turn-delete-plugin/`。

2. 在 DSH 里让 Agent 执行（或在插件管理界面里手动添加）：

   ```text
   plugin_manager(action="install_bundle", target="<插件目录的绝对路径>")
   ```

   `target` 指向的是**目录**，不是 zip、不是压缩包，里面必须能直接看到 `package.json`。

3. 刷新页面（Ctrl+F5）。

---

## 安装失败怎么办

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `unknown-plugin` / 找不到包 | `target` 不是插件目录的绝对路径 | 让 AI 先 `dir <路径>` 确认里面有 `package.json`，再重试 |
| 返回里 `application: "failed"` | 宿主拒绝了这次安装 | 把完整的 `error` + `nextStep` 原文贴出来 |
| 提示需要审批 / 权限 | 当前会话不是 danger-full-access | 批准那次安装，或换一个能批准的环境重试 |
| `application: "restart-required"` | 宿主模块需要重载 | 重启 DSH（关掉再开） |
| 装好了但页面没有按钮 | 没刷新，或插件行没启用 | **Ctrl+F5**；再 `list_plugins` 确认 `include:dsh-turn-delete` 是 `enabled: true` |
| 有按钮，点了删除没反应 | 命令没执行或执行失败 | 弹窗底部会显示红字原因，把红字贴出来 |
| 删完了一刷新又回来了 | 刷新没生效 / 看的是别的会话 | 确认 URL 里的会话没换；再刷新一次 |

---

## 卸载

```text
plugin_manager(action="remove_bundle", target="@local/dsh-turn-delete")
```

或在插件管理界面里停用并移除 `dsh-turn-delete`。

> 卸载**不会**把已删除的轮次恢复——删除动作已经写进会话日志（原文一直都在，
> 只是被遮蔽了）。需要恢复请参考仓库里的 `tools/` 与
> [删除对话-方案分析.md](删除对话-方案分析.md)。

---

## 改了插件代码之后

| 改了什么 | 怎么生效 |
|---|---|
| `client.js`（界面、样式） | 保存后 **Ctrl+F5** 刷新页面 |
| `index.js`（宿主端命令逻辑） | 在插件管理里把 `include:dsh-turn-delete` **停用再启用**（宿主模块不会热更新） |

---

## 环境要求

- 已安装并可运行 DSH（Web GUI 能打开，默认 `http://127.0.0.1:3080`）；
- 宿主支持 `plugin_manager` 的 `install_bundle`（本插件就是按这个机制打包的）；
- 不需要 Node.js、不需要编译、不需要装任何依赖——`index.js` / `client.js` 是纯 ESM 与纯 JS。

---

装完后想了解它到底改了什么、为什么聊天记录不消失，看
[README.md](README.md) 和 [删除对话-方案分析.md](删除对话-方案分析.md)。
