# DSH 对话自动备份

为 DeepSeek Harness（DSH）提供本地增量备份、保存目录选择和右下角结果提醒。每回合结束后等待日志落盘，默认合并 10 秒内的触发；运行期间每 5 分钟检查一次。相同内容按 SHA-256 去重，发生变化时保存独立快照，源文件被删除后仍可从历史快照恢复。

当前版本为 **0.2.2**，已适配 DSH Desktop **0.2.1-rc.2**。仓库包含完整源码和测试，采用 [MIT 许可证](LICENSE)。

## 安装

自动安装脚本适用于 Windows PowerShell 5.1。需要已启动过的 DSH Desktop、Node.js 22.19 或更高版本（建议 Node.js 24），以及可用的 pnpm。安装脚本会先备份受影响的 profile 配置，再安装本地链接；插件文件夹需放在长期保留的位置。

下载仓库后进入插件文件夹，或使用 Git：

```powershell
git clone https://github.com/RookieLouis/dsh-chat-backup.git
Set-Location .\dsh-chat-backup
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\install.ps1
```

脚本默认使用当前用户的 `.dsh\profiles\desktop`，配置备份保存在 `.dsh\backups\dsh-chat-backup-install\时间戳`。可用 `-Profile` 和 `-ConfigBackupRoot` 指定其他位置，首次无人值守安装也可用 `-Destination` 指定备份目录。升级会保留已有配置。安装完成后，在方便时正常退出并重新打开 DSH 加载插件。

本地链接依赖插件文件夹的位置；移动文件夹后需要重新运行安装脚本。仓库内已包含构建产物，安装前无需安装开发依赖或重新构建。

## 首次设置与日常使用

首次启动会显示「设置 DSH 对话备份」。点击「选择文件夹」，或填写绝对路径，再点击「保存并启用备份」。默认路径为空；取消选择不会保存或开始备份。选择「稍后设置」后，可随时到 Plugins → `dsh-chat-backup` 完成设置。

插件页提供保存路径、「立即备份」和最近状态。更改路径并保存后会立即应用，新目录开始备份，旧目录中的历史备份保留。源目录与备份目录不能相互包含；已有其他 DSH 数据源备份的目录也会被拒绝。

启动时会校验最近快照是否属于当前数据源、文件摘要是否完整。当天已有有效备份时可直接确认；上次失败、备份中断、校验失败或进入新的一天时会重新尝试。

结果提醒显示在右下角，默认 3 秒后消失，不抢输入焦点。成功与没有内容变化均算成功，默认每天首次成功时提醒。插件页的「备份提醒」可选择每天首次成功、每次启动首次成功、每次成功检查或不显示成功提醒，并设置 1–60 秒显示时长；保存后立即生效。

失败提醒不受成功提醒频率限制，并提供可选重试按钮；消失后仍可在插件页查看详情。目标磁盘不可用时会保留失败状态，下次启动继续检查。禁用备份后不会自动设置或弹出结果提醒。

## 备份内容

- `sessions/**/session.vN.jsonl`、`session.vN.jsonl.zstd`：原始对话日志和工具结果，不转换格式。
- `attachments/**`：对话附件。
- `storages/workspace.json`：工作区、会话关联、置顶和归档等信息。

API 密钥配置、凭据文件、浏览器数据、插件依赖和缓存不在选取范围；文件和目录链接也会跳过。对话或附件本身仍可能含有敏感内容，请将备份目录作为私人数据保管。

## 手动备份、校验和恢复

在插件文件夹执行：

```powershell
node tools/cli.mjs backup
node tools/cli.mjs list
node tools/cli.mjs verify
```

CLI 默认源目录为当前用户的 `.dsh`，并读取应用保存的备份路径。可用 `--source` 指定其他 DSH_HOME，用 `--destination` 指定备份目录。首次尚未设置路径时，应先在应用中设置，或显式传入目标目录。

恢复时选择一个尚不存在的目录。例如，在临时目录下创建新的恢复位置：

```powershell
$restorePath = Join-Path $env:TEMP ('dsh-restore-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
node tools/cli.mjs restore --target $restorePath
```

