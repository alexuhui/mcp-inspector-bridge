import * as vscode from 'vscode';
import { BridgeClient } from '../bridge/ws-client';

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

        this.refresh(webviewView);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'callTool') {
                try {
                    const result = await this.bridge.callTool(msg.name, msg.args || {});
                    webviewView.webview.postMessage({ type: 'toolResult', id: msg.id, result });
                } catch (e: any) {
                    webviewView.webview.postMessage({ type: 'toolError', id: msg.id, error: e.message });
                }
            } else if (msg.type === 'refresh') {
                this.refresh(webviewView);
            }
        });
    }

    private async refresh(webviewView: vscode.WebviewView): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('cocosInspector');
            const preferredPort = config.get<number>('bridgePort') || 0;
            await this.bridge.connect(preferredPort);
            const info = await this.bridge.getPreviewInfo();

            this.bridge.subscribe((event) => {
                webviewView.webview.postMessage({ type: 'bridgeEvent', event });
            });

            webviewView.webview.html = this.getPanelHtml(info);
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

    private getPanelHtml(info: { previewUrl: string; projectName: string; bridgePort: number; hasPreview: boolean }): string {
        const previewSrc = info.previewUrl;
        return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:* http://localhost:*; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { display: flex; flex-direction: column; height: 100vh; background: #1e1e1e; color: #ccc; font-family: system-ui, sans-serif; font-size: 13px; }
  header { padding: 8px 12px; background: #252526; border-bottom: 1px solid #3c3c3c; display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
  .status { color: #4ec9b0; }
  .layout { display: flex; flex: 1; min-height: 0; }
  .preview { flex: 1; min-width: 0; border-right: 1px solid #3c3c3c; }
  .preview iframe { width: 100%; height: 100%; border: none; background: #000; }
  .sidebar { width: 280px; display: flex; flex-direction: column; flex-shrink: 0; }
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
    <button onclick="loadTree()">刷新节点树</button>
    <button onclick="vscode.postMessage({type:'refresh'})">重连</button>
  </header>
  <div class="layout">
    <div class="preview">
      <iframe src="${previewSrc}" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
    </div>
    <div class="sidebar">
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

    function loadTree() {
      const id = Date.now().toString();
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

    function applyTreeToDom(tree) {
      const root = unwrapTree(tree);
      if (!root || typeof root !== 'object') {
        document.getElementById('tree').textContent = '（无节点树数据）';
        return;
      }
      document.getElementById('tree').innerHTML = renderTree(root);
      document.querySelectorAll('.node[data-uuid]').forEach(el => {
        el.onclick = () => {
          selectedUuid = el.dataset.uuid;
          document.getElementById('tab-detail').click();
          const rid = Date.now().toString();
          vscode.postMessage({ type: 'callTool', id: rid, name: 'get_node_detail', args: { uuid: selectedUuid } });
        };
      });
    }

    function handleToolText(text) {
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
      if (data && data.id && Array.isArray(data.components)) {
        document.getElementById('detail').textContent = JSON.stringify(data, null, 2);
        return;
      }
      applyTreeToDom(unwrapTree(data));
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'toolResult' && msg.result && msg.result.content) {
        handleToolText(msg.result.content[0].text);
      } else if (msg.type === 'toolError') {
        document.getElementById('tree').textContent = '错误: ' + msg.error;
      } else if (msg.type === 'bridgeEvent' && msg.event && msg.event.type === 'probe:event' && msg.event.channel === 'update-tree') {
        try {
          const payload = typeof msg.event.args[0] === 'string' ? JSON.parse(msg.event.args[0]) : msg.event.args[0];
          if (payload && payload.tree) {
            applyTreeToDom(payload.tree);
          }
        } catch(_) {}
      }
    });

    document.getElementById('tab-tree').onclick = () => {
      document.getElementById('tab-tree').classList.add('active');
      document.getElementById('tab-detail').classList.remove('active');
      document.getElementById('panel-tree').style.display = '';
      document.getElementById('panel-detail').style.display = 'none';
    };
    document.getElementById('tab-detail').onclick = () => {
      document.getElementById('tab-detail').classList.add('active');
      document.getElementById('tab-tree').classList.remove('active');
      document.getElementById('panel-detail').style.display = '';
      document.getElementById('panel-tree').style.display = 'none';
    };

    loadTree();
  </script>
</body></html>`;
    }
}
