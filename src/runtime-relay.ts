/**
 * 主进程运行时中继 — 通过 Electron webContents 直接操作预览页，
 * 使 MCP 工具在 Creator 面板未打开时仍可工作（headless / VS Code 扩展场景）。
 */
declare const Editor: any;

import { RELAY_RUNTIME_TOOLS } from './shared/protocol';

let _nodeTreeCache: any = null;
let _handshakeInfo: any = null;

function isPreviewUrl(url: string): boolean {
    if (!url || url === 'about:blank') return false;
    if (url.includes('inspector') || url.startsWith('chrome-extension')) return false;
    return /https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/i.test(url);
}

export function findPreviewWebContents(): any | null {
    try {
        const { webContents } = require('electron');
        const previewPort = getPreviewPort();
        const all = webContents.getAllWebContents();
        const candidates = all.filter((w: any) => {
            if (w.isDestroyed?.()) return false;
            const u = w.getURL();
            if (u && u !== 'about:blank') {
                if (u.includes('inspector') || u.startsWith('chrome-extension')) return false;
                if (isPreviewUrl(u)) return true;
            }
            if (w.getType?.() === 'webview') return true;
            return false;
        });
        const withScene = candidates.filter((w: any) => {
            const u = w.getURL() || '';
            return !u.includes('devtools');
        });
        const portMatch = withScene.find((w: any) => {
            const u = w.getURL() || '';
            return u.includes(`:${previewPort}`);
        });
        if (portMatch) return portMatch;
        const webview = withScene.find((w: any) => w.getType?.() === 'webview');
        if (webview) return webview;
        return withScene[0] || null;
    } catch {
        return null;
    }
}

function getPanelWebContentsFromIpc(): Promise<any | null> {
    return new Promise((resolve) => {
        if (typeof Editor === 'undefined') {
            resolve(null);
            return;
        }
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                resolve(null);
            }
        }, 1000);
        try {
            Editor.Ipc.sendToPanel('mcp-inspector-bridge', 'mcp-get-webcontents-id', {}, (err: any, res: any) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (err || !res?.id) {
                    resolve(null);
                    return;
                }
                try {
                    const { webContents } = require('electron');
                    resolve(webContents.fromId(res.id) || null);
                } catch {
                    resolve(null);
                }
            });
        } catch {
            clearTimeout(timer);
            resolve(null);
        }
    });
}

export async function resolvePreviewWebContents(): Promise<any | null> {
    const fromPanel = await getPanelWebContentsFromIpc();
    if (fromPanel && !fromPanel.isDestroyed?.()) return fromPanel;
    const withScene = await findPreviewWebContentsWithScene();
    if (withScene) return withScene;
    return findPreviewWebContents();
}

async function findPreviewWebContentsWithScene(): Promise<any | null> {
    try {
        const { webContents } = require('electron');
        const candidates = webContents.getAllWebContents().filter((w: any) => {
            if (w.isDestroyed?.()) return false;
            return isPreviewUrl(w.getURL()) && !w.getURL().includes('devtools');
        });
        for (const wc of candidates) {
            try {
                const ready = await wc.executeJavaScript(`
                    !!(window.cc && window.cc.director && window.cc.director.getScene())
                `);
                if (ready) return wc;
            } catch { /* page not ready */ }
        }
        return candidates[0] || null;
    } catch {
        return null;
    }
}

export async function executeInPreview(code: string, timeoutMs = 4000): Promise<any> {
    const wc = await resolvePreviewWebContents();
    if (!wc) {
        throw new Error('未找到 Creator 内预览 WebContents（外部预览请依赖探针 WebSocket 同步）');
    }
    const result = wc.executeJavaScript(code);
    if (!result || typeof result.then !== 'function') {
        return result;
    }
    return Promise.race([
        result,
        new Promise((_, reject) => setTimeout(() => reject(new Error('预览页 JS 执行超时')), timeoutMs)),
    ]);
}

export function setNodeTreeCache(tree: any): void {
    _nodeTreeCache = unwrapTreeNode(tree);
}

export function unwrapTreeNode(raw: any): any {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    if (raw.tree && typeof raw.tree === 'object' && !Array.isArray(raw.children)) {
        return raw.tree;
    }
    return raw;
}

export function getNodeTreeCache(): { tree: any } {
    return { tree: _nodeTreeCache };
}

export function setHandshakeInfo(info: any): void {
    _handshakeInfo = info;
}

export function getHandshakeInfo(): any {
    return _handshakeInfo;
}