`verify` 和 `restore` 默认使用最新快照；需要历史版本时加上 `--snapshot` 和 `list` 返回的快照 ID。恢复目录不能与源目录或备份目录相互包含。恢复前先校验对象，恢复后逐文件校验，完成时写入 `RESTORE-COMPLETE.json`。失败时保留部分输出并写入 `RESTORE-FAILED.json`，换一个新目录重试即可。

真正回迁前请关闭 DSH，并先备份当前 `.dsh`。确认恢复目录有完成标记，再将其中的 `sessions`、`attachments` 和 `storages/workspace.json` 放回对应位置，保留当前账号和其他配置。不要将恢复标记文件复制进 DSH_HOME。

## 存储和运行边界

- `objects/` 保存按内容摘要命名的不可变文件版本。
- `snapshots/` 保存每次变化的完整文件清单；无变化时不新增快照。
- `last-status.json`、`backup-runs.jsonl` 保存备份状态和运行记录。
- `.backup.lock` 防止插件与手动命令同时写入同一备份目录。
- DSH_HOME 中的 `storages/dsh-chat-backup.json` 保存提醒及最近尝试状态，不属于对话快照。

默认保留全部历史，不自动清理。大附件或频繁变化的长日志会增加空间占用。备份过程中仍在变化的文件会重试 3 次；持续变化时本次失败，不发布不完整快照。快照保证选中文件的字节校验，不能修复源数据原有损坏，也不等同于整个运行目录的事务快照。

插件仅在 DSH 运行时工作，关闭期间不会执行定时备份。目标磁盘不可用时不会自动改存其他位置。进程强制退出留下的锁，在确认原进程已结束后会自动回收；仍活跃进程的锁不会被抢占。如果锁的写入或回收也被中断，请先停止插件宿主和所有手动备份，再处理目标目录中的 `.backup.lock`、`.recover-*.lock`。`tmp/` 中的 `.partial` 不属于已发布快照。

## 开发和验证

```powershell
npm run build
npm test
```

客户端源文件是 `src/client.js`，`lib/client.js` 为已提交的构建产物。修改源后请重新构建。构建和单元测试仅使用 Node.js 内置模块，不需要安装 DSH peer 依赖。GitHub Actions 使用 Node.js 24 在 Windows 和 Linux 上构建、运行单元测试，并检查构建产物与源码一致；PowerShell 安装测试在非 Windows 平台自动跳过。

`tools/host-smoke.mjs`、`tools/remote-smoke.mjs` 与 `tools/settings-smoke.mjs` 使用已安装 DSH Desktop 的原生库验证宿主、RPC 和真实设置服务。设置检查在临时目录中验证配置保存、即时生效和备份目录切换；这些集成检查需要本地 Desktop 环境，不在普通 GitHub Actions 中运行。Windows 下可按实际安装位置执行：

```powershell
$desktopExecutable = '<DSH安装目录>\DeepSeek Harness.exe'
$env:ELECTRON_RUN_AS_NODE = '1'
& $desktopExecutable --expose-internals .\tools\host-smoke.mjs | Out-String
& $desktopExecutable --expose-internals .\tools\remote-smoke.mjs | Out-String
& $desktopExecutable --expose-internals .\tools\settings-smoke.mjs | Out-String
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

`tools/native-ui-smoke.mjs` 另需可用的 Playwright 和 Chrome，可用 `DSH_DESKTOP_EXECUTABLE` 指定 Desktop 可执行文件。该工具使用原生 React、主题和控件；文件夹选择、RPC 和配置保存使用隔离测试替身。集成工具不会重启 DSH，也不会操作正在运行的用户 profile。

## 卸载

先备份 profile 配置，再从 `dsh.profile.bundles` 和 `cordis.patch.yml` 中移除 `dsh-chat-backup`，在该 profile 文件夹运行 `pnpm remove dsh-chat-backup --ignore-scripts`，最后正常重启 DSH。卸载不会删除备份目录中的历史数据。

如遇问题，可提交 [GitHub Issue](https://github.com/RookieLouis/dsh-chat-backup/issues)，附上插件版本、DSH 版本和去除私人内容后的错误信息。
