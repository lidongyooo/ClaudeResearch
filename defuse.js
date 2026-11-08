const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses');
const path = require('path');

// 指向目标 macOS App 的核心可执行文件（Mach-O）
// 注意：通常在 Target.app/Contents/MacOS/Target 路径下
// const pathToAppExecutable = "~/AppData/Local/AnthropicClaude/app-4.4212.0/claude.exe";
const pathToAppExecutable = "/Applications/Claude.app/Contents/MacOS/Claude";
// codesign --force --deep --sign - /Applications/Claude.app

async function main() {
  try {
    await flipFuses(pathToAppExecutable, {
      version: FuseVersion.V1,
      // 允许使用 ELECTRON_RUN_AS_NODE
      [FuseV1Options.RunAsNode]: true, 
      // 允许使用 NODE_OPTIONS 环境变量
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: true, 
      // 允许使用 --inspect 等调试参数
      [FuseV1Options.EnableNodeCliInspectArguments]: true, 
      // 如果需要关闭 ASAR 完整性校验，可以设为 false (视你的改机需求而定)
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
    });
    console.log('Fuses 状态修改成功！');
  } catch (err) {
    console.error('修改失败:', err);
  }
}

main();
