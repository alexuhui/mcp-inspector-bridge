import * as vscode from 'vscode';
import { BridgeClient, configureCursorMcp } from './bridge/ws-client';
import { InspectorPanelProvider } from './panels/inspector-provider';
import { runStartPreview } from './start-preview';
import { registerCocosPreviewDebugProvider } from './debug-provider';

let statusBarItem: vscode.StatusBarItem;
let bridgeClient: BridgeClient;

async function connectToPort(port: number, showMessage = true): Promise<void> {
    const inst = await bridgeClient.connect(port);
    statusBarItem.text = `$(debug-start) Cocos: ${inst.projectName}`;
    statusBarItem.tooltip = `已连接 :${inst.port}\n${inst.projectPath}\n点击切换实例`;
    if (showMessage) {
        vscode.window.showInformationMessage(`已连接 Cocos Bridge: ${inst.projectName} (:${inst.port})`);
    }
}

async function pickAndConnectInstance(showMessage = true): Promise<void> {
    const config = vscode.workspace.getConfiguration('cocosInspector');
    const preferredPort = config.get<number>('bridgePort') || 0;
    const instances = await bridgeClient.scanInstances();

    if (instances.length === 0) {
        throw new Error('未找到运行中的 mcp-inspector-bridge（请确认 Cocos Creator 已打开项目）');
    }

    if (instances.length === 1) {
        if (preferredPort !== instances[0].port) {
            await config.update('bridgePort', instances[0].port, vscode.ConfigurationTarget.Workspace);
        }
        await connectToPort(instances[0].port, showMessage);
        return;
    }

    const items = instances.map((inst) => ({
        label: `${inst.projectName}`,
        description: `:${inst.port}`,
        detail: inst.projectPath,
        port: inst.port,
        picked: preferredPort > 0 ? inst.port === preferredPort : false,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: '选择 Cocos Bridge 实例',
        title: 'Cocos MCP Inspector',
    });

    if (!picked) return;

    await config.update('bridgePort', picked.port, vscode.ConfigurationTarget.Workspace);
    await connectToPort(picked.port, showMessage);
}

function syncCocosProjectContext(): void {
    const detected = vscode.workspace.workspaceFolders?.some((folder) => {
        const fs = require('fs') as typeof import('fs');
        const path = require('path') as typeof import('path');
        return fs.existsSync(path.join(folder.uri.fsPath, 'project.json'));
    }) === true;
    void vscode.commands.executeCommand(
        'setContext',
        'cocosInspector.projectDetected',
        detected,
    );
}

export function activate(context: vscode.ExtensionContext): void {
    bridgeClient = new BridgeClient();

    syncCocosProjectContext();
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(syncCocosProjectContext),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('cocosInspector')) {
                syncCocosProjectContext();
            }
        }),
    );

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'cocosInspector.pickInstance';
    statusBarItem.text = '$(debug-disconnect) Cocos Bridge';
    statusBarItem.tooltip = 'Cursor-first Cocos Inspector — 点击选择实例';
    statusBarItem.show();
    vscode.window.setStatusBarMessage('Cocos Inspector 已就绪：F5 启动预览，侧栏查看节点树。', 5000);
    context.subscriptions.push(statusBarItem);

    const provider = new InspectorPanelProvider(context.extensionUri, bridgeClient);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(InspectorPanelProvider.viewType, provider),
    );

    registerCocosPreviewDebugProvider(context, bridgeClient);

    context.subscriptions.push(
        vscode.commands.registerCommand('cocosInspector.open', () => {
            void vscode.commands.executeCommand('cocosInspector.panel.focus');
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cocosInspector.startPreview', async () => {
            try {
                await runStartPreview(bridgeClient, context.extensionUri);
            } catch (e: any) {
                vscode.window.showErrorMessage(e.message);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cocosInspector.openPreview', async () => {
            try {
                await runStartPreview(bridgeClient, context.extensionUri);
            } catch (e: any) {
                vscode.window.showErrorMessage(e.message);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cocosInspector.pickInstance', async () => {
            try {
                await pickAndConnectInstance(true);
            } catch (e: any) {
                statusBarItem.text = '$(debug-disconnect) Cocos';
                vscode.window.showErrorMessage(e.message);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cocosInspector.connect', async () => {
            try {
                await pickAndConnectInstance(true);
            } catch (e: any) {
                statusBarItem.text = '$(debug-disconnect) Cocos';
                vscode.window.showErrorMessage(e.message);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cocosInspector.openDevTools', async () => {
            try {
                await runStartPreview(bridgeClient, context.extensionUri, { forceReload: true });
                const config = vscode.workspace.getConfiguration('cocosInspector');
                if (config.get<boolean>('previewInEditor') !== false) {
                    vscode.window.showInformationMessage('预览已在编辑器中打开。');
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(e.message);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cocosInspector.configureMcp', () => {
            const extRoot = context.extensionPath;
            const mcpPath = configureCursorMcp(extRoot);
            vscode.window.showInformationMessage(`已写入 Cursor MCP 配置: ${mcpPath}`);
        }),
    );

    void pickAndConnectInstance(false).catch(() => { /* 静默失败 */ });

    if (vscode.workspace.getConfiguration('cocosInspector').get<boolean>('bindPreviewToF5') !== false) {
        void vscode.commands.executeCommand('setContext', 'cocosInspector.bindPreviewToF5', true);
    }
}

export function deactivate(): void {
    statusBarItem?.dispose();
}
