# stepcode-zh · StepCode 界面中文汉化

把 StepCode（`step`，Bun 单文件可执行程序）终端界面里的**选项、菜单、提示、说明、帮助与错误信息**换成中文。不改任何程序逻辑、协议字段、配置项和工具行为。

## 为什么需要这个

StepCode **没有任何 i18n / locale 机制**：文档里没有语言设置项，`settings.md` 全部设置里也没有语言选项，二进制里也搜不到语言包。所以只能直接改程序里的文字。

`step` 是 `bun build --compile` 打出来的单文件可执行程序，应用代码是一段**未压缩的 JS bundle**，内嵌在二进制的 `$bunfs` 虚拟文件系统里：

```
\x00/$bunfs/root/step\x00<bundle 字节>
```

于是可以：抽出 bundle → 替换英文显示文字 → 原样写回二进制。

## 关键点：字节数必须一分不差

替换后 bundle 会变短，变短的部分用**文件末尾的空白**补足，使总长度和原版完全一致。这样每个模块的偏移和长度都没变，Bun 运行时的模块表和 trailer 全部仍然有效，**不需要重新打包**。

bundle 的结尾不是猜的：Bun 自己在文件尾部的 trailer 表里记录了模块长度，工具会拿计算值和这个记录值交叉验证，对不上就拒绝构建（`--allow-unverified-end` 可覆盖）。

## 用法

```bash
# 构建并直接安装（会先备份原始二进制为 step.orig）
INSTALL=1 ./build.sh

# 指定二进制路径
./build.sh /path/to/step
```

产物在 `build/`：`step_bundle.js`（抽出）、`step_bundle.zh2.js`（汉化后）、`step.zh`（成品二进制）、`manifest.json`（版本与哈希锚定）。

> ⚠️ **装完必须退出并重启 `step`**。正在运行的会话持有旧二进制的 inode，不会热更新。

## 这个工具怎么防止"慢慢烂掉"

`step update --self` 覆盖官方版是常态，所以构建是**fail-closed** 的，任何一项不过就停下：

| 环节 | 失败条件 |
|---|---|
| `extract.js` | 读 `step --version` 记录版本；bundle 结尾无法用 Bun 自己记录的length 交叉验证；抽出内容已含中文（判定为重复打补丁）；含 NUL 字节 |
| `patch.js` | 有翻译 key 匹配不上（上游改了文案）→ 非 `--lenient` 直接退出；值含非法转义/控制字符 |
| `patch_help.js` | 值引入了 key 里没有的 `${...}` 或标识符；`${`/反引号总数发生变化 |
| `audit.js` | 发现新的"会被程序匹配"的键且未在 allowlist 登记理由 |
| `node --check` | 补出来的 bundle 不是合法 JS |
| `verify.js` | 版本号变了、退出码和原版不一致、中文标记缺失、报错路径不通 |

`build/manifest.json` 记录目标二进制的版本、sha256、bundle 的 sha256 和偏移，重构建时一眼能看出是不是同一个二进制。

## 目录

```
i18n/zh_1.json … zh_5.json   字符串字面量翻译表（菜单选项、提示、通知、快捷键说明、错误信息）
i18n/zh_help.json            模板字符串/帮助文本翻译表（--help、页脚提示、设置菜单、/hotkeys、通知消息）
i18n/audit-allowlist.json    "两边一起替换所以安全"的键，附理由
scripts/lib.js               共享库：JS 扫描、插值/标识符提取、值校验、等长补齐
scripts/extract.js           二进制 -> bundle + manifest + 重复打补丁防护
scripts/patch.js             应用 zh_*.json（两种引号都替换）
scripts/patch_help.js        应用 zh_help.json（上下文相关校验）
scripts/audit.js             安全审计（两轮都审），新发现即失败
scripts/prune.js             清理因两轮顺序产生的死键
scripts/splice.js            bundle -> 二进制
scripts/verify.js            冒烟测试
scripts/selftest.js          合成 bundle 自检（CI 跑这个）
build.sh                     一键构建
```

## 改文案

编辑 `i18n/*.json`（键 = 英文原文，值 = 中文），然后 `./build.sh`。

**注意**：`patch.js` 会替换**所有**出现的该字符串。如果某个英文串同时被程序拿来做判断（`===` / `.includes()` / 环境变量取值 / 对象键名），必须删掉该条，或改成更精确的键——例如用 `label: "Bypass", paint: warning` 而不是 `"Bypass"`，否则 PowerShell 的 `-ExecutionPolicy Bypass` 会被一起改掉。`audit.js` 就是查这个的。

已确认必须保留英文的例子：

- `on` `off` `status` `help` —— 命令参数 / 对象键名
- `gitdir: ` —— 解析 `.git` 文件内容
- `[paste #` —— 粘贴标记匹配
- `fetch failed` —— 匹配 Node 的错误信息
- `Bypass`（PowerShell 执行策略参数）
- `Mode: <label>` 这个 status 通道 —— 页脚用 `/^Mode:\s*([^()]+?)…/` 解析它再和 `bypass` 等英文比较，所以**预设 label 必须保持英文**，只翻译页脚自己渲染的 label

## 供应链说明

`i18n/zh_help.json` 的值是**原样插入** bundle 的，所以翻译表实质上等价于可执行代码。因此每个值都要通过 `lib.validateValue`：

- 禁止反斜杠（除非是合法的 JS 转义，源码里有些键写成 `\u2191`）
- 禁止换行、制表符、控制字符
- `${...}` 的数量不得超过 key，且其中引用的标识符必须是 key 里已有的（翻译可以保留插值并翻译其内部文字，但不能伸手拿新代码）
- 不能包含会闭合所在字面量的引号或反引号

打完补丁后还会断言 bundle 里 `${` 和反引号的总数没变。`scripts/selftest.js` 对以上每条都有回归测试。

## 测试与 CI

```bash
node scripts/selftest.js     # 12 个用例，不需要真实 step 二进制
```

覆盖：两种引号都被替换（覆盖率 bug 的回归）、比较两边一致、缺 key 必须失败、插值注入被拒、引号/反斜杠/控制字符被拒、补齐在 1/2/12/5000 字节差下都成立、`${`/反引号计数不变、审计放行登记的键并拦下新键、真实翻译表全部通过校验。

`.github/workflows/ci.yml` 在 push/PR 时跑自检。

## 许可

本仓库的脚本与翻译表以 MIT 许可发布（见 `LICENSE`）。StepCode 本身是其上游项目的作品，本仓库**不分发**它——成品二进制由你在本地用自己安装的 `step` 构建出来。

## 还原

```bash
cp ~/.stepcode/bin/step.orig ~/.stepcode/bin/step
```

`step update --self` 会用官方版本覆盖汉化，重跑 `INSTALL=1 ./build.sh` 即可恢复。
