/**
 * 预览 HTTP 代理 — 可选；在 HTML 中注入外部探针脚本（供无 Creator WebContents 时同步节点树）。
 */
declare const Editor: any;

import * as http from 'http';
import { buildWsBridgeBootstrap, readProbeScript } from './probe-bundle';

const PROXY_PORT_OFFSET = 1000;
const INJECT_PATH = '/__mcp__/inject.js';

let _server: http.Server | null = null;
let _proxyPort = 0;
let _bridgePort = 4456;
let _getPreviewPort: () => number = () => 7456;
let _injectScriptCache = '';

function rebuildInjectCache(bridgePort: number): string {
    const probe = readProbeScript();
    if (!probe) return '';
    return `${buildWsBridgeBootstrap(bridgePort)}\n${probe}`;
}

function injectProbeIntoHtml(html: string): string {
    // 游戏主循环启动后再异步注入 slim 探针，避免同步脚本阻断 WebGL 初始化
    const tag = `<script>(function(){
  function loadProbe(){
    window.__MCP_SLIM_MODE__=true;
    var s=document.createElement('script');
    s.src='${INJECT_PATH}';
    s.async=true;
    (document.head||document.documentElement).appendChild(s);
  }
  function schedule(){ setTimeout(loadProbe,1800); }
  if(document.readyState==='complete') schedule();
  else window.addEventListener('load',schedule);
})();</script>`;
    if (/<\/body>/i.test(html)) {
        return html.replace(/<\/body>/i, `${tag}</body>`);
    }
    if (/<\/head>/i.test(html)) {
        return html.replace(/<\/head>/i, `${tag}</head>`);
    }
    return html + tag;
}

function stripEncodingHeaders(headers: http.OutgoingHttpHeaders): void {
    delete headers['content-encoding'];
    delete headers['Content-Encoding'];
    delete headers['content-length'];
    delete headers['Content-Length'];
    delete headers['transfer-encoding'];
    delete headers['Transfer-Encoding'];
}

function forwardToPreview(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    previewPort: number,
    bridgePort: number,
): void {
    const pathWithQuery = req.url || '/';

    const proxyReq = http.request(
        {
            hostname: '127.0.0.1',
            port: previewPort,
            path: pathWithQuery,
            method: req.method,
            headers: {
                ...req.headers,
                host: `127.0.0.1:${previewPort}`,
                'accept-encoding': 'identity',
            },
        },
        (proxyRes) => {
            const contentType = String(proxyRes.headers['content-type'] || '');
            const pathOnly = (pathWithQuery.split('?')[0] || '/');
            const statusOk = (proxyRes.statusCode || 0) >= 200 && (proxyRes.statusCode || 0) < 300;
            // 仅对主文档注入探针，避免把 404 HTML 误注入到 settings.js 等脚本响应
            const isMainHtml = req.method === 'GET'
                && statusOk
                && contentType.includes('text/html')
                && (pathOnly === '/' || pathOnly.endsWith('/index.html'));

            if (!isMainHtml) {
                res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
                proxyRes.pipe(res);
                return;
            }

            const chunks: Buffer[] = [];
            proxyRes.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            proxyRes.on('end', () => {
                try {
                    let body = Buffer.concat(chunks).toString('utf8');
                    if (_injectScriptCache) {
                        body = injectProbeIntoHtml(body);
                    }
                    const headers: http.OutgoingHttpHeaders = { ...proxyRes.headers };
                    stripEncodingHeaders(headers);
                    headers['content-length'] = Buffer.byteLength(body).toString();
                    res.writeHead(proxyRes.statusCode || 200, headers);
                    res.end(body);
                } catch (e: any) {
                    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    res.end(`Preview proxy error: ${e.message}`);
                }
            });
        },
    );

    proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`无法连接预览服务 (127.0.0.1:${previewPort}): ${err.message}`);
    });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.pipe(proxyReq);
    } else {
        proxyReq.end();
    }
}

export function getPreviewProxyPort(bridgePort: number): number {
    return bridgePort + PROXY_PORT_OFFSET;
}

export function getPreviewProxyUrl(bridgePort: number): string {
    return `http://127.0.0.1:${getPreviewProxyPort(bridgePort)}/`;
}

export function isPreviewProxyRunning(): boolean {
    return !!_server && _proxyPort > 0;
}

export function startPreviewProxy(bridgePort: number, getPreviewPort: () => number): void {
    stopPreviewProxy();
    _bridgePort = bridgePort;
    _getPreviewPort = getPreviewPort;
    _proxyPort = getPreviewProxyPort(bridgePort);
    _injectScriptCache = rebuildInjectCache(bridgePort);

    _server = http.createServer((req, res) => {
        const url = req.url || '/';

        if (url === INJECT_PATH || url.startsWith(INJECT_PATH + '?')) {
            if (!_injectScriptCache) {
                res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('probe.js not built');
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            res.end(_injectScriptCache);
            return;
        }

        forwardToPreview(req, res, _getPreviewPort(), _bridgePort);
    });

    _server.on('error', (err: any) => {
        if (typeof Editor !== 'undefined') {
            Editor.warn(`[PreviewProxy] 启动失败 port=${_proxyPort}:`, err.message);
        }
        _server = null;
        _proxyPort = 0;
    });

    _server.listen(_proxyPort, '127.0.0.1', () => {
        if (typeof Editor !== 'undefined') {
            Editor.log(`[PreviewProxy] 可选代理: ${getPreviewProxyUrl(bridgePort)} → 127.0.0.1:${getPreviewPort()}`);
        }
    });
}

export function stopPreviewProxy(): void {
    if (_server) {
        try { _server.close(); } catch { /* ignore */ }
        _server = null;
    }
    _proxyPort = 0;
    _injectScriptCache = '';
}
