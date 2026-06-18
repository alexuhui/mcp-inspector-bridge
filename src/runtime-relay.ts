/**
 * 主进程运行时中继 — 通过 Electron webContents 直接操作预览页，
 * 使 MCP 工具在 Creator 面板未打开时仍可工作（headless / VS Code 扩展场景）。
 */
declare const Editor: any;

import { RELAY_RUNTIME_TOOLS } from './shared/protocol';
import { executeProbeRpc, executeProbeRpcBroadcast } from './probe-rpc';

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
        throw new Error('未找到可执行运行时代码的预览 WebContents（请确认预览已运行，或等待探针同步完成）');
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

export async function executeRuntimeJs(code: string, timeoutMs = 4000): Promise<any> {
    try {
        const r = await executeInPreview(code, timeoutMs);
        const parsed = typeof r === 'string' ? JSON.parse(r) : r;
        if (parsed && parsed.error) throw new Error(parsed.msg || parsed.error);
        return parsed;
    } catch {
        const r = await executeProbeRpc(code, timeoutMs);
        const parsed = typeof r === 'string' ? JSON.parse(r) : r;
        if (parsed && parsed.error) throw new Error(parsed.msg || parsed.error);
        return parsed;
    }
}

/** 预览 WebContents + 全部探针页双写（覆盖编辑器区预览与 Creator 内预览） */
export async function executeRuntimeJsBroadcast(code: string, timeoutMs = 4000): Promise<any> {
    const parsedResults: any[] = [];

    try {
        const r = await executeInPreview(code, timeoutMs);
        parsedResults.push(typeof r === 'string' ? JSON.parse(r) : r);
    } catch { /* preview WC 不可用 */ }

    try {
        const r = await executeProbeRpcBroadcast(code, timeoutMs);
        parsedResults.push(typeof r === 'string' ? JSON.parse(r) : r);
    } catch { /* 无探针 */ }

    const success = parsedResults.find((r) => r && r.success === true);
    if (success) return success;

    const withData = parsedResults.find((r) => r && !r.error);
    if (withData) return withData;

    const err = parsedResults.find((r) => r && r.error);
    if (err) throw new Error(err.msg || err.error);

    throw new Error('未找到可写入的游戏运行时（请确认预览已运行）');
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
                const parsed = await executeRuntimeJs(code, 6000);
                if (parsed && parsed.error) {
                    throw new Error(parsed.msg || parsed.error);
                }
                return parsed;
            } catch (e: any) {
                const cached = findNodeInTree(unwrapTreeNode(_nodeTreeCache), args.uuid);
                if (cached) {
                    const names: string[] = Array.isArray(cached.componentNames)
                        ? cached.componentNames
                        : (Array.isArray(cached.components) && typeof cached.components[0] === 'string' ? cached.components : []);
                    return {
                        id: cached.id,
                        name: cached.name,
                        active: cached.active,
                        activeInHierarchy: cached.activeInHierarchy,
                        x: cached.x ?? 0,
                        y: cached.y ?? 0,
                        width: cached.width,
                        height: cached.height,
                        components: names.map((name: string, i: number) => ({
                            name,
                            realIndex: i,
                            enabled: true,
                            properties: [],
                        })),
                        _fromCache: true,
                        _hint: '仅缓存摘要（无组件属性）。请确认 Creator 内预览正在运行且探针已连接。',
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
            const parsed = await executeRuntimeJsBroadcast(code, 6000);
            if (parsed && parsed.error) {
                throw new Error(parsed.msg || parsed.error);
            }
            if (!parsed || parsed.success !== true) {
                throw new Error('属性更新失败（组件或属性不存在）');
            }
            return parsed;
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
            const r = await executeRuntimeJsBroadcast(code, 6000);
            return typeof r === 'string' ? JSON.parse(r) : r;
        }
        case 'get_node_tree': {
            const maxDepth = typeof args.depth === 'number' ? args.depth : 3;
            const code = `
                (function(){
                    try {
                        var tree = null;
                        if (typeof window.__mcpSyncNodeTree === 'function') {
                            tree = window.__mcpSyncNodeTree();
                        }
                        if (!tree && window.__mcpLastTreePayload && window.__mcpLastTreePayload.tree) {
                            tree = window.__mcpLastTreePayload.tree;
                        }
                        if (!tree && window.__mcpCrawler && typeof window.__mcpCrawler.serializeSceneTree === 'function') {
                            tree = window.__mcpCrawler.serializeSceneTree();
                        }
                        if (!tree && window.cc && window.cc.director && typeof window.cc.director.getScene === 'function') {
                            var scene = window.cc.director.getScene();
                            if (scene && window.__mcpCrawler && typeof window.__mcpCrawler.findNodeByUuid === 'function') {
                                tree = window.__mcpCrawler.serializeSceneTree();
                            }
                        }
                        if (tree) return JSON.stringify({ ok: true, tree: tree });
                        return JSON.stringify({ ok: false, error: 'TREE_EMPTY', msg: '节点树尚未同步' });
                    } catch (e) {
                        return JSON.stringify({ ok: false, error: 'EXECUTION_FAILED', msg: e.message || String(e) });
                    }
                })();
            `;
            let parsed: any = null;
            try {
                parsed = await executeRuntimeJsBroadcast(code, 8000);
            } catch (e) {
                parsed = null;
            }
            const tree = parsed?.tree || parsed?.result?.tree || parsed;
            if (tree && !parsed?.error) {
                setNodeTreeCache(tree);
                return trimTree(JSON.parse(JSON.stringify(unwrapTreeNode(tree))), maxDepth);
            }

            const direct = await executeRuntimeJs(`
                (function(){
                    try {
                        if (window.__mcpCrawler && typeof window.__mcpCrawler.serializeSceneTree === 'function') {
                            var tree = window.__mcpCrawler.serializeSceneTree();
                            if (tree) return JSON.stringify({ ok: true, tree: tree });
                        }
                        return JSON.stringify({ ok: false, error: 'TREE_EMPTY', msg: '节点树尚未同步' });
                    } catch (e) {
                        return JSON.stringify({ ok: false, error: 'EXECUTION_FAILED', msg: e.message || String(e) });
                    }
                })();
            `, 8000);
            const directTree = direct?.tree || direct?.result?.tree || direct;
            if (!directTree || direct?.error) {
                throw new Error(direct?.msg || direct?.error || '节点树尚未同步');
            }
            setNodeTreeCache(directTree);
            return trimTree(JSON.parse(JSON.stringify(unwrapTreeNode(directTree))), maxDepth);
        }
        case 'control_engine': {
            const action = escapeJsString(String(args.action || 'toggle_pause'));
            const code = `
                (function(){
                    try {
                        var eng = window.cc;
                        if (!eng || !eng.game) return JSON.stringify({ error: 'Engine not ready' });
                        var a = '${action}';
                        if (a === 'toggle_pause') {
                            if (eng.game.isPaused()) eng.game.resume(); else eng.game.pause();
                            return JSON.stringify({ success: true, paused: eng.game.isPaused() });
                        }
                        if (a === 'pause') { eng.game.pause(); return JSON.stringify({ success: true, paused: true }); }
                        if (a === 'resume') { eng.game.resume(); return JSON.stringify({ success: true, paused: false }); }
                        if (a === 'step') {
                            if (!eng.game.isPaused()) eng.game.pause();
                            eng.game.step();
                            return JSON.stringify({ success: true, paused: true });
                        }
                        if (eng.audioEngine) {
                            if (a === 'mute_on') {
                                if (typeof eng.audioEngine.setMusicVolume === 'function') eng.audioEngine.setMusicVolume(0);
                                if (typeof eng.audioEngine.setEffectsVolume === 'function') eng.audioEngine.setEffectsVolume(0);
                                return JSON.stringify({ success: true, muted: true });
                            }
                            if (a === 'mute_off') {
                                if (typeof eng.audioEngine.setMusicVolume === 'function') eng.audioEngine.setMusicVolume(1);
                                if (typeof eng.audioEngine.setEffectsVolume === 'function') eng.audioEngine.setEffectsVolume(1);
                                return JSON.stringify({ success: true, muted: false });
                            }
                        }
                        return JSON.stringify({ error: 'Unknown action: ' + a });
                    } catch(e) { return JSON.stringify({ error: 'EXECUTION_FAILED', msg: e.message }); }
                })();
            `;
            const parsed = await executeRuntimeJs(code);
            if (parsed && parsed.error) throw new Error(parsed.msg || parsed.error);
            return parsed;
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
