# CC Pocket

CC Pocket 是一款用于 Codex / Claude 编程代理会话的移动与桌面客户端。
代理运行在你自己的 Mac 或 Linux 主机上，你可以从 iPhone、iPad、
Android 或原生 macOS App 启动会话、批准操作、回答问题并审查 diff。

[English README](README.md) | [日本語 README](README.ja.md)

<p align="center">
  <img src="docs/images/screenshots-zh-CN.png" alt="CC Pocket 截图" width="800">
</p>

## 安装

1. 在运行会话的主机上安装至少一个代理 CLI：
   [Codex](https://github.com/openai/codex) 或 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)。
2. 在同一台主机上安装 [Node.js](https://nodejs.org/) 18 或更高版本。
3. 启动 CC Pocket Bridge Server：

```bash
npx @ccpocket/bridge@latest
```

4. 安装 CC Pocket，并扫描 Bridge Server 打印出的二维码。
5. 选择项目，再选择 Codex 或 Claude，然后从 App 启动会话。

| 平台 | 安装 |
|------|------|
| **iOS / iPadOS** | <a href="https://apps.apple.com/us/app/cc-pocket-code-anywhere/id6759188790"><img height="40" alt="Download on the App Store" src="docs/images/app-store-badge.svg" /></a> |
| **Android** | <a href="https://play.google.com/store/apps/details?id=com.k9i.ccpocket"><img height="40" alt="Get it on Google Play" src="docs/images/google-play-badge-en.svg" /></a> |
| **macOS** | 从 [GitHub Releases](https://github.com/K9i-0/ccpocket/releases?q=macos) 下载最新 `.dmg`。请查找带有 `macos/v*` 标签的发行版。 |

## 可以做什么

- **随时运行代理会话**：从手机、平板或 Mac 启动、恢复并监控 Codex / Claude 会话。
- **及时处理审批**：不用回到键盘前，也能批准命令、文件编辑、MCP 请求和代理提问。
- **先审查再落地**：查看文件、浏览 git diff、预览图片 diff、stage / revert，并生成提交信息。
- **在移动端编写丰富提示词**：支持 Markdown、补全、语音输入和图片附件。
- **安全地并行工作**：用 git worktree 将不同会话隔离到独立工作目录。
- **管理你的机器**：支持保存主机、二维码、mDNS、SSH start/stop/update 和推送通知。
- **适配大屏工作流**：在 iPad / macOS 上使用多窗格布局。

## 工作方式

CC Pocket 由两部分组成：

```text
CC Pocket app  <->  你自己机器上的 Bridge Server  <->  Codex / Claude
```

App 是操作界面。Bridge Server 在能够访问你的项目、shell、git 仓库和代理 CLI
的主机上运行。你的代码留在自己的机器上，不需要迁移到托管 IDE。

这和 Claude Code Remote Control 不同。Remote Control 会把已经在 Mac 上启动的
终端会话交接到手机上；CC Pocket 则是从 App 发起会话，并把主机作为后台执行环境。

## 远程访问

在同一网络内，你可以使用二维码、mDNS 自动发现，或手动输入
`ws://` / `wss://` URL 连接。

如果要从家或办公室之外访问，推荐使用 Tailscale：

1. 在主机和手机上安装 [Tailscale](https://tailscale.com/)
2. 加入同一个 tailnet
3. 从 CC Pocket 连接 `ws://<host-tailscale-ip>:8765`

对于长期在线的主机，也可以把 Bridge Server 注册为后台服务：

```bash
npx @ccpocket/bridge@latest setup
```

服务化设置支持 macOS launchd 和 Linux systemd。

## 说明

- Claude 会话需要 `@ccpocket/bridge` `1.25.0` 或更高版本，以及 `ANTHROPIC_API_KEY`。
  新的 Bridge 安装不支持通过 `/login` 使用 Claude subscription login。
  详情请见 [Claude 认证排查](docs/auth-troubleshooting.zh-CN.md)。
- CC Pocket 围绕自托管和最少数据收集设计。Supporter 购买可以在同一个
  Apple ID / Google 账号内恢复，但不会在不同商店之间同步。
  详情请见 [Supporter / Purchases](docs/supporter_zh.md)。
- macOS 截图功能需要为运行 Bridge Server 的终端应用授予屏幕录制权限。
- CC Pocket 与 Anthropic 或 OpenAI 没有任何关联，也未获得其认可、赞助或官方合作。

## 开发

```bash
git clone https://github.com/K9i-0/ccpocket.git
cd ccpocket
npm install
cd apps/mobile && flutter pub get && cd ../..
```

常用命令：

| 命令 | 说明 |
|------|------|
| `npm run bridge` | 以开发模式启动 Bridge Server |
| `npm run bridge:build` | 构建 Bridge Server |
| `npm run dev` | 重启 Bridge 并启动 Flutter App |
| `npm run test:bridge` | 运行 Bridge Server 测试 |
| `cd apps/mobile && flutter test` | 运行 Flutter 测试 |
| `cd apps/mobile && dart analyze` | 运行 Dart 静态分析 |

贡献指南请见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[FSL-1.1-MIT](LICENSE): 源码可用，并将于 2028-03-17 自动转换为 MIT。

本仓库包含适用于 `@ccpocket/bridge` 的 Bridge Redistribution Exception。
只要明确标注为非官方且不提供支持，就允许面向特定环境制作 fork 或进行再分发。
