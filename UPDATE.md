# 更新指南（把这段话发给 AI）

插件会持续修 bug（例如 1.0.1 修的就是"删除后重启会话打不开"）。
已经装过的用户按下面任意一种方式更新即可。

---

## 先确认自己装的是哪一版

打开任意会话 → 右上角「选择对话」→ 弹窗标题右边有版本号（例如 `v1.0.2`）。
对照 [CHANGELOG.md](CHANGELOG.md) 看是不是最新。

---

## 方式一：把这段话发给 AI（推荐）

```text
请帮我更新 DSH 插件 dsh-turn-delete。按这个流程做，不要跳步：

1. 找到本机这个插件的源码目录：dsh-turn-delete-plugin
   （如果你是通过 git clone 装的，仓库目录里就有 package.json、index.js、client.js）。

2. 在该仓库目录执行：
   git pull --ff-only
   如果本地有改动导致拉不下来，先 git stash，拉完再告诉我 stash 里有东西。
   如果这个目录不是 git 仓库（比如当时是下载 ZIP 解压的），
   直接重新下载 https://github.com/1772538871/dsh-proto 覆盖该目录。

3. 看 dsh-turn-delete-plugin/package.json 里的 version，告诉我从哪一版更新到了哪一版。

4. 重载插件（宿主端代码改了必须重载，光刷新页面不够）：
   plugin_manager(action="set_plugin", target="include:dsh-turn-delete", enabled=false)
   plugin_manager(action="set_plugin", target="include:dsh-turn-delete", enabled=true)
   两次返回里 application 都应该是 "applied"；
   如果第一次因为别的插件报错没成，把诊断原文贴给我。

5. 告诉我：现在需要我按什么键刷新页面，以及打开「选择对话」后版本号应该是多少。
```

---

## 方式二：手动更新

在仓库目录（用资源管理器打开该目录，地址栏输入 `powershell` 回车）：

```
git pull --ff-only
```

然后在 DSH 里重载插件（**宿主端改了必须重载**）：

```text
plugin_manager(action="set_plugin", target="include:dsh-turn-delete", enabled=false)
plugin_manager(action="set_plugin", target="include:dsh-turn-delete", enabled=true)
```

最后 **Ctrl+F5** 刷新页面。

---

## 只改了界面/样式的版本怎么办

| 改了什么 | 生效方式 |
|---|---|
| `client.js`（弹窗、变浅、删除线） | 保存后 **Ctrl+F5** 刷新页面即可 |
| `index.js`（命令、写入逻辑） | 必须**停用再启用**插件行（或重启 DSH） |
| `package.json` 版本号 | 只影响显示与识别，刷新即可 |

拿不准就统一按"停用再启用 + Ctrl+F5"走，最稳。

---

## 怎么第一时间知道有更新

- 在 GitHub 仓库页点 **Watch → Custom → Releases**，有新版本会发邮件；
- 或直接看 [CHANGELOG.md](CHANGELOG.md) / [Releases](https://github.com/1772538871/dsh-proto/releases)。

## 为什么没有"自动更新"

插件是按**本地目录**安装的（`install_bundle` 指向磁盘上的目录），DSH 不会替你去拉代码，
所以更新动作必须由你在本机执行一次 `git pull` + 重载。这样也避免了插件在后台偷偷改自己。

> 将来如果发布到 npm，更新可以简化成"重新 `install_bundle` 一个更新的版本号"，
> 但那需要把包名从 `@local/...` 换成正式 scope 并配置 npm 发布凭据。
