import * as WebSocket from 'ws';
declare const Editor: any;

import { TOOL_IPC_MAP } from './shared/protocol';
import {
    canRelayTool,
    handleRelayTool,
    handleProbeEvent,
    findPreviewWebContents,
    getPreviewPort,
} from './runtime-relay';
import { forceInjectProbe } from './probe-injector';
import { getPreviewProxyUrl, isPreviewProxyRunning, startPreviewProxy, stopPreviewProxy } from './preview-proxy';
import { handleProbeRpcResponse, registerProbePeer, unregisterProbePeer } from './probe-rpc';

const CACHE: Record<string, { timestamp: number, data: any }> = {};
const subscribers = new Set<WebSocket.WebSocket>();

let _bridgePort = 4456;

function broadcast(event: object): void {
    const payload = JSON.stringify(event);
    for (const client of subscribers) {
        if (client.readyState === 1) {
            try { client.send(payload); } catch (e) { /* ignore */ }
        }
    }
}

function emitMcpLog(logItem: { type: string; time: string; content: string }): void {
    try {
        Editor.Ipc.sendToPanel('mcp-inspector-bridge', 'mcp-inspector-bridge:mcp-log', logItem);
    } catch (e) { /* panel 可能未打开 */ }
    broadcast({ eventType: 'mcp:log', ...logItem });
}

function dispatchToPanelWithTimeout(channel: string, args: any, timeoutMs = 3000): Promise<any> {
    return new Promise((resolve, reject) => {
        let isTimeout = false;
        const timer = setTimeout(() => {
            isTimeout = true;
            reject(new Error(`RPC_TIMEOUT: 面板在 ${timeoutMs}ms 内未响应`));
        }, timeoutMs);

        Editor.Ipc.sendToPanel('mcp-inspector-bridge', channel, args, (err: any, res: any) => {
            if (isTimeout) return;
            clearTimeout(timer);
            if (err) reject(err);
            else resolve(res);
        }, timeoutMs + 500);
    });
}

function buildPreviewInfo(): object {
    const projectPath = Editor.Project.path || '';
    const previewPort = getPreviewPort();
    const directUrl = `http://127.0.0.1:${previewPort}`;
    return {
        type: 'preview/info',
        bridgePort: _bridgePort,
        previewPort,
        previewUrl: directUrl,
        probeProxyUrl: isPreviewProxyRunning() ? getPreviewProxyUrl(_bridgePort) : null,
        projectPath,
        projectName: require('path').basename(projectPath),
        hasPreview: !!findPreviewWebContents(),
    };
}

function handleCaptureScreenshot(ws: WebSocket.WebSocket, reqId: string) {
    const targetWc = findPreviewWebContents();

    if (!targetWc) {
        const errText = "未能找到活跃的预览画面，请确认预览已运行。";
        emitMcpLog({ type: 'err', time: new Date().toLocaleTimeString(), content: `[capture_runtime_screenshot]\nError: ${errText}` });
        ws.send(JSON.stringify({
            jsonrpc: "2.0", id: reqId,
            result: { isError: true, content: [{ type: "text", text: errText }] }
        }));
        return;
    }

    const handleImage = (img: any) => {
        if (!img || img.isEmpty()) {
            const errText = "获取画面为空，可能处于后台";
            emitMcpLog({ type: 'err', time: new Date().toLocaleTimeString(), content: `[capture_runtime_screenshot]\nError: ${errText}` });
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: { isError: true, content: [{ type: "text", text: errText }] }}));
            return;
        }
        const dataUrl = img.toDataURL();
        const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");

        emitMcpLog({
            type: 'res',
            time: new Date().toLocaleTimeString(),
            content: `[capture_runtime_screenshot]\nResult: { type: "image", data: "${base64Data.substring(0, 100)}...[截断:${base64Data.length} chars]" }`
        });

        ws.send(JSON.stringify({
            jsonrpc: "2.0", id: reqId,
            result: {
                content: [
                    { type: "image", data: base64Data, mimeType: "image/png" },
                    { type: "text", text: "已截取当前 runtime 游戏视图。" }
                ]
            }
        }));
    };

    const result = targetWc.capturePage();
    if (result && typeof result.then === 'function') {
        result.then(handleImage).catch((e: any) => {
            emitMcpLog({ type: 'err', time: new Date().toLocaleTimeString(), content: `[capture_runtime_screenshot]\nError: 截图异常: ${e.message}` });
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: { isError: true, content: [{ type: "text", text: "截图异常: " + e.message }] }}));
        });
    } else if (result) {
        handleImage(result);
    }
}

