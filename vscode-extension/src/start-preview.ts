import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BridgeClient } from './bridge/ws-client';
import { openPreviewInEditor } from './panels/preview-panel';

export function isCocosProjectWorkspace(): boolean {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return false;
    return folders.some((f) => fs.existsSync(path.join(f.uri.fsPath, 'project.json')));
}

export async function runStartPreview(
    bridge: BridgeClient,
    extensionUri: vscode.Uri,
    options?: { forceReload?: boolean },
): Promise<void> {
    const config = vscode.workspace.getConfiguration('cocosInspector');
    const preferredPort = config.get<number>('bridgePort') || 0;
    await bridge.connect(preferredPort);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Cocos 预览',
            cancellable: false,
        },
        async () => {
            await bridge.ensurePreviewRunning();
            await openPreviewInEditor(bridge, extensionUri, options);
        },
    );
}
