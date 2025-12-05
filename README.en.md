<h1 align="center">Fly Markdown (FlyMD)</h1>

<p align="center">
  <strong>Just 7MB - A Free & Powerful Markdown Editor / PDF Reader</strong>
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/flyhunterl/flymd/releases/latest"><img src="https://img.shields.io/github/v/release/flyhunterl/flymd" alt="GitHub Release" /></a>
  <a href="https://github.com/flyhunterl/flymd/releases/latest"><img src="https://img.shields.io/github/release-date/flyhunterl/flymd" alt="Release Date" /></a>
  <a href="https://github.com/flyhunterl/flymd/actions/workflows/build.yml"><img src="https://github.com/flyhunterl/flymd/actions/workflows/build.yml/badge.svg" alt="Build Status" /></a>
  <a href="https://github.com/flyhunterl/flymd/stargazers"><img src="https://img.shields.io/github/stars/flyhunterl/flymd" alt="GitHub Stars" /></a>
  <img src="https://img.shields.io/github/downloads/flyhunterl/flymd/total" alt="GitHub Downloads" />
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-NonCommercial-green.svg" alt="License" /></a>
  <a href="https://github.com/flyhunterl/flymd"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg" alt="Platform" /></a>
  <a href="https://github.com/microsoft/winget-pkgs/tree/master/manifests/f/flyhunterl/FlyMD"><img src="https://img.shields.io/badge/winget-flyhunterl.FlyMD-blue" alt="Winget" /></a>
  <a href="https://t.me/+3SOMbwSbCvIxMGQ9"><img src="https://img.shields.io/badge/Telegram-Join-blue?logo=telegram&logoColor=white" alt="Telegram Community" /></a>
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/f007f4cd-4c3f-46f7-8080-72e2128990e1" alt="FlyMD main interface" width="32%" />
  <img src="https://github.com/user-attachments/assets/391ef7ec-9741-4c3e-b5ef-b8573ebf021c" alt="Library and multi-pane layout" width="32%" />
  <img src="https://github.com/user-attachments/assets/2d84d6fe-623b-48cf-8d6f-3e925a9d6b12" alt="AI assistant and sticky notes" width="32%" />
</p>

---

## Table of Contents