async function dispatchToolCall(name: string, args: any, _reqId: string): Promise<{ contentText: string; isError: boolean }> {
    let relayErr: any = null;

    if (name === 'get_node_tree') {
        try {
            const panelRes = await dispatchToPanelWithTimeout('mcp-query-tree', args, 5000);
            if (panelRes && !panelRes.error) {
                return { contentText: JSON.stringify(panelRes.result || panelRes, null, 2), isError: false };
            }
            if (panelRes?.error) {
                relayErr = new Error(panelRes.error);
            }
        } catch {
            /* MCP 面板未打开 */
        }
    }

    if (canRelayTool(name)) {
        if (name === 'get_node_tree') {
            await forceInjectProbe();
        }

        try {
            const relayResult = await handleRelayTool(name, args);
            return { contentText: JSON.stringify(relayResult, null, 2), isError: false };
        } catch (e: any) {
            relayErr = relayErr || e;
            if (!TOOL_IPC_MAP[name]) {
                return { contentText: JSON.stringify({ error: relayErr.message }), isError: true };
            }
        }
    }

    const ipcChannel = TOOL_IPC_MAP[name];
    if (!ipcChannel) {
        return { contentText: JSON.stringify({ error: `Tool unknown: ${name}` }), isError: true };
    }

    try {
        const res = await dispatchToPanelWithTimeout(ipcChannel, args, 3000);
        if (!res || res.error) {
            const panelErr = (res && res.error) || 'Unknown IPC error';
            if (relayErr) {
                return { contentText: JSON.stringify({ error: relayErr.message, panelFallback: panelErr }), isError: true };
            }
            return { contentText: JSON.stringify({ error: panelErr }), isError: true };
        }
        return { contentText: JSON.stringify(res.result || res, null, 2), isError: false };
    } catch (panelErr: any) {
        const msg = relayErr ? relayErr.message : panelErr.message;
        return { contentText: JSON.stringify({ error: msg }), isError: true };
    }
}

export function getBridgePort(): number {
    return _bridgePort;
}

