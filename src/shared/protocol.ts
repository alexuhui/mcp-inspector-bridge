/** WebSocket 桥接协议常量 — Creator 插件与 VS Code 扩展共享 */

export const DEFAULT_BRIDGE_PORT = 4456;
export const BRIDGE_PORT_MAX = 4556;
export const DEFAULT_PREVIEW_PORT = 7456;

export const TOOL_IPC_MAP: Record<string, string> = {
    'get_selected_node': 'mcp-query-selected-node',
    'capture_runtime_screenshot': 'mcp-capture-screenshot',
    'get_node_detail': 'mcp-query-node-detail',
    'update_node_property': 'mcp-update-property',
    'get_memory_ranking': 'mcp-query-memory',
    'simulate_input': 'mcp-simulate-input',
    'get_node_tree': 'mcp-query-tree',
    'get_runtime_logs': 'mcp-query-logs',
    'get_runtime_stats': 'mcp-query-stats',
    'install_script': 'mcp-script-install',
    'enable_script': 'mcp-script-enable',
    'disable_script': 'mcp-script-disable',
    'list_scripts': 'mcp-script-list',
    'refresh_preview': 'mcp-refresh-preview',
};

/** 可由主进程 runtime-relay 直接执行、无需面板 webview 的工具 */
export const RELAY_RUNTIME_TOOLS = new Set([
    'get_selected_node',
    'get_node_detail',
    'update_node_property',
    'get_memory_ranking',
    'simulate_input',
    'get_node_tree',
    'get_runtime_stats',
    'control_engine',
]);

/** 仍依赖 Creator 面板进程的工具（脚本系统、刷新预览 UI） */
export const PANEL_ONLY_TOOLS = new Set([
    'install_script',
    'enable_script',
    'disable_script',
    'list_scripts',
    'refresh_preview',
]);

export type ProbeEventChannel =
    | 'handshake'
    | 'update-tree'
    | 'update-env'
    | 'send-log'
    | 'render-debugger-payload'
    | 'node-picker-selected'
    | 'clear-selection';

export interface ProbeEventMessage {
    type: 'probe:event';
    channel: ProbeEventChannel;
    args: any[];
    timestamp: number;
}

export interface PreviewInfoPayload {
    type: 'preview/info';
    bridgePort: number;
    previewPort: number;
    previewUrl: string;
    projectPath: string;
    projectName: string;
    hasPreview: boolean;
}

/** 主进程向已连接探针页面发起 JS 执行的 RPC 超时（毫秒） */
export const PROBE_RPC_TIMEOUT_MS = 5000;

export interface ProbeRpcRequest {
    method: 'probe/rpc';
    id: string;
    code: string;
}

export interface ProbeRpcResponse {
    type: 'probe/rpc';
    id: string;
    result?: string;
    error?: string;
}
