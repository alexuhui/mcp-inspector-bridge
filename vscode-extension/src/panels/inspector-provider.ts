import * as vscode from 'vscode';
import { BridgeClient } from '../bridge/ws-client';
import { configurePreviewWebview, getEditorPreviewSrc } from './preview-panel';

export class InspectorPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cocosInspector.panel';

    private connectionUnsub: (() => void) | null = null;

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
        const doRefresh = () => { void this.refresh(webviewView); };
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) doRefresh();
        });
        if (webviewView.visible) doRefresh();
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'refresh') {
                void this.refresh(webviewView);
            } else if (msg.type === 'pickInstance') {
                void vscode.commands.executeCommand('cocosInspector.pickInstance').then(() => {
                    void this.refresh(webviewView);
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
            const previewSrc = getEditorPreviewSrc(info);
            if (!previewSrc) {
                throw new Error('预览地址为空，请先在 Creator 点击「预览运行」');
            }
            this.bindConnectionStatus(webviewView.webview);
            const frameUrl = configurePreviewWebview(webviewView.webview, this.extensionUri, info, previewSrc);
            webviewView.webview.html = this.getPreviewPanelHtml(info, frameUrl);
        } catch (e: any) {
            webviewView.webview.html = this.getErrorHtml(e.message);
        }
    }

    private bindConnectionStatus(webview: vscode.Webview): void {
        if (this.connectionUnsub) {
            this.connectionUnsub();
            this.connectionUnsub = null;
        }
        this.connectionUnsub = this.bridge.onConnectionChange((connected) => {
            webview.postMessage({ type: 'bridgeStatus', connected });
        });
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
  button { margin-top:12px; padding:6px 12px; background:#0e639c; color:#fff; border:none; cursor:pointer; margin-right:8px; }
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
  <button onclick="vscode.postMessage({type:'pickInstance'})">选择实例</button>
  <script>const vscode = acquireVsCodeApi();</script>
</body></html>`;
    }

    private getPreviewPanelHtml(
        info: { projectName: string; bridgePort: number; previewPort?: number },
        frameUrl: string,
    ): string {
        return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:* http://localhost:*; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { display: flex; flex-direction: column; height: 100vh; background: #000; color: #ccc; font-family: system-ui, sans-serif; font-size: 12px; }
  header { padding: 6px 10px; background: #252526; border-bottom: 1px solid #3c3c3c; display: flex; gap: 8px; align-items: center; flex-shrink: 0; flex-wrap: wrap; }
  .conn-dot { width: 8px; height: 8px; border-radius: 50%; background: #4ec9b0; flex-shrink: 0; }
  .conn-dot.off { background: #f48771; }
  .status { color: #4ec9b0; }
  .preview { flex: 1; min-height: 0; position: relative; }
  .preview iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: none; background: #000; }
  #hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #aaa; background: #111; z-index: 1; }
  button { padding: 3px 8px; background: #0e639c; color: #fff; border: none; cursor: pointer; border-radius: 2px; font-size: 12px; }
  .bridge-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.72); z-index: 100; align-items: center; justify-content: center; padding: 16px; }
  .bridge-overlay.show { display: flex; }
  .bridge-overlay .card { background: #252526; border: 1px solid #3c3c3c; border-radius: 6px; padding: 16px; max-width: 280px; }
  .bridge-overlay h4 { color: #f48771; margin-bottom: 8px; font-size: 13px; }
  .bridge-overlay p { font-size: 12px; color: #aaa; margin-bottom: 8px; line-height: 1.5; }
  .bridge-overlay .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
</style>
</head>
<body>
  <div id="bridge-overlay" class="bridge-overlay">
    <div class="card">
      <h4>Bridge 连接已断开</h4>
      <p>Creator 关闭、插件重载或端口变更会导致断开。请确认预览仍在运行后重连。</p>
      <div class="actions">
        <button onclick="vscode.postMessage({type:'refresh'})">重连</button>
        <button onclick="vscode.postMessage({type:'pickInstance'})">选择实例</button>
      </div>
    </div>
  </div>
  <header>
    <span class="conn-dot" id="conn-dot" title="Bridge 连接状态"></span>
    <span class="status">${info.projectName}</span>
    <span>Bridge :${info.bridgePort}</span>
    <span style="color:#9cdcfe">预览 :${info.previewPort ?? ''}</span>
    <button onclick="vscode.postMessage({type:'refresh'})">重连</button>
  </header>
  <div class="preview">
    <div id="hint">加载预览中...</div>
    <iframe id="frame" src="${frameUrl}" title="Cocos 预览 - ${info.projectName}"></iframe>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const hint = document.getElementById('hint');
    const frame = document.getElementById('frame');
    frame.addEventListener('load', () => { hint.style.display = 'none'; });
    function setBridgeConnected(connected) {
      const dot = document.getElementById('conn-dot');
      const overlay = document.getElementById('bridge-overlay');
      if (dot) dot.classList.toggle('off', !connected);
      if (overlay) overlay.classList.toggle('show', !connected);
    }
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'bridgeStatus') setBridgeConnected(!!e.data.connected);
    });
  </script>
</body></html>`;
    }
}
