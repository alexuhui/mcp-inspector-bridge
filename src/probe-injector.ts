/**
 * 主进程全局探针注入器 — 向 Creator 预览 WebContents 注入 probe.js，
 * 并挂载 WebSocket 事件通道（供 VS Code 扩展 / headless 模式使用）。
 */
declare const Editor: any;

import * as fs from 'fs';
import * as path from 'path';
import { findPreviewWebContents } from './runtime-relay';

let _injectTimer: any = null;
let _bridgePort = 4456;
let _lastInjectedWcId: number | null = null;

function buildWsBridgeBootstrap(port: number): string {
    return `
(function(){
    if (window.__mcpWsBridgeReady) return;
    window.__mcpWsBridgeReady = true;
    var BRIDGE_PORT = ${port};
    var ws = null;
    var queue = [];

    function connect() {
        try {
            ws = new WebSocket('ws://127.0.0.1:' + BRIDGE_PORT);
            ws.onopen = function() {
                ws.send(JSON.stringify({ method: 'subscribe' }));
                while (queue.length) ws.send(queue.shift());
            };
            ws.onclose = function() { setTimeout(connect, 2000); };
            ws.onerror = function() {};
        } catch(e) { setTimeout(connect, 2000); }
    }
    connect();

    function emit(channel, args) {
        var payload = JSON.stringify({ type: 'probe:event', channel: channel, args: args || [], timestamp: Date.now() });
        if (ws && ws.readyState === 1) ws.send(payload);
        else queue.push(payload);
    }

    if (!window.__mcpInspector) {
        window.__mcpInspector = {};
    }
    var base = window.__mcpInspector;
    window.__mcpInspector = {
        updateTree: function(d) {
            try { window.__mcpLastTreePayload = typeof d === 'string' ? JSON.parse(d) : d; } catch(e) {}
            if (base.updateTree) base.updateTree(d);
            emit('update-tree', [d]);
        },
        updateEnv: function(d) { if (base.updateEnv) base.updateEnv(d); emit('update-env', [d]); },
        sendLog: function(d) { if (base.sendLog) base.sendLog(d); emit('send-log', [d]); },
        sendHandshake: function(i) { if (base.sendHandshake) base.sendHandshake(i); emit('handshake', [i]); },
        sendRenderDebuggerPayload: function(p) { if (base.sendRenderDebuggerPayload) base.sendRenderDebuggerPayload(p); emit('render-debugger-payload', [p]); },
        sendNodeSelected: function(u) { if (base.sendNodeSelected) base.sendNodeSelected(u); emit('node-picker-selected', [u]); },
        sendClearSelection: function() { if (base.sendClearSelection) base.sendClearSelection(); emit('clear-selection', []); }
    };
})();
`;
}

async function injectProbeIfNeeded(silent = true): Promise<boolean> {
    const wc = findPreviewWebContents();
    if (!wc) return false;

    const wcId = wc.id;
    try {
        const status: string = await wc.executeJavaScript(`
            JSON.stringify({ probe: !!window.__mcpProbeInitialized, bridge: !!window.__mcpWsBridgeReady })
        `);
        const parsed = JSON.parse(status);
        if (parsed.probe && parsed.bridge && _lastInjectedWcId === wcId) {
            return true;
        }
    } catch {
        // 页面可能尚未就绪，继续尝试注入
    }

    try {
        const probePath = path.join(__dirname, 'probe.js');
        if (!fs.existsSync(probePath)) {
            if (!silent) Editor.warn('[ProbeInjector] probe.js 不存在，请先 npm run build');
            return false;
        }
        const probeContent = fs.readFileSync(probePath, 'utf-8');
        const bootstrap = buildWsBridgeBootstrap(_bridgePort);

        await wc.executeJavaScript(bootstrap);
        await wc.executeJavaScript(probeContent);
        _lastInjectedWcId = wcId;

        try {
            await wc.executeJavaScript(`
                (function(){
                    if (typeof window.__mcpSyncNodeTree === 'function') {
                        window.__mcpSyncNodeTree();
                    }
                })();
            `);
        } catch { /* scene may not be ready yet */ }

        if (!silent) Editor.log(`[ProbeInjector] 已向预览页注入探针 (wcId=${wcId}, bridgePort=${_bridgePort})`);
        return true;
    } catch (e: any) {
        if (!silent) Editor.warn('[ProbeInjector] 注入失败:', e.message);
        return false;
    }
}

export function startProbeInjector(bridgePort: number): void {
    _bridgePort = bridgePort;
    stopProbeInjector();
    _injectTimer = setInterval(() => {
        injectProbeIfNeeded(true).catch(() => {});
    }, 1500);
}

export function stopProbeInjector(): void {
    if (_injectTimer) {
        clearInterval(_injectTimer);
        _injectTimer = null;
    }
}

export async function forceInjectProbe(): Promise<boolean> {
    return injectProbeIfNeeded(false);
}
