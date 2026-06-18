import * as vscode from 'vscode';
import { BridgeClient } from '../bridge/ws-client';
import { getPreviewSrc, openPreviewInEditor } from './preview-panel';
import { buildSidebarScript } from './sidebar-script';

export class InspectorPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cocosInspector.panel';

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly bridge: BridgeClient,
    ) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri],
        };

        webviewView.webview.html = this.getLoadingHtml();

        const doRefresh = (ensurePreview: boolean) => {
            void this.refresh(webviewView, { ensurePreview });
        };

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                doRefresh(true);
            }
        });

        if (webviewView.visible) {
            doRefresh(true);
        }

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'callTool') {
                try {
                    const result = await this.bridge.callTool(msg.name, msg.args || {});
                    webviewView.webview.postMessage({ type: 'toolResult', id: msg.id, name: msg.name, result });
                } catch (e: any) {
                    webviewView.webview.postMessage({ type: 'toolError', id: msg.id, name: msg.name, error: e.message });
                }
            } else if (msg.type === 'refresh') {
                void this.refresh(webviewView, { ensurePreview: false });
            } else if (msg.type === 'openPreviewInEditor') {
                openPreviewInEditor(this.bridge, this.extensionUri, { forceReload: true }).catch((e: Error) => {
                    vscode.window.showErrorMessage(e.message);
                });
            }
        });
    }

    private async refresh(webviewView: vscode.WebviewView, opts?: { ensurePreview?: boolean }): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('cocosInspector');
            const preferredPort = config.get<number>('bridgePort') || 0;
            await this.bridge.connect(preferredPort);
            const info = await this.bridge.getPreviewInfo();
            const useProbeProxy = config.get<boolean>('useProbeProxy') === true;
            const previewInEditor = config.get<boolean>('previewInEditor') !== false;
            const previewSrc = getPreviewSrc(info, useProbeProxy);

            this.bridge.subscribe((event) => {
                webviewView.webview.postMessage({ type: 'bridgeEvent', event });
            });

            if (previewInEditor && opts?.ensurePreview !== false) {
                openPreviewInEditor(this.bridge, this.extensionUri).catch(() => { /* 侧栏仍展示节点树 */ });
            }

            webviewView.webview.html = this.getPanelHtml(
                { ...info, previewUrl: previewSrc },
                useProbeProxy,
                previewInEditor,
            );
        } catch (e: any) {
            webviewView.webview.html = this.getErrorHtml(e.message);
        }
    }

    private getLoadingHtml(): string {
        return `<!DOCTYPE html><html><body style="background:#1e1e1e;color:#ccc;font-family:sans-serif;padding:16px;">连接 Bridge 中...</body></html>`;
    }

    private getErrorHtml(message: string): string {
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { background:#1e1e1e; color:#ccc; font-family:sans-serif; padding:16px; }
  .err { color:#f48771; white-space:pre-wrap; }
  button { margin-top:12px; padding:6px 12px; background:#0e639c; color:#fff; border:none; cursor:pointer; }
</style></head><body>
  <h3>未连接到 Cocos Bridge</h3>
  <p class="err">${message}</p>
  <p>请确认：</p>
  <ol>
    <li>Cocos Creator 已打开项目</li>
    <li>mcp-inspector-bridge 插件已加载</li>
    <li>已点击「预览运行」</li>
  </ol>
  <button onclick="vscode.postMessage({type:'refresh'})">重试连接</button>
  <script>const vscode = acquireVsCodeApi();</script>
</body></html>`;
    }

    private getPanelHtml(
        info: { previewUrl: string; projectName: string; bridgePort: number; previewPort?: number; hasPreview: boolean; probeProxyUrl?: string | null },
        useProbeProxy = false,
        previewInEditor = false,
    ): string {
        const previewSrc = info.previewUrl;
        const modeHint = previewInEditor
            ? `<span style="color:#9cdcfe;font-size:11px">编辑器直连 :${info.previewPort ?? ''}</span>`
            : (useProbeProxy && info.probeProxyUrl
                ? `<span style="color:#dcdcaa;font-size:11px">代理预览</span>`
                : '');
        const previewBlock = previewInEditor
            ? ''
            : `<div class="preview">
      <iframe src="${previewSrc}" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
    </div>`;
        const sidebarClass = previewInEditor ? 'sidebar sidebar-full' : 'sidebar';
        return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:* http://localhost:*; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { display: flex; flex-direction: column; height: 100vh; background: #1e1e1e; color: #ccc; font-family: system-ui, sans-serif; font-size: 13px; }
  header { padding: 8px 12px; background: #252526; border-bottom: 1px solid #3c3c3c; display: flex; gap: 8px; align-items: center; flex-shrink: 0; flex-wrap: wrap; }
  .status { color: #4ec9b0; }
  .layout { display: flex; flex: 1; min-height: 0; }
  .preview { flex: 1; min-width: 0; border-right: 1px solid #3c3c3c; }
  .preview iframe { width: 100%; height: 100%; border: none; background: #000; }
  .sidebar { width: 280px; display: flex; flex-direction: column; flex-shrink: 0; }
  .sidebar-full { width: 100%; flex: 1; }
  .tabs { display: flex; background: #2d2d2d; overflow-x: auto; flex-shrink: 0; }
  .tab { padding: 6px 10px; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; font-size: 12px; }
  .tab.active { border-bottom-color: #0e639c; color: #fff; }
  .panel { flex: 1; overflow: auto; padding: 8px; }
  pre { font-size: 11px; white-space: pre-wrap; word-break: break-all; }
  button { padding: 4px 10px; background: #0e639c; color: #fff; border: none; cursor: pointer; border-radius: 2px; }
  #tree { font-family: monospace; font-size: 12px; }
  .node { padding: 2px 4px; cursor: pointer; border-radius: 2px; }
  .node:hover { background: #37373d; }
  .node.match { color: #4ec9b0; }
  .search-bar { padding: 6px 0 4px; flex-shrink: 0; }
  .search-bar input { width: 100%; padding: 4px 8px; background: #3c3c3c; border: 1px solid #555; color: #ccc; border-radius: 2px; font-size: 12px; }
  .sync-hint { font-size: 10px; color: #888; padding: 2px 0 4px; min-height: 14px; }
  #panel-tree { display: flex; flex-direction: column; }
  #tree { flex: 1; overflow: auto; }
  .detail-section { margin-bottom: 10px; }
  .detail-section h4 { font-size: 11px; color: #9cdcfe; margin-bottom: 4px; text-transform: uppercase; }
  .detail-kv { display: grid; grid-template-columns: 72px 1fr; gap: 2px 8px; font-size: 12px; margin-bottom: 2px; }
  .detail-kv .k { color: #888; }
  details.comp { margin-bottom: 4px; background: #2a2a2a; border-radius: 2px; padding: 4px 6px; }
  details.comp summary { cursor: pointer; color: #dcdcaa; font-size: 12px; }
  .detail-placeholder { color: #888; font-size: 12px; white-space: pre-wrap; }
  details.raw-json { margin-top: 8px; }
  details.raw-json pre { margin-top: 4px; font-size: 10px; color: #aaa; }
  .prop-input { width: 100%; background: #3c3c3c; border: 1px solid #555; color: #ccc; padding: 2px 4px; font-size: 11px; border-radius: 2px; }
  .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .stat { background: #2a2a2a; padding: 8px; border-radius: 4px; }
  .stat .label { display: block; font-size: 10px; color: #888; }
  .stat .val { font-size: 16px; color: #4ec9b0; }
  .mem-total { margin-bottom: 8px; color: #9cdcfe; font-size: 12px; }
  .mem-row, .script-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #333; font-size: 12px; }
  .engine-btns { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .hint { font-size: 10px; color: #888; margin-top: 8px; }
  #engine-msg { font-size: 11px; color: #dcdcaa; min-height: 16px; }
</style>
</head>
<body>
  <header>
    <span class="status">● ${info.projectName}</span>
    <span>Bridge :${info.bridgePort}</span>
    ${modeHint}
    <span id="sync-hint" class="sync-hint"></span>
    <button onclick="loadTree()">刷新节点树</button>
    <button onclick="vscode.postMessage({type:'refresh'})">重连</button>
    <button onclick="vscode.postMessage({type:'openPreviewInEditor'})">在编辑器打开预览</button>
  </header>
  <div class="layout">
    ${previewBlock}
    <div class="${sidebarClass}">
      <div class="tabs">
        <div class="tab" id="tab-tree">节点树</div>
        <div class="tab" id="tab-detail">属性</div>
        <div class="tab" id="tab-perf">性能</div>
        <div class="tab" id="tab-memory">内存</div>
        <div class="tab" id="tab-engine">引擎</div>
        <div class="tab" id="tab-render">渲染</div>
        <div class="tab" id="tab-scripts">脚本</div>
      </div>
      <div class="panel" id="panel-tree">
        <div class="search-bar"><input type="text" id="tree-search" placeholder="搜索节点名称或组件..." /></div>
        <div id="tree">加载中...</div>
      </div>
      <div class="panel" id="panel-detail" style="display:none"><div id="detail">选中节点查看属性</div></div>
      <div class="panel" id="panel-perf" style="display:none"><div id="perf-content">加载中...</div></div>
      <div class="panel" id="panel-memory" style="display:none"><div id="memory-content">点击标签加载</div></div>
      <div class="panel" id="panel-engine" style="display:none">
        <div class="engine-btns">
          <button id="btn-pause">暂停/恢复</button>
          <button id="btn-step">单帧</button>
          <button id="btn-mute">静音</button>
          <button id="btn-unmute">恢复音量</button>
        </div>
        <div id="engine-msg"></div>
      </div>
      <div class="panel" id="panel-render" style="display:none"><div id="render-content">等待数据...</div></div>
      <div class="panel" id="panel-scripts" style="display:none"><div id="scripts-content">点击标签加载</div></div>
    </div>
  </div>
  <script>${buildSidebarScript()}</script>
</body></html>`;
    }
}
