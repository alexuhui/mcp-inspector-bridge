import * as vscode from 'vscode';
import * as path from 'path';
import { BridgeClient, configureCursorMcp } from './bridge/ws-client';
import { InspectorPanelProvider } from './panels/inspector-provider';

let statusBarItem: vscode.StatusBarItem;
let bridgeClient: BridgeClient;

export function activate(context: vscode.ExtensionContext): void {
    bridgeClient = new BridgeClient();

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'cocosInspector.connect';
    statusBarItem.text = '$(debug-disconnect) Cocos';
    statusBarItem.tooltip = 'Cocos MCP Inspector — 点击连接';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    const provider = new InspectorPanelProvider(context.extensionUri, bridgeClient);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(InspectorPanelProvider.viewType, provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cocosInspector.open', () => {
            vscode.commands.executeCommand('cocosInspector.panel.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cocosInspector.connect', async () => {
            try {
                const config = vscode.workspace.getConfiguration('cocosInspector');
                const port = config.get<number>('bridgePort') || 0;
                const inst = await bridgeClient.connect(port);
                statusBarItem.text = `$(debug-start) Cocos: ${inst.projectName}`;
                statusBarItem.tooltip = `已连接 :${inst.port}\n${inst.projectPath}`;
                vscode.window.showInformationMessage(`已连接 Cocos Bridge: ${inst.projectName} (:${inst.port})`);
            } catch (e: any) {
                statusBarItem.text = '$(debug-disconnect) Cocos';
                vscode.window.showErrorMessage(e.message);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cocosInspector.configureMcp', () => {
            const extRoot = context.extensionPath;
            const mcpPath = configureCursorMcp(extRoot);
            vscode.window.showInformationMessage(`已写入 Cursor MCP 配置: ${mcpPath}`);
        })
    );

    // 启动时尝试静默连接
    bridgeClient.connect(vscode.workspace.getConfiguration('cocosInspector').get<number>('bridgePort') || 0)
        .then((inst) => {
            statusBarItem.text = `$(debug-start) Cocos: ${inst.projectName}`;
        })
        .catch(() => { /* 静默失败 */ });
}

export function deactivate(): void {
    statusBarItem?.dispose();
}