- [Introduction](#-introduction)
- [Core Features](#-core-features)
- [Focus Mode](#-focus-mode-immersive-writing-experience)
- [AI + Todo Integration](#-ai--todo-integration-your-intelligent-life-assistant)
- [Getting Started](#-getting-started)
- [Extension Development](#-extension-development)
- [Performance Metrics](#-performance-metrics)
- [License](#-license)
- [Community Developers](#-community-developers)
- [Acknowledgments](#-acknowledgments)
- [FAQ](#-faq)

---

## 📖 Introduction

**Say goodbye to bloat, lag, and fragmented experience!**

FlyMD is a high-performance Markdown editor in just **7MB**, featuring **WYSIWYG + Source Code** dual-mode support, integrated **AI Assistant** and **Smart Todo Reminder Push System**. Cross-platform support for Windows / Linux / macOS. Lightweight yet powerful, built for efficient writing.

### 🧑‍🤝‍🧑 Community

Stay connected for the latest updates, preview builds, and tips:

| Platform | Link |
|----------|------|
| QQ Group | 343638913 |
| Telegram | [t.me/+3SOMbwSbCvIxMGQ9](https://t.me/+3SOMbwSbCvIxMGQ9) |

---

## ✨ Core Features

### 🎨 Editing Experience

| Feature | Description |
|---------|-------------|
| **Source Code / WYSIWYG Dual Mode** | Switch freely between edit and preview modes |
| **Millisecond-Level Startup** | Instant loading, smooth writing, no lag |
| **Reading Position Memory** | Resume where you left off, never lose your place |
| **Outline / TOC Support** | Smart outline, quick navigation for long documents |
| **Customizable Context Menus** | Drag-and-drop sorting, frequent actions stay on top |

### 🚀 Advanced Features

| Feature | Description |
|---------|-------------|
| **One-Click Publish** | Typecho / WordPress / Halo blog platforms |
| **AI Assistant Extension** | Writing assistance, polishing, and error correction with Markdown rendering and code highlighting |
| **Smart Todo Reminder** | Auto-detect TODOs, push via WeChat, SMS, Email, DingTalk, Feishu |
| **Collaborative Editing (Beta)** | Use the open-source collaboration server + extension to co-edit documents with others on your own server (install the "Collaboration (Open Server)" extension and configure its WebSocket endpoint); to join the official collaboration server beta, join QQ Group `343638913` to request access |
| **iframe Embedding** | Embed music, videos, maps, online documents |
| **Selection-Aware AI** | Right-click actions target only selected text for precise editing |
| **Tabs & Sticky Notes Toolkit** | Tab right-click menu supports opening in a new instance, renaming files, and one-click creating sticky note windows that stay on your desktop |

> 💡 The AI Assistant extension installs silently on first launch. If you uninstall it, FlyMD will never auto-install it again.
> ⚠️ The built-in AI models are designed to lower the barrier to using AI so more people can benefit from its convenience and efficiency. To keep the writing experience stable for everyone, FlyMD applies strict rate limits to these built-in models—please do not abuse this free quota.

### Smart Document Recognition & Desktop Sticky Notes

**Ten color options**
**Customizable transparency**
**Interactive visual controls**

<img width="400" height="300" alt="20251128_143927_883" src="https://github.com/user-attachments/assets/0cfa8789-93e0-4925-9da8-a1c0711ca55c" />

### 💻 Platform & Format

- **Cross-Platform**: Windows / Linux / macOS
- **Multi-Format Export**: PDF / DOCX
> ⚠️ Linux tip: On Arch / Manjaro and other Arch-based distributions, the AppImage may show white/blank screens due to WebKitGTK or GPU driver issues. It is recommended to convert the `.deb` package into a pacman package via debtap / PKGBUILD instead; see [Arch installation & troubleshooting guide](arch.md) for details.

### 🔐 Security & Performance

- **Local-First** - Zero background network, secure and controllable data
- **Image Hosting** - S3/R2 one-click upload, auto-insert image links
- **WebDAV Sync** - Multi-device sync with end-to-end encryption and HTTP host whitelists
- **Extension System** - Custom extensions, unlimited possibilities

### 🎨 Theme & Interface

- Auto-detect system dark mode and switch themes accordingly
- Rich theme presets with background colors and Markdown typography layouts
- Tab bar styling optimized for dark mode

---

## 🎯 Focus Mode: Immersive Writing Experience

> **Hide everything, keep only inspiration**

Press `Ctrl+Shift+F` to enter Focus Mode and enjoy true immersive writing:

- **Zero distraction** - Hide all UI elements, leaving only a clean editing area
- **Pure creation** - No title bar, no menu, no distractions—let thoughts flow freely
- **One-click switch** - Instantly enter your flow state

**Use Cases**: 📝 Long-form writing · ✍️ Creative bursts · 🎨 Document presentations · 📌 Desktop sticky notes

---

## 🤖 AI + Todo Integration: Your Intelligent Life Assistant

**This isn't cyberpunk—this is real life.** When AI Assistant meets Todo Plugin, your notebook transforms into an intelligent life manager.

### Typical Scenarios

| Scenario | Description |
|----------|-------------|
| 📅 **Personal Habit Building** | Write "wake up at 6 AM tomorrow" → AI recognizes and sends phone reminder |
| 🗺️ **Travel Itinerary** | Paste travel guide → AI extracts time points, sends WeChat reminders |
| 💼 **Team Meeting Management** | Record meeting schedule → Team receives DingTalk/Email/WeChat reminders |

### How It Works

1. **AI Smart Analysis** - Automatically extract time, events, and people information
2. **Auto-Create Todos** - Intelligently generate todo items
3. **Multi-Channel Push** - Send reminders via WeChat, SMS, email, phone calls

> 💡 Install both "AI Assistant" and "Todo Reminder" extensions to experience this powerful feature.

### 🆓 Built-in Free AI Service

Since **v0.4.0**, built-in free AI service—**ready to use out of the box**, no API key required.

<a href="https://cloud.siliconflow.cn/i/X96CT74a" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/plugins/ai-assistant/Powered-by-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="public/plugins/ai-assistant/Powered-by-light.png">
    <img alt="Powered by SiliconFlow" src="public/plugins/ai-assistant/Powered-by-light.png" width="200">
  </picture>
</a>

> 💡 [Register a SiliconFlow account](https://cloud.siliconflow.cn/i/X96CT74a) to unlock more powerful models and higher rate limits.

---

## 🚀 Getting Started

### Installation

Download from [Releases](https://github.com/flyhunterl/flymd/releases):

| Platform | Installation |
|----------|--------------|
| **Windows** | `winget install flyhunterl.FlyMD` or download installer |
| **Linux** | Supports mainstream desktop environments |
| **macOS** | Supports Intel and Apple Silicon |

<details>
<summary><strong>macOS Installation Notes</strong></summary>

Due to the app not being notarized by Apple, you may see a "damaged" warning on first launch.

**Method 1: Terminal Command (Recommended)**
```bash
sudo xattr -r -d com.apple.quarantine /Applications/flymd.app
```

**Method 2: System Settings**
1. Open Finder and locate the downloaded app
2. **Hold Control and click** the app icon, then select "Open"
3. Click "Open" in the dialog that appears

> ⚠️ FlyMD is open-source with fully transparent code. The "damaged" warning is only because we haven't paid for Apple's code signing.

</details>

### Keyboard Shortcuts

| Action | Shortcut | Action | Shortcut |
|--------|----------|--------|----------|
| New File | `Ctrl+N` | Toggle Edit/Preview | `Ctrl+E` |
| New Tab | `Ctrl+T` | Toggle WYSIWYG | `Ctrl+W` |
| Open File | `Ctrl+O` | Quick Reading | `Ctrl+R` |
| Save File | `Ctrl+S` | Focus Mode | `Ctrl+Shift+F` |
| Find & Replace | `Ctrl+H` | Close Tab | `Alt+W` |

### Config & Portability

- **Export/Import Config** - One-click migration of full environment (extensions & settings)
- **Portable Mode** - All config in app root directory, ideal for USB drives

### Multi-Tab Workflow

- `Ctrl+T` opens blank tab, current document stays intact
- `Ctrl+Tab` / `Ctrl+Shift+Tab` to cycle through tabs
- Hold `Ctrl` and click library document to open in new tab with edit mode
- Tabs support right-click context menu

### Images & Sync

- **Image Handling**: Auto-process paste/drag, supports S3/R2 image hosting
- **WebDAV Sync**: Multi-device sync with end-to-end encryption and HTTP host whitelists

---

## 🔌 Extension Development

FlyMD supports enhancing functionality through extension plugins:

- Install from GitHub or HTTP URL
- Develop custom extensions

📚 **Documentation**: [扩展开发文档 (中文)](plugin.md) | [Extension Documentation (English)](plugin.en.md)

### Example Extensions

| Extension | Function |
|-----------|----------|
| AI Writing Assistant | Smart writing, content polishing, grammar checking |
| Typecho Publisher | One-click publish to Typecho blog |
| Todo Reminder | Push to WeChat, SMS, Email, etc. |
| Batch Export PDF | Batch export Markdown to PDF |
| Word Count | Real-time character count, word count, reading time |

### 🧩 Featured Extensions

| Extension | Description |
|-----------|-------------|
| High-Precision PDF Parser | Accurate PDF text, table and outline parsing, ideal for technical docs and research papers |
| Markdown Table Assistant | Generate, align and reorder Markdown tables in one step, no more manual spacing hell |
| Collaborative Editing | Real-time multi-user editing via collaboration server with cursor sync and basic conflict handling |
| Typecho Post Manager | Manage Typecho drafts, snapshots and rollbacks locally with one-click publish and update |

---

## 📊 Performance Metrics

| Metric | Value |
|--------|-------|
| ⚡ Cold Start | ≤ 300ms |
| 📦 Installer Size | ≤ 10MB |
| 💾 Memory Footprint | ≤ 50MB |
| 🔄 Preview Toggle | ≤ 16ms |

---

## 🗺️ Roadmap

See: [ROADMAP.en.md](ROADMAP.en.md)

---

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=flyhunterl/flymd&type=date&legend=top-left)](https://www.star-history.com/#flyhunterl/flymd&type=date&legend=top-left)

---

## 📄 License

This project uses "FlySpeed MarkDown (flyMD) Non-Commercial Open Source License (NC 1.0)".

- ✅ **Allowed**: Non-commercial use, modification, copying, and redistribution (attribution required)
- ❌ **Prohibited**: Commercial use without authorization

For commercial licensing, contact: flyhunterl <flyhunterl@gmail.com>

Full License: [LICENSE](LICENSE) | Third-Party Components: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

---

## 👨‍💻 Community Developers

| Developer | Contribution |
|-----------|-------------|
| [xf959211192](https://github.com/xf959211192) | Telegraph-Image image hosting uploader |
| [Vita0519](https://github.com/Vita0519) | Xiaohongshu copywriting generator AI extension |

---

## 🙏 Acknowledgments

| Project | Purpose |
|---------|---------|
| [Tauri](https://tauri.app/) | Cross-platform framework |
| [MilkDown](https://milkdown.dev/) | WYSIWYG editor |
| [markdown-it](https://github.com/markdown-it/markdown-it) | Markdown rendering |
| [DOMPurify](https://github.com/cure53/DOMPurify) | HTML sanitization |
| [highlight.js](https://highlightjs.org/) | Code highlighting |
| [KaTeX](https://katex.org/) | Math formula rendering |
| [Mermaid](https://mermaid.js.org/) | Diagram drawing |

### 🤝 Ecosystem Partners

| Partner | Description | Support Type |
|---------|-------------|--------------|
| [SiliconFlow](https://cloud.siliconflow.cn/i/X96CT74a) | Leading AI capability provider | Model Service Support |
| [XXTUI](https://www.xxtui.com/) | Simple and efficient personal push API | Push Service Support |
| [x666.me](https://x666.me/register?aff=yUSz) | Quality AI API support with care | Model Service Support |

---

## 🤝 Contributing

Issues and Pull Requests are welcome!

---

## ❓ FAQ

<details>
<summary><strong>macOS says the app is "damaged" and won't open?</strong></summary>

Run: `sudo xattr -r -d com.apple.quarantine /Applications/flymd.app`, or hold Control and click the app then select "Open".

</details>

<details>
<summary><strong>Arch Linux blank screen?</strong></summary>

See [Solution for Arch Linux blank screen](arch.md).

</details>

<details>
<summary><strong>Right-click menu taken over by a plugin?</strong></summary>

Press `Shift + Right Click` to open the native context menu.

</details>

<details>
<summary><strong>Need larger content or different margins?</strong></summary>

- `Shift + Mouse Wheel` to adjust content width (margins)
- `Ctrl + Mouse Wheel` to enlarge text and images

</details>

<details>
<summary><strong>Does WYSIWYG mode support todo lists?</strong></summary>

Not yet—`- [ ]` / `- [x]` checkboxes only work in source/preview modes for now.

</details>

---

## Open Source Support

These are stable model providers I personally use. Signing up through the following links helps me reduce development costs, and you also get partial credits:


⭐⭐⭐[rightcode: Highly stable and cost-effective Claude and Codex relay service](https://www.right.codes/register?aff=E8E36524)


⭐⭐⭐[PackyCode: Cost-effective Claude, Codex, and Gemini relay service](https://www.packyapi.com/register?aff=Rqk1)


[OhMyGPT: A high-quality AI service platform](https://x.dogenet.win/i/dXCKvZ6Q) "Get a $20 bonus by registering with Google/GitHub OAuth"
**Gmail and QQ email addresses only**

<img width="300" height="300" alt="image" src="https://github.com/user-attachments/assets/4a716fd5-dc61-4a4f-b968-91626debe8d2" />
