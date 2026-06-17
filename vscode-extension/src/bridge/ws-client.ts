import WebSocket from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const DEFAULT_PORT = 4456;
const MAX_PORT = 4556;

export interface BridgeInstance {
    port: number;
    projectName: string;
    projectPath: string;
}

export interface PreviewInfo {
    bridgePort: number;
    previewPort: number;
    previewUrl: string;
    projectPath: string;
    projectName: string;
    hasPreview: boolean;
}

export class BridgeClient {
    private port: number | null = null;
    private subscribers: Array<(msg: any) => void> = [];
    private ws: WebSocket | null = null;

    get activePort(): number | null {
        return this.port;
    }

    async scanInstances(): Promise<BridgeInstance[]> {
        const results: BridgeInstance[] = [];
        const promises: Promise<void>[] = [];

        for (let p = DEFAULT_PORT; p <= MAX_PORT; p++) {
            promises.push(new Promise((resolve) => {
                let done = false;
                const ws = new WebSocket(`ws://127.0.0.1:${p}`);
                const timer = setTimeout(() => {
                    if (!done) { done = true; try { ws.close(); } catch (_) {} resolve(); }
                }, 600);

                ws.on('open', () => ws.send(JSON.stringify({ type: 'ping' })));
                ws.on('message', (data) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        if (msg.type === 'pong') {
                            done = true;
                            clearTimeout(timer);
                            results.push({ port: p, projectName: msg.projectName, projectPath: msg.projectPath });
                            try { ws.close(); } catch (_) {}
                            resolve();
                        }
                    } catch (_) { resolve(); }
                });
                ws.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(); } });
            }));
        }

        await Promise.all(promises);
        return results;
    }

    async connect(preferredPort = 0): Promise<BridgeInstance> {
        if (preferredPort > 0) {
            const inst = await this.ping(preferredPort);
            if (inst) {
                this.port = preferredPort;
                return inst;
            }
        }

        const instances = await this.scanInstances();
        if (instances.length === 0) {
            throw new Error('未找到运行中的 mcp-inspector-bridge（请确认 Cocos Creator 已打开项目）');
        }
        if (instances.length > 1 && preferredPort === 0) {
            throw new Error(
                `检测到多个实例，请设置 cocosInspector.bridgePort：\n` +
                instances.map(i => `- ${i.port}: ${i.projectName}`).join('\n')
            );
        }
        this.port = instances[0].port;
        return instances[0];
    }

    private ping(port: number): Promise<BridgeInstance | null> {
        return new Promise((resolve) => {
            let done = false;
            const ws = new WebSocket(`ws://127.0.0.1:${port}`);
            const timer = setTimeout(() => {
                if (!done) { done = true; try { ws.close(); } catch (_) {} resolve(null); }
            }, 800);
            ws.on('open', () => ws.send(JSON.stringify({ type: 'ping' })));
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === 'pong') {
                        done = true;
                        clearTimeout(timer);
                        try { ws.close(); } catch (_) {}
                        resolve({ port, projectName: msg.projectName, projectPath: msg.projectPath });
                    }
                } catch (_) { resolve(null); }
            });
            ws.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
        });
    }

    async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
        if (!this.port) await this.connect();
        const port = this.port!;

        return new Promise((resolve, reject) => {
            let done = false;
            const reqId = Date.now().toString();
            const ws = new WebSocket(`ws://127.0.0.1:${port}`);
            const timer = setTimeout(() => {
                if (!done) { done = true; try { ws.close(); } catch (_) {} reject(new Error('Bridge 响应超时')); }
            }, 8000);

            ws.on('open', () => {
                ws.send(JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'tools/call',
                    params: { name, args },
                    id: reqId,
                }));
            });
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id === reqId && msg.jsonrpc === '2.0') {
                        done = true;
                        clearTimeout(timer);
                        try { ws.close(); } catch (_) {}
                        resolve(msg.result);
                    }
                } catch (_) { /* ignore */ }
            });
            ws.on('error', (err) => {
                if (!done) { done = true; clearTimeout(timer); reject(err); }
            });
        });
    }

    async getPreviewInfo(): Promise<PreviewInfo> {
        if (!this.port) await this.connect();
        const port = this.port!;

        return new Promise((resolve, reject) => {
            let done = false;
            const reqId = Date.now().toString();
            const ws = new WebSocket(`ws://127.0.0.1:${port}`);
            const timer = setTimeout(() => {
                if (!done) { done = true; try { ws.close(); } catch (_) {} reject(new Error('preview/info 超时')); }
            }, 5000);

            ws.on('open', () => {
                ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'preview/info', id: reqId }));
            });
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.id === reqId) {
                        done = true;
                        clearTimeout(timer);
                        try { ws.close(); } catch (_) {}
                        resolve(msg.result as PreviewInfo);
                    }
                } catch (_) { /* ignore */ }
            });
            ws.on('error', (err) => {
                if (!done) { done = true; clearTimeout(timer); reject(err); }
            });
        });
    }

    subscribe(onMessage: (msg: any) => void): () => void {
        this.subscribers.push(onMessage);
        const port = this.port;

        const connect = () => {
            if (!port) return;
            if (this.ws) {
                try { this.ws.close(); } catch (_) {}
            }
            this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
            this.ws.on('open', () => {
                this.ws?.send(JSON.stringify({ method: 'subscribe' }));
            });
            this.ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    for (const fn of this.subscribers) fn(msg);
                } catch (_) { /* ignore */ }
            });
            this.ws.on('close', () => setTimeout(connect, 2000));
        };

        if (port) connect();

        return () => {
            this.subscribers = this.subscribers.filter((fn) => fn !== onMessage);
            if (this.subscribers.length === 0 && this.ws) {
                try { this.ws.close(); } catch (_) {}
                this.ws = null;
            }
        };
    }
}

export function configureCursorMcp(extensionRoot: string): string {
    const mcpClientPath = path.join(extensionRoot, '..', 'dist', 'mcp-client', 'index.js').replace(/\\/g, '/');
    const cursorMcpPath = path.join(os.homedir(), '.cursor', 'mcp.json');

    let config: any = { mcpServers: {} };
    if (fs.existsSync(cursorMcpPath)) {
        try {
            config = JSON.parse(fs.readFileSync(cursorMcpPath, 'utf-8'));
            if (!config.mcpServers) config.mcpServers = {};
        } catch (_) { /* use default */ }
    }

    config.mcpServers['cocos-inspector-bridge'] = {
        command: 'node',
        args: [mcpClientPath],
    };

    const dir = path.dirname(cursorMcpPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cursorMcpPath, JSON.stringify(config, null, 2), 'utf-8');
    return cursorMcpPath;
}
