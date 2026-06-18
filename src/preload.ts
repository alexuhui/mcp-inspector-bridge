const { ipcRenderer } = require('electron');

/**
 * 注入到 Webview 的预加载脚本 (Preload.js)
 * 在沙盒环境与主/面板进程间充当网桥
 *
 * 【Phase 4 重构】移除了错误的 isTopFrame 分流逻辑。
 * Cocos Creator 2.4.x 的预览页面没有子 iframe，cc 引擎直接运行在顶层 window 中。
 * 因此 preload 必须在顶层直接挂载通信桥 + 注入探针。
 */
window.addEventListener('DOMContentLoaded', () => {
    // 顶层预览页直接注入探针和通信桥；不再依赖 Creator 面板存在。
    const applyBaseStyles = () => {
        const style = document.createElement('style');
        style.type = 'text/css';
        style.innerHTML = `
            .toolbar { display: none !important; opacity: 0 !important; height: 0 !important; }
            .content { top: 0px !important; bottom: 0px !important; padding: 0 !important; border: none !important; margin: 0 !important; height: 100% !important; }
            body, html { overflow: hidden !important; background: transparent !important; }
            .content, .contentWrap, .wrapper, #GameDiv {
                width: 100% !important;
                height: 100% !important;
                max-width: 100vw !important;
                max-height: 100vh !important;
                overflow: hidden !important;
                margin: 0 !important;
                padding: 0 !important;
                box-sizing: border-box !important;
            }
            #GameCanvas {
                max-width: 100% !important;
                max-height: 100% !important;
            }
            *::-webkit-scrollbar {
                display: none !important;
                width: 0 !important;
                height: 0 !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    };

    applyBaseStyles();

    const api = {
        ready: false,
        updateTree: (treeData: string) => ipcRenderer.sendToHost('update-tree', treeData),
        updateEnv: (envData: any) => ipcRenderer.sendToHost('update-env', envData),
        sendLog: (logData: string) => ipcRenderer.sendToHost('send-log', logData),
        sendHandshake: (info: any) => ipcRenderer.sendToHost('handshake', info),
        sendRenderDebuggerPayload: (payload: any) => ipcRenderer.sendToHost('render-debugger-payload', payload),
        sendNodeSelected: (uuid: string) => ipcRenderer.sendToHost('node-picker-selected', uuid),
        sendClearSelection: () => ipcRenderer.sendToHost('clear-selection'),
    };

    (window as any).__mcpInspector = api;

    ipcRenderer.on('macro-command', (_event: any, cmd: string) => {
        // @ts-ignore
        if (typeof window.cc === 'undefined' || !window.cc.game) {
            console.warn('[Webview Preload] 引擎 cc 尚未就绪，忽略指令', cmd);
            return;
        }

        // @ts-ignore
        const engine = window.cc;

        switch (cmd) {
            case 'pause':
                if (engine.game.isPaused()) engine.game.resume();
                else engine.game.pause();
                break;
            case 'step':
                engine.game.step();
                break;
            case 'fps':
                engine.debug.setDisplayStats(!engine.debug.isDisplayStats());
                break;
        }
    });

    try {
        const fs = require('fs');
        const path = require('path');
        const crawlerContent = fs.readFileSync(path.join(__dirname, 'probe.js'), 'utf-8');
        const crawlerScript = document.createElement('script');
        crawlerScript.textContent = crawlerContent;
        (document.head || document.documentElement).appendChild(crawlerScript);
        api.ready = true;
        ipcRenderer.sendToHost('preload-ready', { ready: true });
    } catch (err) {
        console.error('[Webview Preload] 无法注入 probe.js:', err);
        ipcRenderer.sendToHost('preload-ready', { ready: false, error: String(err) });
    }
});
