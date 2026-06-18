import * as vscode from 'vscode';
import { BridgeClient, configureCursorMcp } from './bridge/ws-client';
import { InspectorPanelProvider } from './panels/inspector-provider';
import { openPreviewInEditor } from './panels/preview-panel';

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

export function activate(context: vscode.ExtensionContext): void {
    bridgeClient = new BridgeClient();

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'cocosInspector.pickInstance';
    statusBarItem.text = '$(debug-disconnect) Cocos';
    statusBarItem.tooltip = 'Cocos MCP Inspector — 点击选择实例';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    const provider = new InspectorPanelProvider(context.extensionUri, bridgeClient);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(InspectorPanelProvider.viewType, provider),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cocosInspector.open', () => {
            vscode.commands.executeCommand('cocosInspector.panel.focus');
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cocosInspector.openPreview', async () => {
            try {
                await openPreviewInEditor(bridgeClient, context.extensionUri);
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
                const config = vscode.workspace.getConfiguration('cocosInspector');
                const port = config.get<number>('bridgePort') || 0;
                await bridgeClient.connect(port);
                const info = await bridgeClient.getPreviewInfo();
                if (!info.previewUrl) {
                    throw new Error('预览地址为空，请先在 Creator 点击「预览运行」');
                }
                await vscode.env.openExternal(vscode.Uri.parse(info.previewUrl));
                vscode.window.showInformationMessage(
                    '已打开预览页。如需调试运行时，请在 Chrome 访问 chrome://inspect',
                );
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

    pickAndConnectInstance(false)
        .then(() => { /* 静默连接 */ })
        .catch(() => { /* 静默失败 */ });
}

export function deactivate(): void {
    statusBarItem?.dispose();
}
