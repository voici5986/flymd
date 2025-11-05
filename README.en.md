## FlySpeed Markdown (flyMD)

[简体中文](README.md) | English

[![Version](https://img.shields.io/badge/version-v0.1.4-blue.svg)](https://github.com/flyhunterl/flymd)
[![License](https://img.shields.io/badge/license-NonCommercial-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)](https://github.com/flyhunterl/flymd)

A cross‑platform, lightweight and polished Markdown editor & PDF reader.

Highlights
- Small and instant: tiny installer, millisecond cold start, one‑click code copy
- Clean UI: minimalist layout (menubar + editor), distraction‑free
- Library: folder tree with file management (new/rename/move/delete)
- Safe preview: local‑only app; DOMPurify sanitizes HTML automatically
- Image bed: S3/R2 integration; paste/drag to upload and insert URL
- Full stack: Markdown, KaTeX (LaTeX), Mermaid, HTML preview, highlight.js
- WYSIWYG: live render while typing (v0.0.6) with improved V2 experience (v0.1.3)
- Performance: lazy‑loaded renderer/highlighter, pure TypeScript
- Position memory: remember last read/edit position per file
- Sync: WebDAV extension with logs and conflict prompts
- Plugins: extension system; install from GitHub/URL

Screenshots
- See the Chinese README for the gallery.

Core Features
- Edit
  - Native `<textarea>` with zero‑latency input
  - WYSIWYG toggle: `Ctrl+W`; auto focus on launch; caret location shown
  - UTF‑8; shortcuts: `Ctrl+B`/`Ctrl+I`; insert link `Ctrl+K`
- Read
  - Toggle Edit/Preview: `Ctrl+E`; quick Preview: `Ctrl+R`
  - markdown‑it + highlight.js; DOMPurify for safe HTML
  - External links get `target="_blank"` and `rel="noopener"`
  - Local images auto‑converted to `asset:` in Tauri; KaTeX & Mermaid support
  - In WYSIWYG, Mermaid editing is silent; it renders after you leave the code block. Parse errors are suppressed to avoid interrupting typing.
- Files
  - Open (`Ctrl+O`) for .md/.markdown/.txt; Save/Save As/New `Ctrl+S`/`Ctrl+Shift+S`/`Ctrl+N`
  - Recent (up to 5); unsaved indicator `*` in title bar; unified native dialogs
  - Drag & drop: open `.md`; drop images to insert markdown

Sidebar Outline (Markdown / PDF)
- Markdown: extract H1–H6 to build a clickable outline; scroll‑sync the active section; highlight the current heading; fold/unfold at H1/H2 with remembered state
- PDF: parse PDF bookmarks (Outline) and build a clickable TOC; jump to pages; cache per file and auto‑invalidate by mtime
- Note: `pdfjs-dist` must be installed in dev/build environments; the app lazy‑loads it only when opening the PDF Outline. End users do not need to install it.

Image Upload (S3/R2)
- Priority
  - Enabled + configured: upload and insert public URL (no local copy)
  - Disabled/not configured: save locally (existing doc -> sibling `images/`; unsaved doc -> system Pictures)
  - Upload failed while enabled: fallback to local save

UI/UX
- Windows‑style menubar; File/Mode menus with shortcuts
- Follow system light/dark theme; flicker‑free overlay preview
- Window state is persisted

Performance
- Lazy load highlighter and renderer; pure TypeScript; lean event wiring

Development & Build
- Run
  - Dev: `npm run dev`
  - Tauri Dev: `npm run tauri:dev`
- Build
  - Frontend: `npm run build`
  - Tauri Package: `npm run tauri:build`
- Optional dependency (for PDF Outline only):
  - `npm i pdfjs-dist`
  - The app lazy‑loads PDF.js to parse PDF bookmarks and only when the “Outline” tab is viewed for a PDF.

Install
- Download the latest assets from Releases and run the installer
- Requirements: Windows 10/11 (x64) / Linux / macOS; WebView2 on Windows

Shortcuts
- `Ctrl+N` New | `Ctrl+O` Open | `Ctrl+S` Save | `Ctrl+Shift+S` Save As
- `Ctrl+E` Edit/Preview | `Ctrl+R` Quick Preview | `Ctrl+W` Toggle WYSIWYG
- `Ctrl+B` Bold | `Ctrl+I` Italic | `Ctrl+K` Insert Link | `Esc` Close

Extensions
- Build your own extensions or install from GitHub/URL
- Example: Typecho Publisher — https://github.com/TGU-HansJack/typecho-publisher-flymd

Changelog
- v0.1.5 (in progress)
  - WYSIWYG: silence Mermaid rendering errors to avoid disrupting input
  - File icons by format: MD unchanged; PDF in red; TXT in purple
  - New Sidebar Outline: Markdown (Edit/Read) and PDF bookmarks
  - Fix: remove the persistent “no library selected” prompt after selecting a library
  - Restore vertical scrollbars with a clean, consistent UI; avoid horizontal scrolling
  - Tabs: show file name (append parent for duplicates), unsaved marker `*`, window title sync, tooltip shows full path
- v0.1.4
  - Sync: add root/dir snapshots to speed up remote scanning
  - Fix: LaTeX rendering errors in Reading mode; LaTeX global render in WYSIWYG
  - Fix: no save prompt when closing unsaved docs
  - Fix: code block formatting in Reading mode
  - Fix: missing Linux app icon
- v0.1.3
  - Refactor: WYSIWYG V2 for better editing experience
  - Add: save prompts when switching docs; shortcuts `Ctrl+R` (Read) `Ctrl+W` (WYSIWYG)
  - Change: more flexible library sidebar; multi‑level menus
  - Fix: add missing macOS update feed
- v0.1.2
  - UI: improved extension window/style; richer sync logs and options
  - Sync: faster scanning; better deletion prompts and recovery
  - Library: create/delete folders; Fix: print entire document

License & Compliance
- Non-Commercial Open License (flyMD NC 1.0). See [LICENSE](LICENSE).
- Allowed: use/modify/copy/redistribute for non-commercial purposes with attribution and source link.
- Commercial use: prohibited without prior written authorization. Contact: flyhunterl <flyhunterl@gmail.com>.
- Third-party licenses: see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- Translation note: in case of any discrepancy, the Chinese original in LICENSE prevails.

Acknowledgements
- Tauri, markdown‑it, DOMPurify, highlight.js, KaTeX, Mermaid

FAQ (Linux)
- Arch/empty window troubleshooting: see arch.md
