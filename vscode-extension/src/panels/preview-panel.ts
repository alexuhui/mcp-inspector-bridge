import * as vscode from 'vscode';
import { BridgeClient, PreviewInfo } from '../bridge/ws-client';

const PROXY_PORT_OFFSET = 1000;
/** iframe 内固定使用此端口，通过 portMapping 映射到真实预览端口 */
const WEBVIEW_PREVIEW_PORT = 17456;

let currentPanel: vscode.WebviewPanel | undefined;

export function getPreviewSrc(info: { previewUrl: string; probeProxyUrl?: string | null }, useProbeProxy: boolean): string {
    return useProbeProxy && info.probeProxyUrl ? info.probeProxyUrl : info.previewUrl;
}

/** 编辑器区域预览始终直连 Creator 预览端口，不走探针代理（代理会破坏 WebGL 渲染） */
export function getEditorPreviewSrc(info: { previewUrl: string }): string {
    return info.previewUrl;
}

function getHostPort(rawUrl: string): { host: string; port: number } | null {
    try {
        const u = new URL(rawUrl);
        const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
        if (!port) return null;
        return { host: u.hostname, port };
    } catch {
        return null;
    }
}

function buildPortMappings(info: PreviewInfo, target: { host: string; port: number } | null): vscode.WebviewPortMapping[] {
    const mappings: vscode.WebviewPortMapping[] = [
        { webviewPort: WEBVIEW_PREVIEW_PORT, extensionHostPort: info.previewPort || WEBVIEW_PREVIEW_PORT },
    ];
    if (target && target.port !== info.previewPort) {
        mappings.push({ webviewPort: target.port, extensionHostPort: target.port });
    }
    if (info.bridgePort > 0) {
        const proxyPort = info.bridgePort + PROXY_PORT_OFFSET;
        mappings.push({ webviewPort: proxyPort, extensionHostPort: proxyPort });
    }
    return mappings;
}

function getWebviewFrameUrl(target: { host: string; port: number } | null, info: PreviewInfo): string {
    if (target && target.port !== info.previewPort) {
        return `http://127.0.0.1:${target.port}/`;
    }
    return `http://127.0.0.1:${WEBVIEW_PREVIEW_PORT}/`;
}

export function getPreviewOnlyHtml(frameUrl: string, title: string): string {
    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:* http://localhost:*; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100vh; background: #000; overflow: hidden; }
  iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: none; background: #000; }
  #hint { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; color: #aaa; font: 13px system-ui, sans-serif; background: #111; }
</style>
<title>${title}</title>
</head>
<body>
  <div id="hint">加载预览中...</div>
  <iframe id="frame" src="${frameUrl}" title="${title}"></iframe>
  <script>
    const hint = document.getElementById('hint');
    document.getElementById('frame').addEventListener('load', () => { hint.style.display = 'none'; });
  </script>
</body></html>`;
}

async function openPreviewWithSimpleBrowser(previewSrc: string): Promise<boolean> {
    try {
        await vscode.commands.executeCommand('simpleBrowser.show', previewSrc);
        return true;
    } catch {
        return false;
    }
}

function openPreviewWithWebviewPanel(
    extensionUri: vscode.Uri,
    info: PreviewInfo,
    previewSrc: string,
    title: string,
): void {
    const target = getHostPort(previewSrc);
    const frameUrl = getWebviewFrameUrl(target, info);
    const portMapping = buildPortMappings(info, target);

    if (currentPanel) {
        currentPanel.title = title;
        currentPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [extensionUri],
            portMapping,
        };
        currentPanel.webview.html = getPreviewOnlyHtml(frameUrl, title);
        currentPanel.reveal(vscode.ViewColumn.Beside, true);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'cocosInspector.preview',
        title,
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [extensionUri],
            portMapping,
        },
    );

    panel.webview.html = getPreviewOnlyHtml(frameUrl, title);
    currentPanel = panel;
    panel.onDidDispose(() => {
        currentPanel = undefined;
    });
}

export async function openPreviewInEditor(bridge: BridgeClient, extensionUri: vscode.Uri): Promise<void> {
    const config = vscode.workspace.getConfiguration('cocosInspector');
    const preferredPort = config.get<number>('bridgePort') || 0;
    await bridge.connect(preferredPort);
    const info = await bridge.getPreviewInfo();
    const previewSrc = getEditorPreviewSrc(info);
    const title = `Cocos 预览 - ${info.projectName}`;
    const mode = config.get<string>('previewMode') || 'simpleBrowser';

    if (!previewSrc) {
        throw new Error('预览地址为空，请确认 Creator 已点击「预览运行」');
    }

    if (mode === 'simpleBrowser') {
        const ok = await openPreviewWithSimpleBrowser(previewSrc);
        if (ok) {
            if (currentPanel) {
                currentPanel.dispose();
                currentPanel = undefined;
            }
            return;
        }
    }

    openPreviewWithWebviewPanel(extensionUri, info, previewSrc, title);
}

export function disposePreviewPanel(): void {
    currentPanel?.dispose();
    currentPanel = undefined;
}
