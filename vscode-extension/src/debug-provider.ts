import * as vscode from 'vscode';
import { BridgeClient } from './bridge/ws-client';
import { isCocosProjectWorkspace, runStartPreview } from './start-preview';

export const COCOS_DEBUG_TYPE = 'cocos-mcp-inspector';

const DEFAULT_CONFIG: vscode.DebugConfiguration = {
    type: COCOS_DEBUG_TYPE,
    request: 'launch',
    name: 'Cocos Preview in Editor',
};

function shouldInterceptDebug(config: vscode.DebugConfiguration): boolean {
    const bindToF5 = vscode.workspace.getConfiguration('cocosInspector').get<boolean>('bindPreviewToF5') !== false;
    return bindToF5 && config.type === COCOS_DEBUG_TYPE;
}

export function registerCocosPreviewDebugProvider(
    context: vscode.ExtensionContext,
    bridge: BridgeClient,
): void {
    const provider: vscode.DebugConfigurationProvider = {
        provideDebugConfigurations(): vscode.DebugConfiguration[] {
            if (!isCocosProjectWorkspace()) {
                return [];
            }
            return [{ ...DEFAULT_CONFIG }];
        },

        resolveDebugConfiguration(
            _folder: vscode.WorkspaceFolder | undefined,
            config: vscode.DebugConfiguration,
        ): vscode.ProviderResult<vscode.DebugConfiguration> {
            if (!shouldInterceptDebug(config)) {
                return config;
            }
            const extensionUri = context.extensionUri;
            void runStartPreview(bridge, extensionUri).catch((e: Error) => {
                void vscode.window.showErrorMessage(e.message);
            });
            // 中止调试会话，仅借用 F5 / 调试入口触发预览
            return undefined;
        },
    };

    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider(COCOS_DEBUG_TYPE, provider),
        vscode.debug.registerDebugConfigurationProvider(
            COCOS_DEBUG_TYPE,
            provider,
            vscode.DebugConfigurationProviderTriggerKind.Initial,
        ),
    );
}
