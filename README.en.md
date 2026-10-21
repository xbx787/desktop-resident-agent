<div align="center">
  <img src="src/renderer/assets/whale-tray-icon.png" alt="Whale Companion" width="140">

  <h1>Whale Companion</h1>

  <p>A whale-girl desktop agent for Windows. Click her, chat, and let her work on real files and commands.</p>

  <p>
    <a href="https://github.com/xbx787/whale-companion/releases/latest"><img src="https://img.shields.io/github/v/release/xbx787/whale-companion?display_name=tag&sort=semver" alt="Latest release"></a>
    <img src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4" alt="Windows 10/11 x64">
    <img src="https://img.shields.io/badge/status-preview-orange" alt="Preview">
  </p>

  <p><a href="README.md">简体中文</a> | <strong>English</strong></p>
</div>

---

Whale Companion lives in the corner of your Windows desktop and in the notification area. Open the bubble to talk. Behind it is a full agent built on the Claude Agent SDK, using the DeepSeek API by default, with tools for real files and commands.

## Highlights

- **A companion with a body**: click-to-bounce, ahoge flicks, idle breathing and pose changes — all compositor-driven, and nothing keeps animating while she is idle.
- **A real conversation workbench**: messages, thinking and tool activity share one timeline. Long replies fold into segments; tool rows expand to show the full arguments and output.
- **She gets work done**: read and write files, run commands, search a workspace, reference files and past conversations with `@`, and drop in images or attachments.
- **Side chats**: open an independent conversation inside the current bubble, collapse it, and return to the main thread. Side chats stay out of the library and do not interrupt running work.
- **Message ruler**: a column of marks on the bubble's edge. Scroll to move, click to jump — useful in long conversations.
- **Long-term memory**: a few stable facts are extracted after successful turns and can be edited or deleted in Settings.
- **Persona presets**: the default whale girl plus tsundere, gentle, energetic and sharp-tongued presets. Switching changes the persona text, chat avatar and desktop character together.
- **Self-contained**: the Claude Code engine ships inside the package. Unzip it to a writable folder and run — no Node.js or Claude Code installation required.

## Quick start

1. Download the latest `whale-companion-v*-win-x64.zip` from [Releases](https://github.com/xbx787/whale-companion/releases/latest).
2. Unzip it to a writable folder, for example `D:\Apps\WhaleCompanion`. Do not use `C:\Program Files`.
3. Open `win-unpacked` and run `Whale Companion Preview.exe`.
4. Follow the first-run wizard: paste a DeepSeek API key and choose a workspace. Then click the character to chat.

The key is encrypted on this machine and used only for requests to DeepSeek.

**Requirements**: Windows 10/11 x64, network access to the DeepSeek API, and a DeepSeek API key. The engine is bundled; Node.js and Claude Code are not required. Git for Windows is recommended for command-line tools.

> The executable is not code-signed. On first launch SmartScreen may appear: choose **More info → Run anyway**.

## What it can do

- Read and write files, run commands, and search the workspace.
- Reference files, folders and completed conversations with `@`; drag in images or paste attachments.
- Track tokens and cost per turn; middle-click opens the DeepSeek balance card.
- Voice input, Markdown and math rendering, and a full-screen image viewer.
- Multiple model providers: DeepSeek, Kimi, Zhipu GLM, or a custom endpoint, with a connection test.

## Data and moving

Everything lives under `win-unpacked\data`: conversations, attachments, memory, personas, model profiles and the workspace choice.

- **Update**: quit the app, copy the old `data` folder into the new `win-unpacked`, then start the new version.
- **Move to another PC**: quit the app and copy the whole `win-unpacked` folder. Copy `data` too if you want to keep your history.
- **API keys** are encrypted with Windows machine-bound protection and cannot be decrypted on another PC. The first-run wizard asks for the key again; profiles and conversations are preserved.
- **Workspace**: if the old path no longer exists, it falls back automatically. Confirm or migrate it in Settings → Conversation → Workspace.

## Development

Windows and Node.js 24 are required:

```powershell
npm.cmd install
npm.cmd run dev
```

Build a release with `npm.cmd run pack:release`. See [CHANGELOG.md](./CHANGELOG.md) for per-version notes and [docs](./docs) for design documents.

## Notes

- Only a portable Windows x64 build is provided; there is no installer or auto-updater yet.
- Character artwork comes from public character pages and is intended for personal desktop use. Confirm the rights or replace it with original art before redistributing.
- Voice quality depends on the installed Chinese speech pack and the network.
- Tools such as `windows-mcp` rely on a local `~/.claude.json` configuration and are not bundled with the release.

---

Built on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Default model provided by DeepSeek.

## Third-party components and licenses

- **Claude Code engine / Claude Agent SDK**: © Anthropic PBC. All rights reserved. The `claude.exe` shipped in the release is the unmodified binary published by Anthropic; its use is subject to the [Anthropic Legal and Compliance](https://code.claude.com/docs/en/legal-and-compliance) terms and the applicable Commercial Terms of Service. Each user must use their own API key; this project does not pay for, resell, or intermediate Claude usage. This project is not affiliated with or endorsed by Anthropic.
- **Model endpoint**: the default is a user-configured DeepSeek Anthropic-compatible endpoint. It is not an Anthropic-provided or officially supported inference route; users are responsible for confirming that their use complies with the applicable terms.
- **Character artwork**: comes from public character pages; rights remain with the original owners. It is intended for personal desktop use; confirm permission or replace it with original artwork before redistributing.
- **Live2D Cubism Core**: © Live2D Inc. Distributed as Redistributable Code under the [Live2D Proprietary Software License Agreement](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html). Do not alter or remove its copyright notice; source, retrieval date and SHA-256 are recorded in `resources/live2d/NOTICE.md`. Review the current Live2D distribution terms before a public release.
- **Arch-chan model**: CC0 1.0 Universal, from [Speykious/arch-chan](https://github.com/Speykious/arch-chan). It is a technical Live2D preview only, not a XiaoJing default portrait or persona asset.
- **pixi.js / pixi-live2d-display**: MIT licensed.
- **Other dependencies**: see `package.json` and the license files shipped with each dependency.
