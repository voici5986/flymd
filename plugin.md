# flyMD 扩展开发文档

[简体中文](plugin.md) | [English](plugin.en.md)

> 本文档介绍如何为 flyMD 开发扩展插件

## 目录

- [概述](#概述)
- [快速开始](#快速开始)
- [插件结构](#插件结构)
- [插件API](#插件api)
- [生命周期](#生命周期)
- [示例插件](#示例插件)
- [发布插件](#发布插件)
- [主题扩展（Theme）](#主题扩展theme)

## 概述

flyMD 提供了灵活的扩展系统，允许开发者通过编写插件来扩展编辑器的功能。插件可以：

- 添加自定义菜单项
- 访问和修改编辑器内容
- 调用 Tauri 后端命令
- 使用 HTTP 客户端进行网络请求
- 存储插件专属的配置数据
- 显示通知和确认对话框

### 内置扩展

flyMD 已内置以下扩展：

1. **图床 (S3/R2)** - 支持将图片上传到 S3/R2 对象存储
2. **WebDAV 同步** - 支持通过 WebDAV 协议同步文档
3. **Typecho 发布器** - 将文章发布到 Typecho 博客平台（可选安装）

## 快速开始

### 1. 创建插件项目

创建一个新的目录，并添加以下文件：

```
my-plugin/
├── manifest.json    # 插件清单文件
└── main.js          # 插件主文件
```

### 2. 编写 manifest.json

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "插件功能描述",
  "main": "main.js"
}
```

**字段说明：**
- `id`（必需）：插件唯一标识符，建议使用小写字母和连字符
- `name`（必需）：插件显示名称
- `version`（必需）：插件版本号，建议使用语义化版本
- `author`（可选）：作者信息
- `description`（可选）：插件功能描述
- `main`（必需）：插件入口文件，默认为 `main.js`
- `minHostVersion`（可选）：插件要求的 flyMD 最低版本号。如果用户的 flyMD 版本低于此版本，将拒绝安装并提示用户升级

### 3. 编写 main.js

```javascript
// main.js
export function activate(context) {
  // 插件激活时执行
  context.ui.notice('我的插件已激活！', 'ok', 2000);

  // 添加菜单项
  context.addMenuItem({
    label: '我的插件',
    title: '点击执行插件功能',
    onClick: async () => {
      const content = context.getEditorValue();
      context.ui.notice('当前内容长度：' + content.length, 'ok');
    }
  });
}

export function deactivate() {
  // 插件停用时执行（可选）
  console.log('插件已停用');
}

export function openSettings(context) {
  // 打开插件设置界面（可选）
  context.ui.notice('打开设置界面', 'ok');
}
```

### 4. 发布到 GitHub

1. 在 GitHub 创建仓库
2. 将 `manifest.json` 和 `main.js` 推送到仓库
3. 用户可通过 `username/repo` 或 `username/repo@branch` 格式安装

### 5. 安装插件

在 flyMD 中：
1. 点击菜单栏"扩展"按钮
2. 在安装扩展输入框中输入：
   - GitHub 仓库：`username/repository` 或 `username/repository@branch`
   - HTTP URL：`https://example.com/path/to/manifest.json`
3. 点击"安装"按钮

## 插件结构

### 基本结构

```
my-plugin/
├── manifest.json       # 插件清单（必需）
├── main.js            # 插件主文件（必需）
├── README.md          # 说明文档（推荐）
└── assets/            # 资源文件（可选）
    └── icon.png
```

### manifest.json 详解

```json
{
  "id": "example-plugin",
  "name": "示例插件",
  "version": "1.0.0",
  "author": "Your Name <email@example.com>",
  "description": "这是一个示例插件，展示如何开发 flyMD 扩展",
  "main": "main.js",
  "minHostVersion": "0.3.0",
  "homepage": "https://github.com/username/example-plugin",
  "repository": "https://github.com/username/example-plugin"
}
```

**版本兼容性示例：**

如果你的插件使用了 flyMD 0.3.5 版本才引入的新 API，你可以这样设置：

```json
{
  "id": "my-advanced-plugin",
  "name": "高级功能插件",
  "version": "2.0.0",
  "minHostVersion": "0.3.5",
  "description": "此插件需要 flyMD 0.3.5 或更高版本"
}
```

当用户尝试在 flyMD 0.3.4 或更低版本上安装此插件时，会收到错误提示：
```
此扩展需要 flyMD 0.3.5 或更高版本，当前版本为 0.3.4。
请先升级 flyMD 再安装此扩展。
```

## 插件API

插件通过 `context` 对象访问 flyMD 的功能。

### context.http

HTTP 客户端，用于网络请求。

```javascript
// GET 请求
const response = await context.http.fetch('https://api.example.com/data', {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json'
  }
});
const data = await response.json();

// POST 请求
const response = await context.http.fetch('https://api.example.com/post', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ key: 'value' })
});
```

### context.htmlToMarkdown

使用 flyMD 内置的 HTML → Markdown 转换器，将一段 HTML 文本转换为 Markdown 字符串。  
适合从外部系统（博客后台 / Web API / 剪贴板等）获取 HTML 内容后，统一落地为本地 Markdown 文件。

```javascript
// 基本用法：将简单 HTML 片段转换为 Markdown
const md = await context.htmlToMarkdown('<h1>标题</h1><p>一段<b>粗体</b>文字</p>');
// md: "# 标题\n\n一段**粗体**文字"

// 带 baseUrl 的用法：用于把相对链接转换为绝对链接
const html = '<p><a href="/post/123">查看详情</a></p>';
const md2 = await context.htmlToMarkdown(html, {
  baseUrl: 'https://example.com'
});
// md2: "[查看详情](https://example.com/post/123)"
```

**参数说明：**

- `html: string`：待转换的 HTML 字符串（必填）
- `opts.baseUrl?: string`：可选，作为相对链接的基准 URL。  
  例如远端返回 `<a href="/a/b">`，传入 `baseUrl: 'https://example.com'` 后会转换为 `https://example.com/a/b`。

**返回值：**

- `Promise<string>`：转换后的 Markdown 文本；  
  - 如果传入为空或转换失败，会返回空字符串（不会抛出异常，方便插件按需回退处理）。

**典型场景：Typecho / WordPress 文章拉取**

配合 `context.http.fetch` 从远端 XML-RPC / REST API 拉取 HTML 内容后，使用 `context.htmlToMarkdown` 统一转换为 Markdown，再写入本地文件或当前文档正文。

```javascript
export async function activate(context) {
  context.addMenuItem({
    label: '从远端拉文章',
    async onClick() {
      // 1. 调用远端接口获取 HTML 内容
      const resp = await context.http.fetch('https://blog.example.com/api/post/123');
      const raw = await resp.json();
      const html = raw.content || '';

      // 2. 使用内置转换器转为 Markdown
      const md = await context.htmlToMarkdown(html, {
        baseUrl: 'https://blog.example.com'
      });

      // 3. 落到当前文档（或写本地文件）
      if (md && md.trim()) {
        context.setEditorValue(md);
        context.ui.notice('文章已转换为 Markdown', 'ok');
      } else {
        context.ui.notice('HTML 转 Markdown 失败或内容为空', 'err');
      }
    }
  });
}
```

### context.getFrontMatterRaw / context.getDocMeta / context.getDocBody

读取当前文档头部的 YAML Front Matter 以及解析后的元数据，适合博客发布、文库增强、外部应用同步等场景统一使用。

> 识别规则：
> - 仅当文首满足以下形式时才认为存在 Front Matter：  
>   - 第一行是 `---`  
>   - 中间至少一行看起来像 `key: value`  
>   - 再遇到一行单独的 `---` 结束  
> - 不满足时，这三个方法会把文档当作普通 Markdown 处理，不会修改文件内容

```javascript
// 1. 原始 Front Matter 文本（包含 --- 分隔线），不存在时为 null
const raw = context.getFrontMatterRaw();
// 例如：
// ---
// title: "This is the title"
// keywords: [markdown, hexo]
// ---\n

// 2. 解析后的元数据对象（使用 js-yaml 解析），失败或不存在时返回 null
const meta = context.getDocMeta();
// 典型结构：
// {
//   title: "This is the title",
//   keywords: ["markdown", "hexo"],
//   author: ["Author One", "Author Two"],
//   abstract: "This is the abstract."
// }

// 3. 正文部分（剥离 Front Matter 后的 Markdown）
const body = context.getDocBody();
// - 若存在 Front Matter：body 从第一行真实正文开始
// - 若不存在 Front Matter：等同于 context.getEditorValue()
```

**示例：从 Front Matter 读取标题和标签发布到博客**

```javascript
export function activate(context) {
  context.addMenuItem({
    label: '发布到博客',
    async onClick() {
      const meta = context.getDocMeta() || {};
      const body = context.getDocBody();

      const title = meta.title || guessTitleFromBody(body);
      const tags = meta.tags || meta.keywords || [];

      await publishToBlog({
        title,
        tags,
        content: body,
        excerpt: meta.abstract || ''
      });

      context.ui.notice('发布完成: ' + title, 'ok');
    }
  });
}

function guessTitleFromBody(body) {
  const m = body.match(/^#\s+(.+)$/m);
  return (m && m[1]) || '未命名文章';
}
```

### context.invoke

调用 Tauri 后端命令。

```javascript
// 调用后端命令
try {
  const result = await context.invoke('command_name', {
    param1: 'value1',
    param2: 'value2'
  });
  console.log('命令执行结果：', result);
} catch (error) {
  console.error('命令执行失败：', error);
}
```

### context.storage

插件专属的存储空间。

```javascript
// 保存数据
await context.storage.set('key', { name: 'value', count: 42 });

// 读取数据
const data = await context.storage.get('key');
console.log(data); // { name: 'value', count: 42 }

// 删除数据（设置为 null）
await context.storage.set('key', null);
```

### context.addMenuItem

在菜单栏添加自定义菜单项，支持简单菜单项和下拉菜单。

#### 简单菜单项

```javascript
const removeMenuItem = context.addMenuItem({
  label: '菜单文本',
  title: '鼠标悬停提示',
  onClick: () => {
    // 点击时执行的操作
    context.ui.notice('菜单被点击了！');
  }
});

// 移除菜单项（可选）
// removeMenuItem();
```

#### 下拉菜单

通过 `children` 参数可以创建下拉菜单：

```javascript
context.addMenuItem({
  label: '我的工具',
  title: '工具菜单',
  children: [
    {
      label: '选项 1',
      onClick: () => {
        context.ui.notice('选项 1 被点击');
      }
    },
    {
      label: '选项 2',
      onClick: () => {
        context.ui.notice('选项 2 被点击');
      }
    }
  ]
});
```

#### 带分组和分隔线的下拉菜单

```javascript
context.addMenuItem({
  label: '待办',
  children: [
    // 分组标题
    {
      type: 'group',
      label: '推送'
    },
    {
      label: '全部',
      note: '含已完成/未完成',  // 右侧注释
      onClick: () => pushAll()
    },
    {
      label: '已完成',
      onClick: () => pushDone()
    },
    {
      label: '未完成',
      onClick: () => pushTodo()
    },
    // 分隔线
    {
      type: 'divider'
    },
    {
      type: 'group',
      label: '提醒'
    },
    {
      label: '创建提醒',
      note: '@时间',
      onClick: () => createReminder()
    },
    // 禁用状态
    {
      label: '高级功能',
      disabled: true,
      note: '敬请期待'
    }
  ]
});
```

#### 菜单项配置说明

**普通菜单项：**
- `label`: 菜单文本（必填）
- `onClick`: 点击回调函数（必填）
- `note`: 右侧注释文本（可选）
- `disabled`: 是否禁用（可选，默认 `false`）

**分组标题：**
```javascript
{
  type: 'group',
  label: '分组名称'
}
```

**分隔线：**
```javascript
{
  type: 'divider'
}
```

**注意：**
- 每个插件只能添加一个菜单项
- 如果提供了 `children`，则不需要提供 `onClick`
- 下拉菜单会自动定位，避免超出视口边界
- 支持 ESC 键关闭下拉菜单
- 点击外部区域可关闭下拉菜单

### context.addContextMenuItem

在编辑器中注册右键菜单项，支持上下文感知和条件显示。

#### 基本用法

```javascript
// 注册一个简单的右键菜单项
const removeItem = context.addContextMenuItem({
  label: '转换为大写',
  icon: '🔤',
  condition: (ctx) => ctx.selectedText.length > 0,  // 仅在有选中文本时显示
  onClick: (ctx) => {
    const upperText = ctx.selectedText.toUpperCase();
    context.replaceRange(
      context.getSelection().start,
      context.getSelection().end,
      upperText
    );
    context.ui.notice('已转换为大写', 'ok');
  }
});

// 移除菜单项（可选）
// removeItem();
```

#### 带子菜单的右键菜单

```javascript
context.addContextMenuItem({
  label: '文本工具',
  icon: '🛠️',
  children: [
    {
      label: '转大写',
      onClick: (ctx) => {
        const upper = ctx.selectedText.toUpperCase();
        context.replaceRange(
          context.getSelection().start,
          context.getSelection().end,
          upper
        );
      }
    },
    {
      label: '转小写',
      onClick: (ctx) => {
        const lower = ctx.selectedText.toLowerCase();
        context.replaceRange(
          context.getSelection().start,
          context.getSelection().end,
          lower
        );
      }
    },
    { type: 'divider' },  // 分隔线
    {
      label: '去除空格',
      onClick: (ctx) => {
        const trimmed = ctx.selectedText.replace(/\s+/g, '');
        context.replaceRange(
          context.getSelection().start,
          context.getSelection().end,
          trimmed
        );
      }
    }
  ]
});
```

#### 完整配置示例

```javascript
context.addContextMenuItem({
  label: '高级编辑',
  icon: '✨',
  children: [
    // 分组标题
    {
      type: 'group',
      label: '格式转换'
    },
    {
      label: '驼峰命名',
      note: 'camelCase',
      condition: (ctx) => ctx.selectedText.length > 0,
      onClick: (ctx) => {
        const camelCase = ctx.selectedText
          .replace(/[-_\s]+(.)?/g, (_, c) => c ? c.toUpperCase() : '');
        context.replaceRange(
          context.getSelection().start,
          context.getSelection().end,
          camelCase
        );
      }
    },
    {
      label: '蛇形命名',
      note: 'snake_case',
      condition: (ctx) => ctx.selectedText.length > 0,
      onClick: (ctx) => {
        const snakeCase = ctx.selectedText
          .replace(/([A-Z])/g, '_$1')
          .replace(/[-\s]+/g, '_')
          .toLowerCase()
          .replace(/^_/, '');
        context.replaceRange(
          context.getSelection().start,
          context.getSelection().end,
          snakeCase
        );
      }
    },
    { type: 'divider' },
    {
      type: 'group',
      label: '插入'
    },
    {
      label: '插入时间戳',
      onClick: (ctx) => {
        const timestamp = new Date().toISOString();
        context.insertAtCursor(timestamp);
      }
    },
    // 禁用状态
    {
      label: 'AI 润色',
      disabled: true,
      note: '敬请期待'
    }
  ]
});
```

#### 上下文对象 (ContextMenuContext)

右键菜单的 `condition` 和 `onClick` 回调函数会接收一个上下文对象：

```javascript
{
  selectedText: string,        // 当前选中的文本
  cursorPosition: number,      // 光标位置
  mode: 'edit' | 'preview' | 'wysiwyg',  // 当前编辑模式
  filePath: string | null      // 当前文件路径
}
```

#### 配置参数说明

**普通菜单项：**
- `label`: 菜单文本（必填）
- `icon`: 图标，支持 emoji（可选）
- `onClick`: 点击回调函数，接收上下文对象（必填）
- `condition`: 显示条件函数，返回 `true` 时显示（可选）
- `note`: 右侧注释文本（可选）
- `disabled`: 是否禁用（可选，默认 `false`）

**带子菜单：**
- `label`: 菜单文本（必填）
- `icon`: 图标（可选）
- `children`: 子菜单项数组（必填）

**分组标题：**
```javascript
{
  type: 'group',
  label: '分组名称'
}
```

**分隔线：**
```javascript
{
  type: 'divider'
}
```

#### 注意事项

- 右键菜单会自动根据视口边界调整位置，防止溢出
- 子菜单智能定位：自动检测可用空间，向右或向左展开，确保始终可见
- 支持 ESC 键关闭菜单
- 点击外部区域可关闭菜单
- `condition` 函数用于动态控制菜单项的显示
- 每个扩展可以注册多个右键菜单项
- 右键菜单仅在有扩展注册时才会覆盖浏览器默认菜单
- **访问原生右键菜单**：按住 `Shift` 键再右键点击，可显示浏览器原生菜单
- 子菜单支持悬停展开，鼠标移动到带箭头的菜单项上即可展开子菜单

#### 实际应用示例

```javascript
// 代码格式化工具
export function activate(context) {
  context.addContextMenuItem({
    label: '格式化代码',
    icon: '🎨',
    condition: (ctx) => {
      // 仅在编辑模式且有选中文本时显示
      return ctx.mode === 'edit' && ctx.selectedText.length > 0;
    },
    onClick: (ctx) => {
      try {
        // 尝试格式化 JSON
        const formatted = JSON.stringify(JSON.parse(ctx.selectedText), null, 2);
        context.replaceRange(
          context.getSelection().start,
          context.getSelection().end,
          formatted
        );
        context.ui.notice('JSON 格式化成功', 'ok');
      } catch {
        context.ui.notice('格式化失败，请检查 JSON 语法', 'err');
      }
    }
  });
}
```

### context.ui.notice

显示通知消息。

```javascript
// 显示成功通知（默认）
context.ui.notice('操作成功！', 'ok', 2000);

// 显示错误通知
context.ui.notice('操作失败！', 'err', 3000);

// 参数说明：
// - message: 通知内容
// - level: 'ok' 或 'err'，默认 'ok'
// - ms: 显示时长（毫秒），默认 1600
```

### context.ui.confirm

显示确认对话框。

```javascript
const confirmed = await context.ui.confirm('确定要执行此操作吗？');
if (confirmed) {
  context.ui.notice('用户确认了操作');
} else {
  context.ui.notice('用户取消了操作');
}
```

### context.ui.showNotification (新增)

显示通知气泡（右下角），支持更丰富的选项。

```javascript
// 显示成功通知
const id = context.ui.showNotification('操作成功！', {
  type: 'success',  // 'success' | 'error' | 'info'
  duration: 2000    // 显示时长（毫秒），不设置则使用默认值
});

// 显示错误通知
context.ui.showNotification('操作失败！', {
  type: 'error',
  duration: 3000
});

// 显示信息通知
context.ui.showNotification('新版本可用', {
  type: 'info',
  duration: 5000
});

// 显示可点击的通知
context.ui.showNotification('发现 3 个待办事项，点击查看详情', {
  type: 'success',
  duration: 10000,
  onClick: () => {
    // 用户点击通知时执行
    console.log('用户点击了通知');
  }
});

// 手动控制通知显示时长
const notificationId = context.ui.showNotification('正在处理...', {
  type: 'info',
  duration: 0  // 0 表示不自动关闭
});

// 手动关闭通知
setTimeout(() => {
  context.ui.hideNotification(notificationId);
}, 5000);
```

**参数说明：**
- `message`（string，必需）：通知内容
- `options`（object，可选）：通知选项
  - `type`（string）：通知类型，可选值：
    - `'success'` - 成功通知（绿色，✔ 图标，默认 2秒）
    - `'error'` - 错误通知（红色，✖ 图标，默认 3秒）
    - `'info'` - 信息通知（蓝色，🔔 图标，默认 5秒）
  - `duration`（number）：显示时长（毫秒），设为 `0` 表示不自动关闭
  - `onClick`（function）：点击通知时的回调函数

**返回值：**
- 返回通知 ID（string），可用于手动关闭通知

**通知特性：**
- 显示在应用右下角
- 支持多条通知同时显示（自动向上堆叠）
- **最高层级显示**：z-index 为 999999，不会被任何弹窗遮挡或模糊
- 平滑的淡入淡出动画
- 点击通知可触发自定义操作

**与 `context.ui.notice` 的区别：**
- `notice`：简化版，仅支持成功/错误两种类型，显示在底部状态栏
- `showNotification`：完整版，支持三种类型、可点击、可手动关闭，显示为独立气泡

**示例：扩展使用通知系统**

```javascript
export function activate(context) {
  context.addMenuItem({
    label: '我的工具',
    children: [
      {
        label: '提取待办',
        onClick: async () => {
          try {
            const content = context.getEditorValue();
            const todos = content.match(/- \[ \]/g) || [];

            if (todos.length === 0) {
              // 使用新通知 API 显示信息
              context.ui.showNotification('当前文档没有任何待办（< [] 语法）', {
                type: 'info',
                duration: 3000
              });
            } else {
              // 显示可点击的通知
              context.ui.showNotification(`发现 ${todos.length} 个待办，点击查看`, {
                type: 'success',
                duration: 5000,
                onClick: () => {
                  console.log('待办列表：', todos);
                }
              });
            }
          } catch (error) {
            // 显示错误通知
            context.ui.showNotification('提取失败：' + error.message, {
              type: 'error',
              duration: 3000
            });
          }
        }
      }
    ]
  });
}
```

### context.ui.hideNotification (新增)

手动关闭指定的通知。

```javascript
// 显示持久通知
const id = context.ui.showNotification('正在上传文件...', {
  type: 'info',
  duration: 0  // 不自动关闭
});

// 上传完成后手动关闭
try {
  await uploadFile();
  context.ui.hideNotification(id);
  context.ui.showNotification('上传成功！', { type: 'success' });
} catch (error) {
  context.ui.hideNotification(id);
  context.ui.showNotification('上传失败', { type: 'error' });
}
```

**参数说明：**
- `id`（string，必需）：通知 ID，由 `showNotification` 返回

### context.layout.registerPanel (新增)

注册一个由宿主统一管理布局的插件 Panel，用于实现类似侧边栏 / 底部面板的效果（会**真实挤压**编辑区，而不是浮在上面）。目前主要用于 AI 助手，但任何插件都可以使用。

> 注意：这是高级 API，只有在 **确实需要占用大面积 UI** 时才使用。简单操作请继续用菜单或右键菜单。

```javascript
export function activate(context) {
  // 注册一个左侧 Panel，占用 320px 宽度
  const panel = context.layout.registerPanel('main', {
    side: 'left',      // 'left' | 'right' | 'bottom'
    size: 320,         // 像素值：宽度（左右）或高度（底部）
    visible: true      // 是否一开始就可见（默认 true）
  });

  // 根据状态动态调整
  someEventEmitter.on('collapse', () => {
    panel.setVisible(false);       // 隐藏 Panel，不再占用空间
  });

  someEventEmitter.on('expand', () => {
    panel.update({ visible: true, size: 420 }); // 显示并调整宽度
  });

  // 插件卸载前记得释放（通常在 deactivate 里）
  return () => {
    panel.dispose();
  };
}
```

**方法签名：**

```ts
const handle = context.layout.registerPanel(
  panelId: string,
  options: {
    side: 'left' | 'right' | 'bottom';
    size: number;        // 左/右：宽度；bottom：高度
    visible?: boolean;   // 默认 true
  }
);
```

**返回值：** `handle: PluginDockPanelHandle`

- `handle.setVisible(visible: boolean)`  
  显示 / 隐藏 Panel。隐藏时不再影响编辑区宽度/高度。

- `handle.setSide(side: 'left' | 'right' | 'bottom')`  
  动态切换 Panel 所在区域（例如从右侧切到底部）。

- `handle.setSize(size: number)`  
  更新 Panel 尺寸：
  - `side = 'left' | 'right'`：表示宽度（px）；
  - `side = 'bottom'`：表示高度（px）。

- `handle.update(options: { side?: ..., size?: ..., visible?: ... })`  
  一次更新多个属性，等价于依次调用上面几个方法。

- `handle.dispose()`  
  取消注册，彻底移除 Panel 对布局的影响。通常在 `deactivate()` 中调用。

**布局规则说明：**

- 所有插件 Panel（包括 AI 助手）会被宿主集中管理：
  - 左侧：所有 `side='left'` 的 Panel 的宽度相加，汇总到 `--dock-left-gap`；
  - 右侧：所有 `side='right'` 的宽度相加到 `--dock-right-gap`；
  - 底部：所有 `side='bottom'` 的高度相加到 `--dock-bottom-gap`；
  - 编辑区/预览区根据这三个值自动缩放，**不会被遮挡**。
- 文档库侧栏仍然受自己的设置控制，但在计算工作区宽度时会被一起考虑，
  对插件来说不需要手动处理库的宽度，只关心自己的 Panel 尺寸即可。

### context.getEditorValue

获取编辑器当前内容。

```javascript
const content = context.getEditorValue();
console.log('当前内容：', content);
console.log('字符数：', content.length);
```

### context.setEditorValue

设置编辑器内容。

```javascript
// 替换全部内容
context.setEditorValue('# 新内容\n\n这是新的内容');

// 追加内容
const current = context.getEditorValue();
context.setEditorValue(current + '\n\n附加的内容');
```

**注意：** 调用此方法会：
- 标记文档为未保存状态
- 更新标题栏和状态栏
- 如果在预览模式，会自动重新渲染预览

### context.getSelection

获取当前编辑器**源码视图**中的选区信息。

```javascript
const sel = context.getSelection();
console.log(sel.start, sel.end, sel.text);
// sel.text 即当前选中的原始 Markdown 片段
```

**返回值：**
- `start` / `end`：基于整篇 Markdown 源码的字符偏移（从 0 开始）
- `text`：`[start, end)` 区间内的源码字符串

### context.getSelectedMarkdown

返回当前选中文本对应的**原始 Markdown 源码字符串**。

```javascript
const md = context.getSelectedMarkdown();
if (md) {
  console.log('选中的 Markdown:', md);
}
```

**说明：**
- 当前实现等价于 `context.getSelection().text`
- 更语义化，后续版本可以在所见模式下提供更精确的映射
- 当没有选区时返回空字符串

### context.getSourceText

返回当前文档的完整 Markdown 源码。

```javascript
const fullSource = context.getSourceText();
// 可配合 context.getSelection() 或 context.getLineText() 使用
```

**说明：**
- 当前实现等价于 `context.getEditorValue()`
- 适合插件需要按行号或位置自行解析整篇文档的场景

### context.getLineText

按行号获取指定行的 Markdown 源码文本。

```javascript
const firstLine = context.getLineText(1);
```

**参数：**
- `lineNumber`：行号，从 **1** 开始；越界时返回空字符串

### context.pickDocFiles

在桌面版中弹出文件选择对话框，选择一个或多个 Markdown 文档（`md / markdown / txt`），返回绝对路径数组。

```javascript
// 选择多个文档
const files = await context.pickDocFiles({ multiple: true });

if (!files || files.length === 0) {
  context.ui.notice('未选择任何文档', 'err');
} else {
  context.ui.notice('已选择 ' + files.length + ' 个文档', 'ok');
}
```

**注意：**
- 仅在桌面版（Tauri 应用）可用，浏览器环境会返回空数组并弹出提示。
- 返回值为字符串数组，每一项是文件的绝对路径。

### context.openFileByPath

按给定绝对路径打开本地文档，相当于用户在界面中打开该文件。

```javascript
// 打开单个文档
await context.openFileByPath('C:/docs/note.md');

// 打开后可以继续读取内容
const content = context.getEditorValue();
context.ui.notice('已打开文档，长度：' + content.length, 'ok');
```

**注意：**
- 仅支持当前 flyMD 支持的文档类型（`md / markdown / txt / pdf`）。
- 同样走应用内部的打开流程，会更新当前文档路径、最近文件等状态。

### context.createStickyNote

创建便签窗口：在新实例中以便签模式打开指定文件，自动进入专注模式+阅读模式+关闭库侧栏，并显示便签控制按钮（锁定拖动/窗口置顶）。

```javascript
// 将当前文档作为便签打开
const currentFile = 'C:/notes/todo.md';
await context.createStickyNote(currentFile);
context.ui.notice('便签已创建', 'ok');

// 或者从插件菜单中触发
context.addMenuItem({
  label: '快速便签',
  children: [
    {
      label: '创建待办便签',
      onClick: async () => {
        const todoFile = await context.storage.get('todoFilePath');
        if (todoFile) {
          await context.createStickyNote(todoFile);
        } else {
          context.ui.notice('请先设置待办文件路径', 'err');
        }
      }
    }
  ]
});
```

**功能说明：**
- 便签窗口会自动缩小到 400×300 像素并移动到屏幕右上角
- 自动进入专注模式（隐藏原生标题栏）
- 自动切换到阅读模式
- 自动关闭库侧栏
- 显示两个控制按钮（仅便签模式可见）：
  - **图钉按钮**：锁定窗口位置（禁止拖动）
  - **置顶按钮**：窗口始终在最上层

**参数说明：**
- `filePath`（string，必需）：要在便签模式打开的文件绝对路径

**注意事项：**
- 文件必须已保存到磁盘（有绝对路径）
- 仅支持文本类型文件（`.md`、`.markdown`、`.txt`）
- 便签窗口仍可切换回编辑模式，用户保留完整编辑能力
- 便签模式不影响主窗口，两者可同时运行

**实战示例：快速待办便签**

```javascript
export function activate(context) {
  let quickNoteFiles = [];

  context.addMenuItem({
    label: '便签工具',
    children: [
      {
        label: '添加快捷便签',
        onClick: async () => {
          const files = await context.pickDocFiles({ multiple: true });
          if (files && files.length > 0) {
            quickNoteFiles = [...quickNoteFiles, ...files];
            await context.storage.set('quickNotes', quickNoteFiles);
            context.ui.notice(`已添加 ${files.length} 个便签`, 'ok');
          }
        }
      },
      { type: 'divider' },
      {
        type: 'group',
        label: '快捷便签'
      },
      ...quickNoteFiles.map(file => ({
        label: file.split(/[/\\]/).pop(),
        note: '📌',
        onClick: async () => {
          await context.createStickyNote(file);
        }
      }))
    ]
  });

  // 启动时加载保存的快捷便签列表
  context.storage.get('quickNotes').then(saved => {
    if (saved) quickNoteFiles = saved;
  });
}
```

### context.exportCurrentToPdf

将当前文档导出为 PDF 文件，目标路径由插件指定。

```javascript
// 将当前文档导出到指定路径
await context.exportCurrentToPdf('C:/docs/note.pdf');
context.ui.notice('PDF 导出完成', 'ok');
```

**注意：**
- 仅在桌面版（Tauri 应用）可用，依赖内置的 PDF 导出能力。
- `target` 应为完整文件路径（包含 `.pdf` 扩展名），若路径无效会抛出错误。
- 插件无需关心渲染细节，导出内容与应用中"另存为 PDF"的效果一致。

### context.registerAPI

注册插件 API，允许其他插件调用。用于将当前插件作为"基础设施插件"对外提供服务。

```javascript
export function activate(context) {
  // 注册工具函数 API
  context.registerAPI('my-utils', {
    // 导出工具函数
    formatDate: (date) => {
      return date.toISOString().split('T')[0];
    },

    chunk: (array, size) => {
      const chunks = [];
      for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
      }
      return chunks;
    },

    debounce: (fn, delay) => {
      let timer;
      return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
      };
    }
  });

  context.ui.notice('工具库 API 已注册', 'ok');
}
```

**参数说明：**
- `namespace`（string）：API 命名空间，必须唯一。建议使用插件 ID 或描述性名称
- `api`（any）：要导出的 API 对象，可以是函数、对象、类等任何 JavaScript 值

**注意事项：**
- 命名空间必须唯一，如果已被其他插件占用，注册会失败并在控制台输出警告
- 插件卸载时，已注册的 API 会自动清理
- 建议在 `activate` 函数中注册 API，确保插件启用时 API 可用

### context.getPluginAPI

获取其他插件注册的 API。

```javascript
export function activate(context) {
  // 尝试获取工具库 API
  const utils = context.getPluginAPI('my-utils');

  if (!utils) {
    context.ui.notice('需要先安装 my-utils 插件', 'err');
    return;
  }

  // 使用其他插件提供的 API
  const today = utils.formatDate(new Date());
  context.ui.notice('今天是：' + today, 'ok');

  // 使用 chunk 函数
  const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const chunks = utils.chunk(numbers, 3);
  console.log('分块结果：', chunks); // [[1,2,3], [4,5,6], [7,8,9]]
}
```

**参数说明：**
- `namespace`（string）：要获取的 API 命名空间

**返回值：**
- 如果 API 存在，返回对应的 API 对象
- 如果 API 不存在，返回 `null`

**最佳实践：**
- 使用前检查 API 是否存在（返回值是否为 `null`）
- 如果依赖其他插件，可以在 `manifest.json` 中说明依赖关系
- 建议为基础设施插件提供完整的文档说明

### context.getPreviewElement

获取当前预览区域的 DOM 元素，用于导出、截图等高级功能。

```javascript
// 获取预览 DOM 元素
const previewEl = context.getPreviewElement();

if (previewEl) {
  console.log('预览内容 HTML:', previewEl.innerHTML);
  console.log('预览内容长度:', previewEl.innerText.length);

  // 可以遍历预览中的元素（如 Mermaid 图表、KaTeX 公式等）
  const svgList = previewEl.querySelectorAll('svg');
  console.log('SVG 元素数量:', svgList.length);
} else {
  context.ui.notice('请先切换到阅读模式', 'err');
}
```

**返回值：**
- 成功时返回 `HTMLElement`（`.preview-body` 元素）
- 失败或预览未渲染时返回 `null`

**注意：**
- 返回的是只读引用，建议克隆后再修改：`previewEl.cloneNode(true)`
- 预览内容包含已渲染的 Mermaid 图表、KaTeX 公式、代码高亮等
- 适用于导出 PPT、截图、内容分析等场景

### context.saveFileWithDialog

弹出系统保存对话框，让用户选择保存路径，并将二进制数据写入文件。

```javascript
// 保存二进制文件示例
const pptxBytes = new Uint8Array([...]); // 你的 PPTX 数据

try {
  const savedPath = await context.saveFileWithDialog({
    filters: [
      { name: 'PowerPoint', extensions: ['pptx'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    defaultName: '演示文稿.pptx',
    data: pptxBytes
  });

  if (savedPath) {
    context.ui.notice('文件已保存到: ' + savedPath, 'ok');
  } else {
    context.ui.notice('用户取消保存', 'ok');
  }
} catch (error) {
  context.ui.notice('保存失败: ' + error.message, 'err');
}
```

**参数说明：**
- `filters`（可选）：文件类型过滤器数组，每项包含 `name`（显示名称）和 `extensions`（扩展名数组）
- `defaultName`（可选）：默认文件名
- `data`（必需）：要保存的二进制数据（`Uint8Array`）

**返回值：**
- 保存成功时返回文件路径（`string`）
- 用户取消时返回 `null`

**注意：**
- 仅在桌面版（Tauri 应用）可用，浏览器环境会抛出错误
- 会弹出系统原生的保存对话框
- 可用于导出 PPT、图片、压缩包等任意二进制文件

### 插件联动实战示例

#### 场景：基础工具库 + 数据处理插件

**1. 基础工具库插件（lodash-lite）**

```json
// lodash-lite/manifest.json
{
  "id": "lodash-lite",
  "name": "Lodash 工具库（轻量版）",
  "version": "1.0.0",
  "description": "为其他插件提供常用工具函数",
  "main": "main.js"
}
```

```javascript
// lodash-lite/main.js
export function activate(context) {
  // 注册工具函数 API
  context.registerAPI('lodash', {
    // 数组处理
    chunk: (arr, size) => {
      const result = [];
      for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size));
      }
      return result;
    },

    uniq: (arr) => [...new Set(arr)],

    flatten: (arr) => arr.flat(),

    // 对象处理
    pick: (obj, keys) => {
      const result = {};
      keys.forEach(key => {
        if (key in obj) result[key] = obj[key];
      });
      return result;
    },

    // 字符串处理
    capitalize: (str) => str.charAt(0).toUpperCase() + str.slice(1).toLowerCase(),

    camelCase: (str) => {
      return str.replace(/[-_\s]+(.)?/g, (_, c) => c ? c.toUpperCase() : '');
    },

    // 函数工具
    debounce: (fn, delay) => {
      let timer;
      return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
      };
    }
  });

  context.ui.notice('Lodash 工具库已加载', 'ok', 1500);
}
```

**2. 数据处理插件（使用工具库）**

```json
// markdown-processor/manifest.json
{
  "id": "markdown-processor",
  "name": "Markdown 批处理工具",
  "version": "1.0.0",
  "description": "批量处理 Markdown 文件（依赖 lodash-lite）",
  "main": "main.js"
}
```

```javascript
// markdown-processor/main.js
export function activate(context) {
  // 获取工具库 API
  const _ = context.getPluginAPI('lodash');

  if (!_) {
    context.ui.notice('需要先安装 lodash-lite 插件', 'err', 3000);
    return;
  }

  // 添加菜单项
context.addMenuItem({
  label: '批处理',
  children: [
    {
      label: '提取所有标题',
        onClick: async () => {
          const content = context.getEditorValue();
          const lines = content.split('\n');

          // 提取标题行
          const headers = lines.filter(line => line.trim().startsWith('#'));

          // 去重（使用 lodash API）
          const uniqueHeaders = _.uniq(headers);

          context.ui.notice(`找到 ${uniqueHeaders.length} 个唯一标题`, 'ok');
          console.log('标题列表：', uniqueHeaders);
        }
      },
      {
        label: '格式化链接',
        onClick: () => {
          const content = context.getEditorValue();
          const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;

          let links = [];
          let match;
          while ((match = linkRegex.exec(content)) !== null) {
            links.push({ text: match[1], url: match[2] });
          }

          // 去重（使用 lodash API）
          const uniqueLinks = _.uniq(links.map(l => l.url));

          context.ui.notice(`文档包含 ${uniqueLinks.length} 个不同链接`, 'ok');
        }
      }
    ]
  });

  context.ui.notice('Markdown 批处理工具已加载', 'ok', 1500);
}
```

**工作流程：**

1. 用户先安装 `lodash-lite` 基础工具库插件
2. `lodash-lite` 激活时通过 `registerAPI('lodash', ...)` 注册工具函数
3. 用户安装并启用 `markdown-processor` 插件
4. `markdown-processor` 通过 `getPluginAPI('lodash')` 获取工具函数
5. 如果工具库不存在，提示用户安装；否则正常使用工具函数

**优势：**
- 基础功能复用，避免重复实现
- 插件体积更小，只需实现业务逻辑
- 生态建设：基础设施插件 + 业务插件分层架构

### AI 助手共享 API（`ai-assistant`）

AI 助手插件从 `0.1.8` 起会通过 `context.registerAPI('ai-assistant', {...})` 暴露自身的 AI 调用能力，其他插件可以像复用基础设施一样直接调用，避免重复保存 API Key。所有方法都返回 `Promise`。

| 方法 | 功能描述 |
| --- | --- |
| `callAI(prompt, options?)` | 通用对话接口，`options.system` 可覆写系统提示词，`options.messages` 可传入完整消息数组 |
| `translate(text)` | 返回翻译后的纯文本，自动遵循 AI 助手中的“免费翻译”设置 |
| `quickAction(content, action)` | 复用续写/润色/纠错/提纲等快捷动作，`action` 取值同内置功能 |
| `generateTodos(content)` | 根据文档生成待办，返回 `{ raw, todos }`，其中 `todos` 为 `- [ ]` 列表数组 |
| `isConfigured()` | 判断当前 AI 是否可用（有 Key 或处于免费模式） |
| `getConfig()` | 获取 AI 助手的配置快照（浅拷贝），可用于自定义 UI 提示 |

**实战示例：**

```javascript
// 依赖 AI 助手插件完成续写
export async function activate(context) {
  const ai = context.getPluginAPI('ai-assistant');

  if (!ai) {
    context.ui.notice('需要先安装并启用 AI 助手插件', 'err');
    return;
  }

  context.addMenuItem({
    label: '我的 AI 功能',
    onClick: async () => {
      try {
        const ready = await ai.isConfigured();
        if (!ready) {
          context.ui.notice('请先在 AI 助手里配置 API Key 或切换免费模式', 'err');
          return;
        }

        const current = context.getEditorValue();
        const result = await ai.quickAction(current, '续写');

        context.setEditorValue(current + '\n\n' + result);
        context.ui.notice('续写完成', 'ok');
      } catch (error) {
        context.ui.notice('AI 调用失败：' + error.message, 'err');
      }
    }
  });
}
```

**提示：**

- 如果插件严格依赖 AI 助手，可在 README/manifest 中写明最低版本要求
- `generateTodos` 返回的 `todos` 数组已经过滤出合法的 `- [ ]` 行，可直接写回文档或交给其他插件消费
- 不要直接修改 `getConfig()` 的返回结果，它只是快照，如需更新配置应引导用户到 AI 助手设置界面

## 主题扩展（Theme）

flyMD 内置了主题系统，并对外暴露了可选的 Theme 扩展 API，便于插件对“颜色调色板、排版风格、Markdown 渲染风格”进行扩展或覆写。

### 能力概览

- 颜色调色板：在主题面板中追加可选颜色（用于编辑/阅读/所见三种背景）
- 排版风格：为现有排版风格覆写 CSS（字体/字号/行距等）
- Markdown 风格：为现有风格覆写 CSS（标题、引用、代码块、表格等）
- 主题偏好：读取/保存/应用当前主题设置
- 主题事件：监听主题变更，联动插件 UI

注意：当前版本 ID 列表为固定集合，注册不存在的 ID 将被忽略。

- Typography ID（排版风格）：`default | serif | modern | reading | academic`
- Markdown Style ID（MD 风格）：`standard | github | notion | journal | card | docs`

### 全局对象与 API

在渲染进程中可直接访问全局对象：`window.flymdTheme`

```ts
interface ThemePrefs {
  editBg: string       // 编辑背景
  readBg: string       // 阅读背景
  wysiwygBg: string    // 所见背景
  typography: 'default' | 'serif' | 'modern' | 'reading' | 'academic'
  mdStyle:   'standard' | 'github' | 'notion' | 'journal' | 'card' | 'docs'
}

// 扩展入口
flymdTheme.registerPalette(label: string, color: string, id?: string): void
flymdTheme.registerTypography(id: ThemePrefs['typography'], label: string, css?: string): void
flymdTheme.registerMdStyle(id: ThemePrefs['mdStyle'], label: string, css?: string): void

// 主题状态
flymdTheme.applyThemePrefs(prefs: ThemePrefs): void
flymdTheme.saveThemePrefs(prefs: ThemePrefs): void
flymdTheme.loadThemePrefs(): ThemePrefs

// 主题变更事件（插件可监听联动）
window.addEventListener('flymd:theme:changed', (e) => {
  const prefs = (e.detail || {}).prefs
  console.log('Theme changed:', prefs)
})
```

### 使用示例：增加调色板 + 调整 Docs 风格代码高亮

```js
// main.js（插件）
export function activate(context) {
  // 1) 增加两种可选颜色到主题面板
  flymdTheme.registerPalette('薰衣草', '#ede9fe')
  flymdTheme.registerPalette('薄荷绿', '#e8fff4')

  // 2) 为 Docs 风格追加/覆写一段 CSS（仅在 md-docs 生效）
  flymdTheme.registerMdStyle('docs', 'Docs', `
    .container.md-docs { --c-key:#1f4eff; --c-str:#0ea5e9; --c-num:#d97706; --c-fn:#7c3aed; --c-com:#94a3b8; }
    @media (prefers-color-scheme: dark) {
      .container.md-docs { --c-key:#93c5fd; --c-str:#67e8f9; --c-num:#fdba74; --c-fn:#c4b5fd; --c-com:#9ca3af; }
    }
  `)

  // 3) 快速应用某一主题偏好（示例：将阅读背景切到薰衣草）
  const prefs = flymdTheme.loadThemePrefs()
  prefs.readBg = '#ede9fe'
  flymdTheme.saveThemePrefs(prefs)
  flymdTheme.applyThemePrefs(prefs)

  context.ui.notice('主题扩展已加载', 'ok')
}
```

### 使用示例：调整排版风格（阅读）

```js
export function activate() {
  // 为“阅读”排版风格追加更大行距（不会影响其它风格）
  flymdTheme.registerTypography('reading', '阅读', `
    .container.typo-reading .preview-body,
    .container.typo-reading.wysiwyg-v2 .ProseMirror { line-height: 2.0; font-size: 18px; }
  `)
}
```

### 可用 CSS 变量（主题相关）

- 布局基色
  - `--bg` 编辑背景（应用于 `.container` 作用域）
  - `--preview-bg` 阅读背景（`.container:not(.wysiwyg):not(.wysiwyg-v2) .preview`）
  - `--wysiwyg-bg` 所见背景（`.container.wysiwyg-v2`）
- 代码配色（高亮 token）
  - `--code-bg`、`--code-border`、`--code-fg`
  - `--c-key`、`--c-str`、`--c-num`、`--c-fn`、`--c-com`
- 代码块装饰
  - `--code-pre-pad-y` 代码块基础上下内边距（结合语言角标让位）
  - `--code-lang-gap` 语言角标让位额外高度（定义在 `.codebox`）

### 注意事项与最佳实践

- 避免直接覆盖 `.codebox pre` 的 `padding-top`，统一通过 `--code-pre-pad-y + --code-lang-gap` 让位，防止语言角标与首行重叠。
- Typography/MdStyle 的 `id` 目前为固定集合；可通过传入 `css` 来细化、覆写现有风格。
- 使用 `applyThemePrefs` 修改主题只影响当前会话；配合 `saveThemePrefs` 可持久化到下一次启动。
- 监听 `flymd:theme:changed` 事件可实现插件 UI 与主题的联动更新。

## 生命周期

### activate(context)

插件激活时调用（必需）。

```javascript
export function activate(context) {
  console.log('插件已激活');

  // 初始化插件
  context.addMenuItem({
    label: '我的功能',
    onClick: async () => {
      // 功能实现
    }
  });
}
```

### deactivate()

插件停用时调用（可选）。

```javascript
export function deactivate() {
  console.log('插件已停用');
  // 清理资源
}
```

### openSettings(context)

打开插件设置界面（可选）。

```javascript
export function openSettings(context) {
  // 从存储中读取配置
  const loadConfig = async () => {
    const apiKey = await context.storage.get('apiKey') || '';
    const apiUrl = await context.storage.get('apiUrl') || '';
    return { apiKey, apiUrl };
  };

  // 保存配置
  const saveConfig = async (config) => {
    await context.storage.set('apiKey', config.apiKey);
    await context.storage.set('apiUrl', config.apiUrl);
    context.ui.notice('配置已保存', 'ok');
  };

  // 创建设置界面（示例：使用 prompt）
  const showSettings = async () => {
    const config = await loadConfig();
    const apiKey = prompt('请输入 API Key:', config.apiKey);
    if (apiKey !== null) {
      const apiUrl = prompt('请输入 API URL:', config.apiUrl);
      if (apiUrl !== null) {
        await saveConfig({ apiKey, apiUrl });
      }
    }
  };

  showSettings();
}
```

## 示例插件

### 1. 字数统计插件

```javascript
// main.js
export function activate(context) {
  context.addMenuItem({
    label: '字数统计',
    title: '统计当前文档的字符数、词数和行数',
    onClick: () => {
      const content = context.getEditorValue();
      const chars = content.length;
      const words = content.split(/\s+/).filter(w => w.length > 0).length;
      const lines = content.split('\n').length;

      context.ui.notice(
        `字符数: ${chars} | 词数: ${words} | 行数: ${lines}`,
        'ok',
        3000
      );
    }
  });
}
```

```json
// manifest.json
{
  "id": "word-count",
  "name": "字数统计",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "统计 Markdown 文档的字符数、词数和行数",
  "main": "main.js"
}
```

### 2. 文本转换插件

```javascript
// main.js
export function activate(context) {
  context.addMenuItem({
    label: '大写转换',
    title: '将选中文本转换为大写',
    onClick: async () => {
      const content = context.getEditorValue();
      const confirmed = await context.ui.confirm('确定将所有文本转换为大写吗？');

      if (confirmed) {
        const upperCase = content.toUpperCase();
        context.setEditorValue(upperCase);
        context.ui.notice('转换完成！', 'ok');
      }
    }
  });
}
```

### 3. HTTP 请求插件

```javascript
// main.js
export function activate(context) {
  context.addMenuItem({
    label: '获取 IP',
    title: '获取当前公网 IP 地址',
    onClick: async () => {
      try {
        const response = await context.http.fetch('https://api.ipify.org?format=json', {
          method: 'GET'
        });

        const data = await response.json();
        context.ui.notice(`您的 IP 地址是: ${data.ip}`, 'ok', 3000);
      } catch (error) {
        context.ui.notice('获取 IP 失败: ' + error.message, 'err', 3000);
      }
    }
  });
}
```

### 4. 配置存储插件

```javascript
// main.js
export function activate(context) {
  context.addMenuItem({
    label: '我的工具',
    onClick: async () => {
      // 读取配置
      const prefix = await context.storage.get('prefix') || '>> ';

      // 使用配置
      const content = context.getEditorValue();
      const lines = content.split('\n');
      const prefixed = lines.map(line => prefix + line).join('\n');

      context.setEditorValue(prefixed);
      context.ui.notice('已添加前缀', 'ok');
    }
  });
}

export function openSettings(context) {
  (async () => {
    const currentPrefix = await context.storage.get('prefix') || '>> ';
    const newPrefix = prompt('设置行前缀:', currentPrefix);

    if (newPrefix !== null) {
      await context.storage.set('prefix', newPrefix);
      context.ui.notice('设置已保存', 'ok');
    }
  })();
}
```

## 发布插件

### 方式一：GitHub 发布（推荐）

1. **创建 GitHub 仓库**

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/username/my-plugin.git
   git push -u origin main
   ```

2. **文件结构**

   确保仓库根目录包含：
   - `manifest.json`
   - `main.js`
   - `README.md`（推荐）

3. **安装方式**

   用户可通过以下格式安装：
   ```
   username/my-plugin
   username/my-plugin@main
   username/my-plugin@develop
   ```

### 方式二：HTTP 发布

1. **部署文件**

   将插件文件部署到 Web 服务器：
   ```
   https://example.com/plugins/my-plugin/
   ├── manifest.json
   └── main.js
   ```

2. **确保 CORS**

   服务器需要允许跨域访问：
   ```
   Access-Control-Allow-Origin: *
   ```

3. **安装方式**

   用户通过完整 URL 安装：
   ```
   https://example.com/plugins/my-plugin/manifest.json
   ```
   
## 提交插件/扩展到应用内市场

将插件/扩展地址及说明发送到fly@llingfei.com或issue


## 最佳实践

### 1. 错误处理

始终使用 try-catch 处理可能的错误：

```javascript
export function activate(context) {
  context.addMenuItem({
    label: '我的功能',
    onClick: async () => {
      try {
        // 可能出错的操作
        const data = await context.http.fetch('https://api.example.com');
        // 处理数据
      } catch (error) {
        context.ui.notice('操作失败: ' + error.message, 'err', 3000);
        console.error('详细错误:', error);
      }
    }
  });
}
```

### 2. 用户反馈

及时给用户反馈操作状态：

```javascript
export function activate(context) {
  context.addMenuItem({
    label: '上传',
    onClick: async () => {
      context.ui.notice('正在上传...', 'ok', 999999); // 长时间显示

      try {
        await uploadFunction();
        context.ui.notice('上传成功！', 'ok', 2000);
      } catch (error) {
        context.ui.notice('上传失败', 'err', 3000);
      }
    }
  });
}
```

### 3. 数据验证

在操作前验证数据的有效性：

```javascript
export function activate(context) {
  context.addMenuItem({
    label: '处理',
    onClick: async () => {
      const content = context.getEditorValue();

      if (!content || content.trim().length === 0) {
        context.ui.notice('编辑器内容为空', 'err');
        return;
      }

      // 继续处理...
    }
  });
}
```

### 4. 配置管理

为插件提供合理的默认配置：

```javascript
async function getConfig(context) {
  return {
    apiKey: await context.storage.get('apiKey') || '',
    timeout: await context.storage.get('timeout') || 5000,
    enabled: await context.storage.get('enabled') ?? true
  };
}
```

### 5. 兼容性

考虑不同环境的兼容性：

```javascript
export function activate(context) {
  // 检查必需的 API 是否可用
  if (!context.http) {
    context.ui.notice('HTTP 功能不可用', 'err');
    return;
  }

  // 继续初始化...
}
```

### 6. 作用域与隔离

理解插件变量的作用域，避免命名冲突：

#### 已隔离的部分

**存储空间（完全隔离）**

每个插件的 `context.storage` 是完全独立的，不会与其他插件冲突：

```javascript
// plugin-a
export function activate(context) {
  await context.storage.set('count', 1);  // ✅ 独立存储
}

// plugin-b
export function activate(context) {
  await context.storage.set('count', 2);  // ✅ 独立存储，不会覆盖 plugin-a
}
```

**模块级变量（局部作用域）**

模块内的变量默认是局部的，不会冲突：

```javascript
// plugin-a/main.js
const privateData = { count: 1 };  // ✅ 局部变量

export function activate(context) {
  console.log(privateData.count);  // ✅ 可以访问
}
// 其他插件无法访问 privateData
```

#### 可能冲突的部分

**全局对象 window（共享）**

如果直接在 `window` 上挂载变量，可能与其他插件冲突：

```javascript
// ❌ 不推荐：污染全局命名空间
export function activate(context) {
  window.myData = { count: 1 };  // 可能与其他插件冲突
}

// ✅ 推荐：使用命名空间
export function activate(context) {
  window.__pluginData__ = window.__pluginData__ || {};
  window.__pluginData__['my-plugin-id'] = { count: 1 };
}

// ✅ 最佳：优先使用模块作用域或 context.storage
const myData = { count: 1 };  // 模块变量
// 或
await context.storage.set('myData', { count: 1 });  // 持久化存储
```

**DOM 元素 ID（共享）**

避免使用简单的 ID 名称：

```javascript
// ❌ 不推荐：可能与其他插件冲突
const panel = document.createElement('div');
panel.id = 'panel';

// ✅ 推荐：使用唯一 ID
const panel = document.createElement('div');
panel.id = 'my-plugin-panel-' + Math.random().toString(36).slice(2);
```

#### 最佳实践总结

1. **优先使用 `context.storage`** - 持久化存储且自动隔离
2. **使用模块作用域** - `const/let` 变量默认局部
3. **避免污染全局** - 不要直接在 `window` 上挂载变量
4. **使用唯一 ID** - DOM 元素 ID 添加插件前缀或随机字符串
5. **通过 API 共享** - 使用 `context.registerAPI()` 安全地共享功能

```javascript
// ✅ 完整示例：良好的隔离实践
const pluginState = {
  count: 0,
  data: []
};

export async function activate(context) {
  // 从持久化存储加载
  const savedCount = await context.storage.get('count') || 0;
  pluginState.count = savedCount;

  // 创建唯一 DOM 元素
  const panel = document.createElement('div');
  panel.id = `my-plugin-panel-${Date.now()}`;
  panel.className = 'my-plugin-panel';

  // 注册 API 供其他插件使用
  context.registerAPI('my-plugin', {
    getCount: () => pluginState.count,
    increment: () => {
      pluginState.count++;
      context.storage.set('count', pluginState.count);
    }
  });
}
```

## 常见问题

### Q: 如何调试插件？

A: 使用 `console.log` 输出调试信息，在 flyMD 中按 `F12` 或 `Ctrl+Shift+I` 打开开发者工具查看。

```javascript
export function activate(context) {
  console.log('插件激活', context);

  context.addMenuItem({
    label: '调试',
    onClick: () => {
      console.log('当前内容:', context.getEditorValue());
    }
  });
}
```

### Q: 插件可以访问文件系统吗？

A: 可以通过 `context.invoke` 调用 Tauri 后端命令来访问文件系统。

### Q: 如何更新已安装的插件？

A: 目前需要先移除旧版本，再重新安装新版本。

### Q: 插件的存储空间有限制吗？

A: 没有硬性限制，但建议只存储必要的配置数据，避免存储大量数据。

### Q: 可以创建多个菜单项吗？

A: 每个插件只能添加一个主菜单项，但可以在菜单项的点击事件中弹出子菜单。

## 参考资源

- [Typecho Publisher 插件](https://github.com/TGU-HansJack/typecho-publisher-flymd) - 官方示例插件
- [flyMD GitHub 仓库](https://github.com/flyhunterl/flymd)
- [Tauri 文档](https://tauri.app/)

## 许可证

本文档遵循与项目一致的许可：飞速MarkDown（flyMD）非商业开源许可协议（NC 1.0），详见 [LICENSE](LICENSE)。

---

如有问题或建议，欢迎提交 [Issue](https://github.com/flyhunterl/flymd/issues)。
