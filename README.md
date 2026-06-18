# MCP Inspector Bridge

> Cursor-first 的 Cocos Creator 运行时审查桥接方案。

这个仓库的目标已经从“Creator 面板优先”调整为：

- **Cursor / VS Code 是主入口**
- **Cocos Creator 只负责后台 bridge 和运行时预览**
- **预览默认显示在编辑器里，而不是 Chrome 或 Creator 新窗口**
- **按 `F5` 可以直接启动当前工作区对应项目的预览**

---

## 适合什么场景

如果你希望：

- 不打开 Chrome 预览
- 不让 Cocos Creator 再弹一个独立预览窗口
- 在 Cursor 里直接看节点树、属性、日志、性能
- 通过 `F5` 启动当前项目预览
- 用 MCP 把运行时能力接到 AI / Cursor

那么这个项目就是为这个工作流设计的。

---

## Cursor-first 工作流

### 1. 打开 Cocos 项目
在 Cursor 中打开你的 Cocos Creator 项目工作区。

### 2. 安装扩展
安装 `vscode-extension` 打包出的 VSIX 到 Cursor。

### 3. 连接 Bridge
扩展会自动扫描运行中的 Cocos Creator 实例，也可以手动点击状态栏选择实例。

### 4. 按 `F5` 启动预览
在 Cocos 工作区中，`F5` 会被接管为：

- 触发 Creator 预览
- 等待预览服务就绪
- 在 Cursor / VS Code 内打开预览

### 5. 使用侧栏审查
侧栏可查看：

- 节点树
- 属性
- 性能
- 内存
- 引擎控制
- 渲染调试
- 脚本

---

## 目录结构

```text
mcp-inspector-bridge/
├── src/                     # Cocos Creator 侧后台 bridge / probe / IPC
├── vscode-extension/        # Cursor / VS Code 主插件
├── dist/                    # 构建产物
└── specs/                   # 相关规范与说明
```

---

## 工作流概览

### 1. Cocos Creator 侧
Creator 插件负责：

- 启动 WebSocket bridge
- 扫描运行中的项目实例
- 触发预览启动
- 提供节点树、属性、日志、性能等运行时数据
- 注入 probe 到预览页面

### 2. Cursor / VS Code 侧
扩展负责：

- 自动连接 bridge
- 在侧栏显示节点树和属性
- 在编辑器中打开预览
- 通过 `F5` 启动预览
- 管理多实例连接
- 配置 Cursor MCP

---

## 安装与构建

### 安装依赖

```bat
npm install
```

### 构建主插件

```bat
npm run build
```

### 构建主插件 + VS Code 扩展

```bat
npm run build:all
```

### Windows 一键构建

仓库根目录提供了几个常用脚本：

```bat
clean-win.bat
build-win.bat
build-all-win.bat
package-vsix-win.bat
```

建议流程：

1. 先运行 `build-all-win.bat`
2. 再运行 `package-vsix-win.bat`
3. 在 Cursor 中通过“从 VSIX 安装”安装扩展

---

## 主要命令

在命令面板里可以使用：

- `Cocos Inspector: 选择 Bridge 实例`
- `Cocos Inspector: 连接 Bridge`
- `Cocos Inspector: 启动预览 (F5)`
- `Cocos Inspector: 在编辑器打开预览`
- `Cocos Inspector: 打开预览页 / DevTools`
- `Cocos Inspector: 配置 Cursor MCP`

---

## 关键设置

| 设置项 | 说明 |
|--------|------|
| `cocosInspector.bridgePort` | 手动指定 Bridge 端口，`0` 表示自动扫描 |
| `cocosInspector.previewInEditor` | 是否把预览显示在编辑器区域，默认 `true` |
| `cocosInspector.previewMode` | 预览打开方式：`simpleBrowser` 或 `webview` |
| `cocosInspector.bindPreviewToF5` | 是否在 Cocos 工作区把 `F5` 绑定为预览启动，默认 `true` |
| `cocosInspector.useProbeProxy` | 仅侧栏内嵌预览时有效，编辑器预览仍直连 Creator 端口 |

---

## 已知限制

当前方案的边界是：

- 预览运行时仍然依赖 Cocos Creator 的预览能力
- 不是完全脱离 Creator 的纯前端方案
- 某些深度运行时能力仍需要 Creator 侧 bridge 和 probe 配合
- `DevTools` 不会完全替代 Creator 内部调试器

但和原始工作流相比，默认体验已经转为：

- **不打开 Chrome**
- **不依赖 Creator 独立面板**
- **Cursor / VS Code 作为主操作界面**

---

## 这个仓库做了什么

- 提供 Creator 侧 bridge 与 probe 注入
- 提供 Cursor / VS Code 扩展
- 提供 MCP 自动配置能力
- 提供编辑器内预览与侧栏审查面板
- 提供 F5 预览启动链路

---

## 开发说明

- **技术栈**：TypeScript + Vue 3 + Electron + Cocos Creator Extension API
- **扩展入口**：`vscode-extension/src/extension.ts`
- **Creator 主入口**：`src/main.ts`
- **预览逻辑**：`vscode-extension/src/panels/preview-panel.ts`
- **F5 预览**：`vscode-extension/src/debug-provider.ts`

---

## 说明

如果你现在的目标是把工作流完全切到 Cursor，这个仓库已经在向那个方向演进：

- Creator 退到后台
- Cursor 变成主入口
- 预览和审查都留在编辑器里
- `F5` 直接启动预览

后续如果你愿意，还可以继续把 Creator 面板相关内容进一步精简。