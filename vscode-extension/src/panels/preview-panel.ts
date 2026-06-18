import * as vscode from 'vscode';
import { BridgeClient, PreviewInfo } from '../bridge/ws-client';

const PROXY_PORT_OFFSET = 1000;
const PREVIEW_PANEL_VIEW_TYPE = 'cocosInspector.preview';
/** iframe 内固定使用此端口，通过 portMapping 映射到真实预览端口 */
const WEBVIEW_PREVIEW_PORT = 17456;

let currentPanel: vscode.WebviewPanel | undefined;
let previewOpenTask: Promise<void> | undefined;
let lastOpenedPreviewSrc: string | undefined;

export function getPreviewSrc(info: { previewUrl: string; probeProxyUrl?: string | null }, useProbeProxy: boolean): string {
    return useProbeProxy && info.probeProxyUrl ? info.probeProxyUrl : info.previewUrl;
}

/** 编辑器区预览始终直连 Creator 预览端口（不走探针代理，避免 WebGL/资源加载问题） */
export function getEditorPreviewSrc(info: { previewUrl: string }): string {
    return info.previewUrl;
}

function parsePreviewPort(url: string): string | undefined {
    try {
        const u = new URL(url);
        return u.port || undefined;
    } catch {
        return undefined;
    }
}

function isSimpleBrowserViewType(viewType: string): boolean {
    const vt = viewType.toLowerCase();
    return vt.includes('simplebrowser') || vt.includes('simple-browser');
}

function isPreviewTabLabel(tab: vscode.Tab, previewSrc: string, projectName: string): boolean {
    const label = tab.label;
    if (label.includes('CocosCreator') || label.includes('Cocos 预览')) {
        return true;
    }
    if (projectName && label.toLowerCase().includes(projectName.toLowerCase())) {
        return true;
    }
    const port = parsePreviewPort(previewSrc);
    if (port && (label.includes(port) || label.includes(`127.0.0.1:${port}`))) {
        return true;
    }
    return false;
}

function isPreviewTab(tab: vscode.Tab, previewSrc: string, projectName: string, mode: string): boolean {
    if (isPreviewTabLabel(tab, previewSrc, projectName)) {
        return true;
    }
    const input = tab.input;
    if (!(input instanceof vscode.TabInputWebview)) {
        return false;
    }
    if (mode === 'webview' && input.viewType === PREVIEW_PANEL_VIEW_TYPE) {
        return true;
    }
    if (mode === 'simpleBrowser' && isSimpleBrowserViewType(input.viewType)) {
        return true;
    }
    return false;
}

function findExistingPreviewTab(previewSrc: string, projectName: string, mode: string): vscode.Tab | undefined {
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (isPreviewTab(tab, previewSrc, projectName, mode)) {
                return tab;
            }
        }
    }
    return undefined;
}

async function focusExistingPreviewTab(tab: vscode.Tab): Promise<void> {
    const revealTab = (vscode.window as { revealTab?: (t: vscode.Tab) => Thenable<void> }).revealTab;
    if (revealTab) {
        await revealTab(tab);
    }
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

async function openPreviewWithSimpleBrowser(
    previewSrc: string,
    projectName: string,
    forceReload: boolean,
): Promise<boolean> {
    const existing = findExistingPreviewTab(previewSrc, projectName, 'simpleBrowser');
    if (existing && !forceReload) {
        await focusExistingPreviewTab(existing);
        return true;
    }
    if (existing && forceReload) {
        try {
            await vscode.window.tabGroups.close(existing);
        } catch { /* ignore */ }
        if (lastOpenedPreviewSrc === previewSrc) {
            lastOpenedPreviewSrc = undefined;
        }
    }
    if (!forceReload && lastOpenedPreviewSrc === previewSrc) {
        const again = findExistingPreviewTab(previewSrc, projectName, 'simpleBrowser');
        if (again) {
            await focusExistingPreviewTab(again);
            return true;
        }
    }
    try {
        await vscode.commands.executeCommand('simpleBrowser.show', previewSrc);
        lastOpenedPreviewSrc = previewSrc;
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

    const existingTab = findExistingPreviewTab(previewSrc, info.projectName, 'webview');
    if (existingTab) {
        void focusExistingPreviewTab(existingTab);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        PREVIEW_PANEL_VIEW_TYPE,
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

async function closeStaleProxyPreviewTabs(bridgePort: number, projectName: string): Promise<void> {
    const proxyPort = bridgePort + PROXY_PORT_OFFSET;
    const proxyHint = `:${proxyPort}`;
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const label = tab.label || '';
            if (label.includes(proxyHint) || label.includes(`127.0.0.1:${proxyPort}`)) {
                try {
                    await vscode.window.tabGroups.close(tab);
                } catch { /* ignore */ }
            }
        }
    }
    if (lastOpenedPreviewSrc && lastOpenedPreviewSrc.includes(proxyHint)) {
        lastOpenedPreviewSrc = undefined;
    }
}

async function openPreviewInEditorOnce(
    bridge: BridgeClient,
    extensionUri: vscode.Uri,
    options?: { forceReload?: boolean },
): Promise<void> {
    const config = vscode.workspace.getConfiguration('cocosInspector');
    const preferredPort = config.get<number>('bridgePort') || 0;
    await bridge.connect(preferredPort);
    const info = await bridge.getPreviewInfo();
    const previewSrc = getEditorPreviewSrc(info);
    const title = `Cocos 预览 - ${info.projectName}`;
    const mode = config.get<string>('previewMode') || 'simpleBrowser';
    const forceReload = options?.forceReload === true;

    if (!previewSrc) {
        throw new Error('预览地址为空，请确认 Creator 已点击「预览运行」');
    }

    await closeStaleProxyPreviewTabs(info.bridgePort, info.projectName);

    if (mode === 'simpleBrowser') {
        const existing = findExistingPreviewTab(previewSrc, info.projectName, 'simpleBrowser');
        if (existing && !forceReload) {
            await focusExistingPreviewTab(existing);
            return;
        }
        const ok = await openPreviewWithSimpleBrowser(previewSrc, info.projectName, forceReload);
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

export async function openPreviewInEditor(
    bridge: BridgeClient,
    extensionUri: vscode.Uri,
    options?: { forceReload?: boolean },
): Promise<void> {
    if (previewOpenTask) {
        return previewOpenTask;
    }
    previewOpenTask = openPreviewInEditorOnce(bridge, extensionUri, options).finally(() => {
        previewOpenTask = undefined;
    });
    return previewOpenTask;
}

export function disposePreviewPanel(): void {
    currentPanel?.dispose();
    currentPanel = undefined;
    lastOpenedPreviewSrc = undefined;
}