export function startMcpRouter(onStatusChange: (status: any) => void): { close: () => void } {
    let _wss: WebSocket.Server | null = null;
    _bridgePort = 4456;

    const tryListen = () => {
        try {
            _wss = new WebSocket.Server({ port: _bridgePort });

            _wss.on('error', (e: any) => {
                if (e.code === 'EADDRINUSE') {
                    _bridgePort++;
                    tryListen();
                } else {
                    onStatusChange({ active: false, port: _bridgePort, error: e.message || 'Unknown network error' });
                }
            });

            _wss.on('listening', () => {
                onStatusChange({ active: true, port: _bridgePort, error: '' });
                startPreviewProxy(_bridgePort, getPreviewPort);
            });

            _wss.on('connection', (ws) => {
                ws.on('close', () => {
                    subscribers.delete(ws);
                    unregisterProbePeer(ws);
                });

                ws.on('message', async (message) => {
                    try {
                        const data = JSON.parse(message.toString());

                        if (data.type === 'probe/rpc') {
                            handleProbeRpcResponse(data);
                            return;
                        }

                        if (data.type === 'probe:event') {
                            registerProbePeer(ws);
                            handleProbeEvent(data.channel, data.args || []);
                            broadcast(data);
                            return;
                        }

                        if (data.method === 'subscribe') {
                            subscribers.add(ws);
                            ws.send(JSON.stringify({ type: 'subscribed', bridgePort: _bridgePort }));
                            ws.send(JSON.stringify(buildPreviewInfo()));
                            return;
                        }

                        if (data.method === 'preview/info') {
                            const reqId = data.id || Date.now().toString();
                            ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: buildPreviewInfo() }));
                            return;
                        }

                        if (data.type === 'ping') {
                            emitMcpLog({ time: new Date().toLocaleTimeString(), type: 'req', content: `[System] ping` });

                            const projectPath = Editor.Project.path || 'Unknown';
                            const resPayload = {
                                type: 'pong',
                                port: _bridgePort,
                                projectPath: projectPath,
                                projectName: require('path').basename(projectPath)
                            };

                            emitMcpLog({ time: new Date().toLocaleTimeString(), type: 'res', content: `[System] pong\nResult: ${JSON.stringify(resPayload)}` });
                            ws.send(JSON.stringify(resPayload));
                            return;
                        }

                        if (data.method === 'tools/call' && data.params) {
                            const name = data.params.name;
                            const args = data.params.args || {};
                            const reqId = data.id || Date.now().toString();

                            emitMcpLog({
                                time: new Date().toLocaleTimeString(),
                                type: 'req',
                                content: `[${name}]\nArgs: ${JSON.stringify(args, null, 2)}`
                            });

                            if (name === 'capture_runtime_screenshot') {
                                handleCaptureScreenshot(ws, reqId);
                                return;
                            }

                            if (!TOOL_IPC_MAP[name] && name !== 'capture_runtime_screenshot' && !canRelayTool(name)) {
                                ws.send(JSON.stringify({
                                    jsonrpc: "2.0", id: reqId,
                                    result: { content: [{ type: "text", text: `Tool unknown: ${name}` }] }
                                }));
                                return;
                            }

                            if (name === 'get_runtime_logs') {
                                try {
                                    const directRes = await new Promise<any>((resolve, reject) => {
                                        const timer = setTimeout(() => reject(new Error('CDP 日志查询超时')), 3500);
                                        Editor.Ipc.sendToMain(
                                            'mcp-inspector-bridge:query-cdp-logs',
                                            args,
                                            (err: any, logData: any) => { clearTimeout(timer); err ? reject(err) : resolve(logData); },
                                            4000
                                        );
                                    });

                                    const contentText = JSON.stringify(directRes.result || directRes, null, 2);
                                    let finalContent = contentText;
                                    if (directRes._debug && (!directRes.result || directRes.result.length === 0)) {
                                        finalContent = JSON.stringify({
                                            logs: directRes.result,
                                            _debug: directRes._debug,
                                            _hint: 'attached=false 表示未找到预览页面或 debugger attach 失败',
                                        }, null, 2);
                                    }
                                    emitMcpLog({ time: new Date().toLocaleTimeString(), type: 'res', content: `[${name}]\nResult: ${finalContent.length > 500 ? finalContent.substring(0, 500) + '...[truncated]' : finalContent}` });
                                    ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: { content: [{ type: "text", text: finalContent }] } }));
                                    return;
                                } catch (err: any) {
                                    emitMcpLog({ time: new Date().toLocaleTimeString(), type: 'err', content: `[${name}]\nError: ${err.message}` });
                                    ws.send(JSON.stringify({
                                        jsonrpc: "2.0", id: reqId,
                                        result: { content: [{ type: "text", text: `CDP 日志不可用: ${err.message}` }], isError: true }
                                    }));
                                    return;
                                }
                            }

                            const cacheKey = `${name}_${JSON.stringify(args)}`;
                            if (name === 'get_node_tree' && CACHE[cacheKey] && Date.now() - CACHE[cacheKey].timestamp < 500) {
                                ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: CACHE[cacheKey].data }));
                                return;
                            }

                            try {
                                const { contentText, isError } = await dispatchToolCall(name, args, reqId);
                                const resultPayload = { content: [{ type: "text", text: contentText }], isError };
                                if (name === 'get_node_tree') {
                                    CACHE[cacheKey] = { timestamp: Date.now(), data: resultPayload };
                                }

                                const resText = contentText.length > 500 ? contentText.substring(0, 500) + '...[truncated:超长响应已截断]' : contentText;
                                emitMcpLog({ time: new Date().toLocaleTimeString(), type: isError ? 'err' : 'res', content: `[${name}]\nResult: ${resText}` });
                                ws.send(JSON.stringify({ jsonrpc: "2.0", id: reqId, result: resultPayload }));
                            } catch (err: any) {
                                emitMcpLog({ time: new Date().toLocaleTimeString(), type: 'err', content: `[${name}]\nError: ${err.message}` });
                                ws.send(JSON.stringify({
                                    jsonrpc: "2.0", id: reqId,
                                    result: { content: [{ type: "text", text: `Execution failed: ${err.message}` }] }
                                }));
                            }
                        }
                    } catch (e) { /* ignore malformed messages */ }
                });
            });
        } catch (err: any) {
            onStatusChange({ active: false, port: _bridgePort, error: err.message || 'Unknown error' });
        }
    };

    tryListen();

    return {
        close: () => {
            subscribers.clear();
            stopPreviewProxy();
            if (_wss) {
                try { _wss.close(); } catch (e) { /* ignore */ }
                _wss = null;
            }
        }
    };
}
