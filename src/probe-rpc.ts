import { PROBE_RPC_TIMEOUT_MS, ProbeRpcResponse } from './shared/protocol';

const probePeers = new Set<any>();
const pendingRpc = new Map<string, {
    resolve: (value: string) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}>();

let rpcSeq = 0;

export function registerProbePeer(ws: any): void {
    probePeers.add(ws);
}

export function unregisterProbePeer(ws: any): void {
    probePeers.delete(ws);
}

export function handleProbeRpcResponse(data: ProbeRpcResponse): boolean {
    const pending = pendingRpc.get(data.id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingRpc.delete(data.id);
    if (data.error) {
        pending.reject(new Error(data.error));
    } else {
        pending.resolve(data.result ?? '');
    }
    return true;
}

export function executeProbeRpc(code: string, timeoutMs = PROBE_RPC_TIMEOUT_MS): Promise<string> {
    const clients = [...probePeers].filter((ws) => ws.readyState === 1);
    if (clients.length === 0) {
        return Promise.reject(new Error('无已连接的探针客户端'));
    }
    const ws = clients[clients.length - 1];
    const id = `rpc-${++rpcSeq}-${Date.now()}`;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingRpc.delete(id);
            reject(new Error('探针 RPC 超时'));
        }, timeoutMs);

        pendingRpc.set(id, { resolve, reject, timer });

        try {
            ws.send(JSON.stringify({ method: 'probe/rpc', id, code }));
        } catch (e: any) {
            clearTimeout(timer);
            pendingRpc.delete(id);
            reject(e instanceof Error ? e : new Error(String(e)));
        }
    });
}
