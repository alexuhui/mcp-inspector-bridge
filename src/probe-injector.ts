/**
 * 主进程全局探针注入器 — 向 Creator 预览 WebContents 注入 probe.js，
 * 并挂载 WebSocket 事件通道（供 VS Code 扩展 / headless 模式使用）。
 */
declare const Editor: any;

import * as fs from 'fs';
import * as path from 'path';
import { findPreviewWebContents, getPreviewPort, resolvePreviewWebContents } from './runtime-relay';
import { buildWsBridgeBootstrap, readProbeScript } from './probe-bundle';

let _injectTimer: any = null;
let _bridgePort = 4456;
let _lastInjectedWcId: number | null = null;

function buildWsBridgeBootstrapLocal(port: number): string {
    return buildWsBridgeBootstrap(port);
}

async function injectProbeIfNeeded(silent = true): Promise<boolean> {
    const wc = await resolvePreviewWebContents();
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
        const probeContent = readProbeScript();
        const bootstrap = buildWsBridgeBootstrapLocal(_bridgePort);

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