function trimTree(node: any, maxDepth: number, currentDepth = 1): any {
    if (!node) return node;
    const cloned = { ...node };
    if (currentDepth >= maxDepth) {
        if (cloned.children && cloned.children.length > 0) {
            cloned.children = [`__TRUNCATED__ (hidden ${cloned.children.length} items, use depth > ${maxDepth} to view)`];
        }
    } else if (cloned.children && Array.isArray(cloned.children)) {
        cloned.children = cloned.children.map((c: any) => trimTree(c, maxDepth, currentDepth + 1));
    }
    return cloned;
}

function findNodeInTree(tree: any, uuid: string): any | null {
    if (!tree || typeof tree !== 'object') return null;
    if (tree.id === uuid) return tree;
    if (!Array.isArray(tree.children)) return null;
    for (const child of tree.children) {
        if (typeof child !== 'object' || child === null) continue;
        const found = findNodeInTree(child, uuid);
        if (found) return found;
    }
    return null;
}

function escapeJsString(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function canRelayTool(name: string): boolean {
    return RELAY_RUNTIME_TOOLS.has(name);
}

export async function handleRelayTool(name: string, args: any = {}): Promise<any> {
    switch (name) {
        case 'get_selected_node': {
            const code = `
                (function(){
                    if(!window.__mcpHighlightData || !window.__mcpHighlightData.selectId) return null;
                    if(!window.__mcpCrawler || typeof window.__mcpCrawler.getSimplifiedNode !== 'function') return null;
                    return JSON.stringify(window.__mcpCrawler.getSimplifiedNode(window.__mcpHighlightData.selectId));
                })();
            `;
            const res = await executeInPreview(code);
            return res ? JSON.parse(res) : null;
        }
        case 'get_node_detail': {
            const uuid = escapeJsString(args.uuid || '');
            const code = `
                (function(){
                    try {
                        if(!window.__mcpCrawler) return JSON.stringify({ error: 'Crawler not injected' });
                        var n = window.__mcpCrawler.findNodeByUuid('${uuid}');
                        if(!n) return JSON.stringify({ error: 'NODE_NOT_FOUND', msg: 'Node destroyed or not found' });
                        return JSON.stringify(window.__mcpCrawler.getNodeDetail('${uuid}'));
                    } catch(e) { return JSON.stringify({ error: 'EXECUTION_FAILED', msg: e.message }); }
                })();
            `;
            try {
                const r = await executeInPreview(code);
                return typeof r === 'string' ? JSON.parse(r) : r;
            } catch (e: any) {
                const cached = findNodeInTree(unwrapTreeNode(_nodeTreeCache), args.uuid);
                if (cached) {
                    return {
                        ...cached,
                        _fromCache: true,
                        _hint: '节点树缓存中的摘要信息；完整属性需 Creator 内预览或探针实时连接',
                    };
                }
                throw e;
            }
        }
        case 'update_node_property': {
            const uuid = escapeJsString(args.uuid || '');
            const compName = escapeJsString(args.compName || 'null');
            const propKey = escapeJsString(args.propKey || '');
            const compIndex = args.compIndex ?? -1;
            const code = `
                (function(){
                    try {
                        if(!window.__mcpCrawler) return JSON.stringify({ error: 'Crawler not injected' });
                        var n = window.__mcpCrawler.findNodeByUuid('${uuid}');
                        if(!n) return JSON.stringify({ error: 'NODE_NOT_FOUND', msg: 'Node destroyed or not found' });
                        var ok = window.__mcpCrawler.updateNodeProperty('${uuid}', '${compName}', '${propKey}', ${JSON.stringify(args.value)}, ${compIndex});
                        return JSON.stringify({ success: ok });
                    } catch(e) { return JSON.stringify({ error: 'EXECUTION_FAILED', msg: e.message }); }
                })();
            `;
            const r = await executeInPreview(code);
            return typeof r === 'string' ? JSON.parse(r) : r;
        }
        case 'get_memory_ranking': {
            const code = `
                (function(){
                    try {
                        if(typeof window.__mcpGetMemoryRanking !== 'function') return JSON.stringify({ error: 'Memory agent not injected' });
                        return JSON.stringify(window.__mcpGetMemoryRanking());
                    } catch(e) { return JSON.stringify({ error: 'EXECUTION_FAILED', msg: e.message }); }
                })();
            `;
            const r = await executeInPreview(code);
            return typeof r === 'string' ? JSON.parse(r) : r;
        }
        case 'simulate_input': {
            const code = `
                (function(){
                    try {
                        if(!window.__mcpCrawler) return JSON.stringify({ error: 'Crawler not injected' });
                        if(typeof window.__mcpCrawler.simulateInput !== 'function') return JSON.stringify({ error: 'simulateInput not implemented in probe' });
                        return JSON.stringify(window.__mcpCrawler.simulateInput(${JSON.stringify(args)}));
                    } catch(e) { return JSON.stringify({ error: 'EXECUTION_FAILED', msg: e.message }); }
                })();
            `;
            const r = await executeInPreview(code);
            return typeof r === 'string' ? JSON.parse(r) : r;
        }
        case 'get_runtime_stats': {
            const code = `
                (function(){
                    try {
                        if(typeof window.__mcpProfilerTick !== 'function') return JSON.stringify({ error: 'Profiler not injected' });
                        return JSON.stringify(window.__mcpProfilerTick());
                    } catch(e) { return JSON.stringify({ error: 'EXECUTION_FAILED', msg: e.message }); }
                })();
            `;
            const r = await executeInPreview(code);
            return typeof r === 'string' ? JSON.parse(r) : r;
        }
        case 'get_node_tree': {
            const maxDepth = typeof args.depth === 'number' ? args.depth : 3;
            let rawTree: any = unwrapTreeNode(_nodeTreeCache);
            if (rawTree) {
                const cloned = JSON.parse(JSON.stringify(rawTree));
                return trimTree(cloned, maxDepth);
            }

            const fetchCode = `
                (function(){
                    try {
                        if (typeof window.__mcpSyncNodeTree === 'function') {
                            window.__mcpSyncNodeTree();
                        }
                        if (window.__mcpLastTreePayload && window.__mcpLastTreePayload.tree) {
                            return JSON.stringify({ ok: true, tree: window.__mcpLastTreePayload.tree });
                        }
                        if (window.__mcpCrawler && typeof window.__mcpCrawler.serializeSceneTree === 'function') {
                            var tree = window.__mcpCrawler.serializeSceneTree();
                            if (tree) return JSON.stringify({ ok: true, tree: tree });
                        }
                        return JSON.stringify({ ok: false, error: 'TREE_EMPTY', msg: '节点树尚未同步' });
                    } catch (e) {
                        return JSON.stringify({ ok: false, error: 'EXECUTION_FAILED', msg: e.message || String(e) });
                    }
                })();
            `;

            const wc = await resolvePreviewWebContents();
            if (wc) {
                try {
                    const fetched = await executeInPreview(fetchCode, 8000);
                    if (typeof fetched === 'string') {
                        const parsed = JSON.parse(fetched);
                        if (parsed.ok && parsed.tree) {
                            rawTree = parsed.tree;
                            setNodeTreeCache(rawTree);
                        } else if (parsed.error && !rawTree) {
                            throw new Error(parsed.msg || parsed.error);
                        }
                    }
                } catch (e: any) {
                    if (!rawTree) throw e;
                }
            }

            if (!rawTree) {
                rawTree = unwrapTreeNode(_nodeTreeCache);
            }

            if (!rawTree) {
                throw new Error(
                    wc
                        ? '节点树尚未同步，请稍候点击「刷新节点树」'
                        : '节点树尚未同步。请打开 Creator 菜单「MCP 桥接器 → 开启运行时面板」并保持其中预览运行',
                );
            }

            const cloned = JSON.parse(JSON.stringify(rawTree));
            return trimTree(cloned, maxDepth);
        }
        default:
            throw new Error(`Relay 不支持工具: ${name}`);
    }
}

export function handleProbeEvent(channel: string, args: any[]): void {
    if (channel === 'update-tree' && args[0]) {
        try {
            const parsed = typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0];
            setNodeTreeCache(parsed);
        } catch (e: any) {
            if (typeof Editor !== 'undefined') Editor.warn('[RuntimeRelay] update-tree 解析失败:', e.message);
        }
    } else if (channel === 'handshake' && args[0]) {
        try {
            setHandshakeInfo(typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0]);
        } catch {
            setHandshakeInfo(args[0]);
        }
    }
}

export function getPreviewPort(): number {
    let port = 7456;
    try {
        if (typeof Editor !== 'undefined' && Editor.PreviewServer) {
            if ((Editor.PreviewServer as any)._previewPort) {
                port = (Editor.PreviewServer as any)._previewPort;
            }
        }
    } catch (e) { /* ignore */ }

    if (port === 7456) {
        try {
            const profile = Editor.Profile.load('profile://global/settings.json');
            if (profile && profile.data && profile.data['preview-port']) {
                port = profile.data['preview-port'];
            }
        } catch (e) { /* ignore */ }
    }
    return port;
}
