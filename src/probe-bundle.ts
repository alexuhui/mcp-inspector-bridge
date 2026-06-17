import * as fs from 'fs';
import * as path from 'path';

export function buildWsBridgeBootstrap(port: number): string {
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

export function readProbeScript(): string {
    const probePath = path.join(__dirname, 'probe.js');
    if (!fs.existsSync(probePath)) return '';
    return fs.readFileSync(probePath, 'utf-8');
}

export function buildProbeInjectionTag(bridgePort: number): string {
    const bootstrap = buildWsBridgeBootstrap(bridgePort);
    const probe = readProbeScript();
    if (!probe) return '';
    return `<script>/* mcp-inspector-bridge probe */\n${bootstrap}\n${probe}\n</script>`;
}
