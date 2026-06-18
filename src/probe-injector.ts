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
    if (!silent) Editor.log('[ProbeInjector] 尝试寻找预览 WebContents');
    const wc = await resolvePreviewWebContents();
    if (!wc) {
        if (!silent) Editor.warn('[ProbeInjector] 未找到预览 WebContents');
        return false;
    }

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

        if (!silent) {
            Editor.log(`[ProbeInjector] 开始注入，wcId=${wcId}, bridgePort=${_bridgePort}`);
            Editor.log(`[ProbeInjector] wc url=${wc.getURL ? wc.getURL() : 'n/a'}`);
        }

        await wc.executeJavaScript(`console.info('[ProbeInjector] bootstrap inject start', { wcId: ${wcId}, bridgePort: ${_bridgePort} })`);
        await wc.executeJavaScript(bootstrap);
        await wc.executeJavaScript(`console.info('[ProbeInjector] ws bridge ready', { wcId: ${wcId}, bridgePort: ${_bridgePort} })`);
        await wc.executeJavaScript(probeContent);
        _lastInjectedWcId = wcId;

        try {
            await wc.executeJavaScript(`
                (function(){
                    console.info('[ProbeInjector] probe script loaded', { wcId: ${wcId}, bridgePort: ${_bridgePort} });
                    if (typeof window.__mcpSyncNodeTree === 'function') {
                        console.info('[ProbeInjector] trigger initial tree sync');
                        window.__mcpSyncNodeTree();
                    } else {
                        console.warn('[ProbeInjector] __mcpSyncNodeTree missing after injection');
                    }
                    if (window.__mcpInspector && typeof window.__mcpInspector.sendHandshake === 'function') {
                        try {
                            window.__mcpInspector.sendHandshake(JSON.stringify({ injected: true, wcId: ${wcId}, bridgePort: ${_bridgePort} }));
                            console.info('[ProbeInjector] handshake sent');
                        } catch (e) {
                            console.warn('[ProbeInjector] handshake failed', e && e.message ? e.message : e);
                        }
                    } else {
                        console.warn('[ProbeInjector] inspector bridge missing for handshake');
                    }
                })();
            `);
        } catch (e: any) {
            if (!silent) Editor.warn('[ProbeInjector] 注入后初始化失败:', e.message);
        }

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
