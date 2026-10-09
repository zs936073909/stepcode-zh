# stepcode-zh · StepCode 界面中文汉化

把 StepCode（`step`，Bun 单文件可执行程序）终端界面里的**选项、菜单、提示、说明、帮助与错误信息**换成中文。
不改任何程序逻辑、协议字段、配置项和工具行为。

## 为什么需要这个

StepCode **没有任何 i18n / locale 机制**：文档里没有语言设置项，`settings.md` 全部设置里也没有语言选项，
二进制里也搜不到语言包。所以只能直接改程序里的文字。

`step` 是 `bun build --compile` 打出来的单文件可执行程序，应用代码是一段**未压缩的 JS bundle**，
内嵌在二进制的 `$bunfs` 虚拟文件系统里：

```
\x00/$bunfs/root/step\x00<bundle 字节>
```

于是可以：抽出 bundle → 替换英文显示文字 → 原样写回二进制。

## 关键点：字节数必须一分不差

替换后 bundle 会变短，变短的部分用在文件末尾追加一段 `//` 注释补足，使总长度和原版完全一致。
这样每个模块的偏移和长度都没变，Bun 运行时的模块表和 trailer 全部仍然有效，**不需要重新打包**。

## 用法

```bash
# 1. 构建（默认读取 ~/.stepcode/bin/step）
./build.sh

# 2. 构建并直接安装（会先备份原始二进制为 step.orig）
INSTALL=1 ./build.sh

# 3. 指定二进制路径
./build.sh /path/to/step
```

构建产物在 `build/`：`step_bundle.js`（抽出）、`step_bundle.zh2.js`（汉化后）、`step.zh`（成品二进制）。

> ⚠️ **改完必须退出并重启 `step`**。正在运行的会话仍持有旧二进制的 inode，不会热更新。

## 目录

```
i18n/zh_1.json … zh_5.json   字符串字面量翻译表（菜单选项、提示、通知、快捷键说明、错误信息）
i18n/zh_help.json            模板字符串/帮助文本翻译表（--help、页脚提示、设置菜单、通知消息）
scripts/extract.js           二进制 -> bundle
scripts/patch.js             应用 i18n/zh_*.json（等长补齐）
scripts/patch_help.js        应用 i18n/zh_help.json（等长补齐）
scripts/audit.js             安全审计：找出会被程序匹配的字符串
scripts/splice.js            bundle -> 二进制
build.sh                    一键构建
```

## 改文案

编辑 `i18n/*.json`（键 = 英文原文，值 = 中文），然后重跑 `./build.sh`。

**注意**：`patch.js` 会替换**所有**出现的该字符串。如果某个英文串同时被程序拿来做判断
（`===` / `.includes()` / 环境变量取值 / 对象键名），必须删掉该条，或改成更精确的键——
例如用 `label: "Bypass"` 而不是 `"Bypass"`，否则 PowerShell 的 `-ExecutionPolicy Bypass` 会被一起改掉。
`scripts/audit.js` 就是用来查这个的，改动后建议跑一遍。

已确认必须保留英文的例子：`on` `off` `status` `help`（命令参数/对象键）、
`gitdir: `（解析 .git 文件）、`[paste #`（粘贴标记匹配）、`fetch failed`（匹配 Node 错误信息）、
`Bypass`（PowerShell 执行策略参数）。

## 已覆盖

- `--help` 全量选项、子命令帮助、环境变量、示例、内置工具名
- `/` 命令菜单及各命令描述、`/settings` 全部设置项标签与说明、`/permissions`、`/model`、`/theme`
- 项目信任提示、方案（plan）审阅、澄清问答、反馈提交
- 键位说明、输入框占位符、页脚状态行、欢迎 Tips
- CLI / RPC / SDK / 压缩 / 导出 / 更新等错误与警告信息

**刻意保留英文**（会影响模型行为或程序逻辑）：发给模型的工具 schema（`name` / `description` /
`promptSnippet` / 参数说明）、系统提示词、设置项键名与枚举值、命令名、提供方与模型 ID。

## 还原

```bash
cp ~/.stepcode/bin/step.orig ~/.stepcode/bin/step
```

`step update --self` 会用官方版本覆盖汉化，重跑 `./build.sh` 即可恢复（翻译表都在仓库里）。

## 已知限制

- 二进制有 110MB，超过 GitHub 单文件 100MB 上限，所以仓库里**只有翻译表和脚本**，
  成品二进制在本地构建产生。
- 发送给模型的工具描述、系统提示词等仍是英文（见上）。
- 极少数内置依赖（babel / yaml / zod / semver 等）内部的报错文字未翻译。
