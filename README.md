# Claude Desktop 多账号补丁

非官方 Claude Desktop 补丁，提供多账号切换、账号备份/恢复和 Claude Code 会话同步。

本项目的实现均来自于 [Claude 风控分析与使用指南](https://mp.weixin.qq.com/s/c78TWbi9kUmguLuhHxLDeA?from=groupmessage&isappinstalled=0&scene=1&clicktime=1794127726&enterid=1794127726) 的理论指导。

> 与 Anthropic 官方无关。仅用于自己的账号和设备，风险自负。

## 功能

- **多账号切换**：应用菜单增加 `Switch account`，打开账号列表窗口。
- **添加账号**：只弹出「确认添加新账号吗？」，确认后备份当前账号、清空登录态并重启，登录和验证码由用户手动完成。
- **账号备份/恢复**：macOS 备份钥匙串和数据目录；Windows 通过 `accountAction` 在下次启动时清空/还原。
- **Claude Code 会话同步**：按文件大小取最完整的 `local_*.json`，同步到所有账号。
- **固定时区**：`America/New_York`。

## 原理

- Claude 的业务代码在 `app.asar` 中。解包为 `app` 目录并删除 `app.asar` 后，Electron 会从 `app` 目录加载。
- 在 `app/.vite/build/index.pre.js` 开头注入 `require("./global_main.js")`，让补丁先于 Claude 主逻辑加载。
- `global_main.js` 注册 preload、IPC、`Switch account` 菜单和账号切换窗口。
- 账号信息保存在 `MagicClaude/profile.json`、`profiles.json`；每个账号的数据备份在 `MagicClaude/<uuid>/`。
- `global_session.js` 负责扫描和同步 Claude Code 会话记录。
- `defuse.js` 修改 Electron fuses，关闭 ASAR 完整性校验和「只能从 asar 加载」。

## 安装（macOS）

1. 退出 Claude，备份应用：

```bash
cp -R /Applications/Claude.app /Applications/Claude.app.backup
```

2. 找到安装目录：

```bash
mdfind "kMDItemCFBundleIdentifier == 'com.anthropic.claudefordesktop'"
# 或
ls -d /Applications/Claude*.app
```

3. 解包 `app.asar` 为 `app`，删除 `app.asar`：

```bash
APP="/Applications/Claude.app"
RES="$APP/Contents/Resources"

npx @electron/asar extract "$RES/app.asar" "$RES/app"
rm "$RES/app.asar"
```

4. 在 `app/.vite/build/index.pre.js` 开头的 `"use strict";` 后注入：

```js
try {
  require("./global_main.js");
} catch (err) {
  console.error("global_main load failed", err);
}
```

Python 幂等插入：

```bash
python3 - <<'PY'
from pathlib import Path

p = Path("/Applications/Claude.app/Contents/Resources/app/.vite/build/index.pre.js")
s = p.read_text()
snippet = '''try {
  require("./global_main.js");
} catch (err) {
  console.error("global_main load failed", err);
}
'''

if 'require("./global_main.js")' not in s:
    p.write_text(s.replace('"use strict";', '"use strict";\n' + snippet, 1))
PY
```

5. 同步补丁文件：

```bash
cd /path/to/ClaudeResearch
python3 sync_vite.py
```

6. 修改 fuses：

```bash
npm install --no-save @electron/fuses
node defuse.js

# 检查结果
node node_modules/@electron/fuses/dist/bin.js read --app /Applications/Claude.app
```

确认 `EnableEmbeddedAsarIntegrityValidation` 和 `OnlyLoadAppFromAsar` 为 `Disabled`。

7. 重新签名：

```bash
codesign --force --deep --sign - /Applications/Claude.app
xattr -cr /Applications/Claude.app
codesign --verify --deep --strict --verbose=2 /Applications/Claude.app
```

8. 启动：

```bash
open /Applications/Claude.app
```

## 安装（Windows）

1. 找到安装目录，通常在：

```text
%LOCALAPPDATA%\AnthropicClaude\app-<version>\resources\
```

2. 解包并删除 `app.asar`：

```powershell
$res = "$env:LOCALAPPDATA\AnthropicClaude\app-4.4212.0\resources"
npx @electron/asar extract "$res\app.asar" "$res\app"
Remove-Item "$res\app.asar"
```

3. 注入相同的 `index.pre.js` 启动代码。

4. 同步补丁：

```powershell
python sync_vite_windows.py
```

5. 修改 fuses：把 `defuse.js` 中的 `pathToAppExecutable` 改为 Claude 的 `.exe` 路径，然后：

```powershell
npm install --no-save @electron/fuses
node defuse.js
```

Windows 无需重新签名。

## 使用

- **切换账号**：菜单 → `Switch account` → 选择目标账号 → 确认，应用会保存当前账号并重启。
- **添加账号**：`Add account` → 确认 → 应用重启，之后手动输入邮箱、填写验证码并完成登录。
- **同步会话**：账号窗口中的「同步所有账号 Claude Code 记录」→ 确认 → 应用重启。
- **数据目录**：
  - macOS：`~/Library/Application Support/MagicClaude/`
  - Windows：`%APPDATA%\MagicClaude\`
- **错误日志**：`MagicClaude/switch-error.log`、`MagicClaude/session-sync-report.json`。

## 常见问题

**启动后没有 Switch account 菜单**

检查 `index.pre.js` 是否包含 `require("./global_main.js")`，以及 `.vite/build/global_main.js` 是否已同步。

**提示应用已损坏**

重新执行 macOS 的签名步骤：

```bash
codesign --force --deep --sign - /Applications/Claude.app
xattr -cr /Applications/Claude.app
```

**Claude 更新后补丁失效**

更新会替换 `app.asar`、`app` 目录和可执行文件。重新解包、注入、同步 `.vite`、修改 fuses 并重签即可。

## 免责声明

本项目仅供学习、研究和备份自己的账号数据使用。请遵守 Anthropic 服务条款和当地法律法规，不要用于账号共享、盗用或绕过付费。
