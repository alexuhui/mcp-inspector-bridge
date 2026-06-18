declare global {
    interface Window {
        __MCP_DEBUG__?: boolean;
        __mcpInspector?: {
            sendLog?: (msg: string) => void;
        };
    }
}

function emit(level: 'log' | 'debug' | 'info' | 'warn' | 'error', args: any[], force = false) {
    const printer = console[level] || console.log;
    if (force || window.__MCP_DEBUG__ === true || level === 'error' || level === 'warn') {
        printer.apply(console, args as any);
    }
    try {
        const prefix = `[Probe][${level.toUpperCase()}]`;
        const text = [prefix].concat(args.map((a) => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch { return String(a); }
        })).join(' ');
        if (window.__mcpInspector && typeof window.__mcpInspector.sendLog === 'function') {
            window.__mcpInspector.sendLog(text);
        }
    } catch {
        // ignore
    }
}

export const Logger = {
    get isDebug(): boolean {
        return window.__MCP_DEBUG__ === true;
    },

    log(...args: any[]) {
        emit('log', args);
    },

    debug(...args: any[]) {
        emit('debug', args);
    },

    info(...args: any[]) {
        emit('info', args);
    },

    warn(...args: any[]) {
        emit('warn', args, true);
    },

    error(...args: any[]) {
        emit('error', args, true);
    }
};
