import * as vscode from 'vscode';
import { BridgeClient } from '../bridge/ws-client';
import { getPreviewSrc, openPreviewInEditor } from './preview-panel';

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

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this.refresh(webviewView);
            }
        });

        this.refresh(webviewView);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'callTool') {
                try {
                    const result = await this.bridge.callTool(msg.name, msg.args || {});
                    webviewView.webview.postMessage({ type: 'toolResult', id: msg.id, name: msg.name, result });
                } catch (e: any) {
                    webviewView.webview.postMessage({ type: 'toolError', id: msg.id, name: msg.name, error: e.message });
                }
            } else if (msg.type === 'refresh') {
                this.refresh(webviewView);
            } else if (msg.type === 'openPreviewInEditor') {
                openPreviewInEditor(this.bridge, this.extensionUri).catch((e: Error) => {
                    vscode.window.showErrorMessage(e.message);
                });
            }
        });
    }

    private async refresh(webviewView: vscode.WebviewView): Promise<void> {
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

            if (previewInEditor) {
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
  .tabs { display: flex; background: #2d2d2d; }
  .tab { padding: 6px 12px; cursor: pointer; border-bottom: 2px solid transparent; }
  .tab.active { border-bottom-color: #0e639c; color: #fff; }
  .panel { flex: 1; overflow: auto; padding: 8px; }
  pre { font-size: 11px; white-space: pre-wrap; word-break: break-all; }
  button { padding: 4px 10px; background: #0e639c; color: #fff; border: none; cursor: pointer; border-radius: 2px; }
  #tree { font-family: monospace; font-size: 12px; }
  .node { padding: 2px 4px; cursor: pointer; border-radius: 2px; }
  .node:hover { background: #37373d; }
</style>
</head>
<body>
  <header>
    <span class="status">● ${info.projectName}</span>
    <span>Bridge :${info.bridgePort}</span>
    ${modeHint}
    <button onclick="loadTree()">刷新节点树</button>
    <button onclick="vscode.postMessage({type:'refresh'})">重连</button>
    <button onclick="vscode.postMessage({type:'openPreviewInEditor'})">在编辑器打开预览</button>
  </header>
  <div class="layout">
    ${previewBlock}
    <div class="${sidebarClass}">
      <div class="tabs">
        <div class="tab active" id="tab-tree">节点树</div>
        <div class="tab" id="tab-detail">属性</div>
      </div>
      <div class="panel" id="panel-tree"><div id="tree">加载中...</div></div>
      <div class="panel" id="panel-detail" style="display:none"><pre id="detail">选中节点查看属性</pre></div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    let selectedUuid = '';
    let treeData = null;
    let detailText = '选中节点查看属性';
    let requestSeq = 0;
    const pendingTools = {};

    function loadTree() {
      const id = String(++requestSeq);
      pendingTools[id] = 'get_node_tree';
      document.getElementById('tree').textContent = '加载中...';
      vscode.postMessage({ type: 'callTool', id, name: 'get_node_tree', args: { depth: 8 } });
    }

    function nodeLabel(node) {
      if (!node || typeof node !== 'object') return '?';
      if (typeof node === 'string') return node;
      if (node.isScene) return node.name || 'Scene';
      return node.name || node.id || '?';
    }

    function flattenTree(node, depth, rows) {
      if (!node) return;
      if (typeof node === 'string') {
        rows.push({ label: node, depth: depth, id: '', isTruncated: true });
        return;
      }
      if (typeof node !== 'object') return;
      rows.push({
        label: nodeLabel(node),
        depth: depth,
        id: node.id || '',
        inactive: node.activeInHierarchy === false,
        isScene: !!node.isScene,
        compCount: typeof node.components === 'number' ? node.components : 0,
      });
      if (Array.isArray(node.children)) {
        node.children.forEach(function(child) { flattenTree(child, depth + 1, rows); });
      }
    }

    function renderTree(node) {
      const rows = [];
      flattenTree(node, 0, rows);
      if (rows.length === 0) return '<div class="node">（空节点树）</div>';
      return rows.map(function(row) {
        const icon = row.isScene ? '🌐 ' : (row.isTruncated ? '… ' : '');
        const style = 'padding-left:' + (row.depth * 12) + 'px' + (row.inactive ? ';opacity:0.45' : '');
        const badge = row.compCount > 0 ? ' <span style="color:#888;font-size:10px">' + row.compCount + '</span>' : '';
        if (row.id) {
          return '<div class="node" style="' + style + '" data-uuid="' + row.id + '">' + icon + row.label + badge + '</div>';
        }
        return '<div class="node" style="' + style + ';color:#888">' + icon + row.label + '</div>';
      }).join('');
    }

    function unwrapTree(data) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
      if (data.tree && typeof data.tree === 'object' && !Array.isArray(data.children)) return data.tree;
      return data;
    }

    function isLikelyFullTree(node) {
      if (!node || typeof node !== 'object') return false;
      if (node.isScene) return true;
      if (node.name === 'Scene' || node.name === 'Main') return true;
      return false;
    }

    function renderTreePanel() {
      const treeEl = document.getElementById('tree');
      if (!treeData) {
        treeEl.textContent = '（无节点树数据）';
        return;
      }
      treeEl.innerHTML = renderTree(treeData);
      bindTreeNodeClicks();
      if (selectedUuid) {
        const sel = treeEl.querySelector('.node[data-uuid="' + selectedUuid + '"]');
        if (sel) sel.style.background = '#37373d';
      }
    }

    function renderDetailPanel() {
      document.getElementById('detail').textContent = detailText;
    }

    function bindTreeNodeClicks() {
      document.querySelectorAll('.node[data-uuid]').forEach(el => {
        el.onclick = () => {
          selectedUuid = el.dataset.uuid;
          detailText = '加载属性中...';
          renderDetailPanel();
          switchToDetailTab();
          const id = String(++requestSeq);
          pendingTools[id] = 'get_node_detail';
          vscode.postMessage({ type: 'callTool', id, name: 'get_node_detail', args: { uuid: selectedUuid } });
        };
      });
    }

    function applyTreeData(tree) {
      const root = unwrapTree(tree);
      if (!root || typeof root !== 'object') return;
      treeData = root;
      if (document.getElementById('panel-tree').style.display !== 'none') {
        renderTreePanel();
      }
    }

    function handleTreeText(text) {
      if (!text || typeof text !== 'string') {
        document.getElementById('tree').textContent = '空响应';
        return;
      }
      if (text.startsWith('Execution failed:')) {
        document.getElementById('tree').textContent = text;
        return;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        document.getElementById('tree').textContent = '解析失败: ' + err.message;
        return;
      }
      if (data && data.error) {
        document.getElementById('tree').textContent = '错误: ' + (data.msg || data.error);
        return;
      }
      applyTreeData(unwrapTree(data));
    }

    function handleDetailText(text) {
      if (!text || typeof text !== 'string') {
        detailText = '空响应';
      } else if (text.startsWith('Execution failed:')) {
        detailText = text;
      } else {
        try {
          const data = JSON.parse(text);
          if (data && data.error) {
            detailText = '错误: ' + (data.msg || data.error);
          } else {
            detailText = JSON.stringify(data, null, 2);
          }
        } catch (err) {
          detailText = '解析失败: ' + err.message;
        }
      }
      if (document.getElementById('panel-detail').style.display !== 'none') {
        renderDetailPanel();
      }
    }

    function resolveToolName(msg) {
      return msg.name || pendingTools[msg.id] || '';
    }

    function dispatchToolResult(toolName, text) {
      if (toolName === 'get_node_detail') {
        handleDetailText(text);
      } else if (toolName === 'get_node_tree') {
        handleTreeText(text);
      }
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'toolResult' && msg.result && msg.result.content) {
        const toolName = resolveToolName(msg);
        delete pendingTools[msg.id];
        if (!toolName) return;
        dispatchToolResult(toolName, msg.result.content[0].text);
      } else if (msg.type === 'toolError') {
        const toolName = resolveToolName(msg);
        delete pendingTools[msg.id];
        if (toolName === 'get_node_detail') {
          detailText = '错误: ' + msg.error;
          if (document.getElementById('panel-detail').style.display !== 'none') renderDetailPanel();
        } else if (toolName === 'get_node_tree') {
          document.getElementById('tree').textContent = '错误: ' + msg.error;
        }
      } else if (msg.type === 'bridgeEvent' && msg.event && msg.event.type === 'probe:event' && msg.event.channel === 'update-tree') {
        try {
          const payload = typeof msg.event.args[0] === 'string' ? JSON.parse(msg.event.args[0]) : msg.event.args[0];
          if (payload && payload.tree && isLikelyFullTree(unwrapTree(payload.tree))) {
            applyTreeData(payload.tree);
          }
        } catch(_) {}
      }
    });

    function switchToTreeTab() {
      document.getElementById('tab-tree').classList.add('active');
      document.getElementById('tab-detail').classList.remove('active');
      document.getElementById('panel-tree').style.display = '';
      document.getElementById('panel-detail').style.display = 'none';
      renderTreePanel();
    }

    function switchToDetailTab() {
      document.getElementById('tab-detail').classList.add('active');
      document.getElementById('tab-tree').classList.remove('active');
      document.getElementById('panel-detail').style.display = '';
      document.getElementById('panel-tree').style.display = 'none';
      renderDetailPanel();
    }

    document.getElementById('tab-tree').onclick = switchToTreeTab;
    document.getElementById('tab-detail').onclick = switchToDetailTab;

    loadTree();
  </script>
</body></html>`;
    }
}
