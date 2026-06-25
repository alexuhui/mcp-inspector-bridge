'use strict';
import * as WebSocket from 'ws';
// Removed Node path import; using custom getBaseName function
import { startMcpRouter } from './ipc-router';
import { startProbeInjector, stopProbeInjector } from './probe-injector';
declare const Editor: any;

let _isSceneActive = false;
let _sceneProbeTimer: any = null;

/** 通过 scene-script 探测编辑器是否已处于场景/预制体编辑态 */
function probeSceneActive(cb: (active: boolean) => void): void {
    try {
        Editor.Scene.callSceneScript('mcp-inspector-bridge', 'check-scene-active', {}, (err: any, result: any) => {
            cb(!err && !!result && result.active === true);
        });
    } catch (e) {
        cb(false);
    }
}

/** 同步场景激活状态并通知面板 */
function syncSceneActiveState(active: boolean): void {
    if (_isSceneActive === active) return;
    _isSceneActive = active;
    Editor.Ipc.sendToPanel('mcp-inspector-bridge', 'scene-status-changed', { active });
}

/** 启动后轮询补偿：项目恢复上次场景时 scene:ready 可能早于插件 load */
function startSceneActiveProbe(): void {
    if (_sceneProbeTimer) {
        clearInterval(_sceneProbeTimer);
        _sceneProbeTimer = null;
    }
    let attempts = 0;
    const tryProbe = () => {
        if (_isSceneActive) {
            if (_sceneProbeTimer) clearInterval(_sceneProbeTimer);
            _sceneProbeTimer = null;
            return;
        }
        probeSceneActive((active) => {
            if (active) {
                syncSceneActiveState(true);
                if (_sceneProbeTimer) clearInterval(_sceneProbeTimer);
                _sceneProbeTimer = null;
            }
        });
    };
    tryProbe();
    _sceneProbeTimer = setInterval(() => {
        attempts++;
        if (_isSceneActive || attempts >= 30) {
            clearInterval(_sceneProbeTimer);
            _sceneProbeTimer = null;
            return;
        }
        tryProbe();
    }, 1000);
}

/**
 * 跨平台路径 Basename 提取工具（不依赖 Node.js path 模块）
 * 用于在编辑器不同环境（Main/Render）下安全获取工程目录名
 * @param p 待处理的完整路径字符串
 * @returns 路径的最后一个片段（项目文件夹名称）
 */
function getBaseName(p: string): string {
  if (!p) return '';
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

let _wss: WebSocket.Server | null = null;
let _mcpStatus = { active: false, port: 4456, error: 'Initializing...' };
let _logHeartbeatTimer: any = null;

function isHeadlessMode(): boolean {
    try {
        const profile = Editor.Profile.load('profile://project/mcp-inspector-bridge.json', 'mcp-inspector-bridge');
        return profile.get('headless') === true;
    } catch (e) {
        return false;
    }
}

/**
 * mcp-inspector-bridge: 主进程入口
 */
module.exports = {
    load() {
        // [Backend] 启动时假定场景还未完全就绪，等待 scene:ready
        _isSceneActive = false;
        try {
            const router = startMcpRouter((status: any) => {
                _mcpStatus = { ...status, projectName: getBaseName(Editor.Project.path || ''), projectPath: Editor.Project.path || '' };
                Editor.Ipc.sendToPanel('mcp-inspector-bridge', 'mcp-status-changed', _mcpStatus);
                if (status.active) {
                    Editor.log(`[MCP] Bridge started on ws://localhost:${status.port}`);
                    startProbeInjector(status.port);
                } else if (status.error) {
                    Editor.error(`[MCP] WebSocket server error on port ${status.port}:`, status.error);
                }
            });
            (_wss as any) = router;
        } catch(err: any) {
            _mcpStatus = { active: false, port: 4456, error: err.message || 'Unknown error' };
            Editor.Ipc.sendToPanel('mcp-inspector-bridge', 'mcp-status-changed', _mcpStatus);
            Editor.error('[MCP] Failed to start WebSocket server:', err);
        }


        // 立即进入激进的全天候日志监听器自动注入探测（用于彻底捕获极早期的报错）
        _logHeartbeatTimer = setInterval(async () => {
            try {
                const { initCdpLogListener, getCdpStatus } = require('./cdp-log-listener');
                const status = getCdpStatus();
                if (!status.attached) {
                    await initCdpLogListener(true);
                }
            } catch (e) {}
        }, 1000);

        // headless 模式：不自动打开面板，仅后台运行 bridge
        if (!isHeadlessMode()) {
            // 非 headless 时保持原有行为（用户通过菜单打开面板）
        } else {
            Editor.log('[MCP] Headless 模式已启用，bridge 在后台运行，可使用 Cursor/VS Code 扩展连接');
        }
        startSceneActiveProbe();
    },

    unload() {
        if (_sceneProbeTimer) {
            clearInterval(_sceneProbeTimer);
            _sceneProbeTimer = null;
        }
        stopProbeInjector();
        if (_wss) {
            _wss.close();
            _wss = null;
        }
        if (_logHeartbeatTimer) {
            clearInterval(_logHeartbeatTimer);
            _logHeartbeatTimer = null;
        }
    },

    // 注册跨进程 IPC 消息侦听器
    messages: {
        'scene:ready'() {
            syncSceneActiveState(true);
        },
        'scene:reloading'() {
            syncSceneActiveState(false);
        },
        'scene:closed'() {
            syncSceneActiveState(false);
        },
        'open'() {
            if (isHeadlessMode()) {
                Editor.log('[MCP] Headless 模式：bridge 已在后台运行，无需打开 Creator 面板');
                return;
            }
            // 收到菜单指令，打开主面板
            Editor.Panel.open('mcp-inspector-bridge');
        },
        'query-scene-active'(event: any) {
            if (!event.reply) return;
            if (_isSceneActive) {
                event.reply(null, true);
                return;
            }
            probeSceneActive((active) => {
                if (active) syncSceneActiveState(true);
                event.reply(null, active);
            });
        },
        'query-mcp-status'(event: any) {
            if (event.reply) {
                event.reply(null, _mcpStatus);
            }
        },
        'query-node-tree'(event: any) {
            // 目前已经通过 probe/crawler 脚本使用了 setInterval 自动轮询并通过
            // __mcpInspector.updateTree 自动推送。
            // 这里保留该接口为下阶段“按需主动拉取”做能力支持，当面板明确通知主进程强制刷新时，从此处处理。
            // 由于当前插件直接使用 <webview> 或前端控制的 BrowserView，主进程暂只作转发标记即可。
            // 后续如有明确需求，此处可直接获取对应 webContents ID 执行 JS.
            if (event.reply) {
                event.reply(null, { status: "polling_active", msg: "已经由注入的爬虫自动同步数据" });
            }
        },
        'query-resolution'(event: any) {
            const profile = Editor.Profile.load('profile://project/mcp-inspector-bridge.json', 'mcp-inspector-bridge');
            const res = profile.get('last-resolution') || 'FIT';
            if (event.reply) {
                event.reply(null, res);
            }
        },
        'save-resolution'(event: any, value: string) {
            const profile = Editor.Profile.load('profile://project/mcp-inspector-bridge.json', 'mcp-inspector-bridge');
            profile.set('last-resolution', value);
            profile.save();
        },
        'query-fps'(event: any) {
            const profile = Editor.Profile.load('profile://project/mcp-inspector-bridge.json', 'mcp-inspector-bridge');
            const res = profile.get('show-fps');
            if (event.reply) {
                event.reply(null, res === undefined ? false : res);
            }
        },
        'save-fps'(event: any, value: boolean) {
            const profile = Editor.Profile.load('profile://project/mcp-inspector-bridge.json', 'mcp-inspector-bridge');
            profile.set('show-fps', value);
            profile.save();
        },
        'query-audio-mute'(event: any) {
            const profile = Editor.Profile.load('profile://project/mcp-inspector-bridge.json', 'mcp-inspector-bridge');
            const res = profile.get('audio-mute');
            if (event.reply) {
                event.reply(null, res === undefined ? false : res);
            }
        },
        'save-audio-mute'(event: any, value: boolean) {
            const profile = Editor.Profile.load('profile://project/mcp-inspector-bridge.json', 'mcp-inspector-bridge');
            profile.set('audio-mute', value);
            profile.save();
        },
        'query-headless'(event: any) {
            if (event.reply) event.reply(null, isHeadlessMode());
        },
        'save-headless'(event: any, value: boolean) {
            const profile = Editor.Profile.load('profile://project/mcp-inspector-bridge.json', 'mcp-inspector-bridge');
            profile.set('headless', !!value);
            profile.save();
            if (event.reply) event.reply(null, { success: true, headless: !!value });
        },
        'query-panel-width'(event: any) {
            const profile = Editor.Profile.load('profile://project/mcp-inspector-bridge.json', 'mcp-inspector-bridge');
            const res = profile.get('panel-width');
            if (event.reply) {
                event.reply(null, res === undefined ? 400 : res);
            }
        },
        'save-panel-width'(event: any, value: number) {
            const profile = Editor.Profile.load('profile://project/mcp-inspector-bridge.json', 'mcp-inspector-bridge');
            profile.set('panel-width', value);
            profile.save();
        },
        'query-preview-port'(event: any) {
            let port = 7456;
            
            try {
                if (typeof Editor !== 'undefined' && Editor.PreviewServer) {
                    if ((Editor.PreviewServer as any)._previewPort) {
                        port = (Editor.PreviewServer as any)._previewPort;
                    }
                }
            } catch(e) {}
            
            // 策略 2: profile 取值备用
            if (port === 7456) {
                try {
                    const profile = Editor.Profile.load('profile://global/settings.json');
                    if (profile && profile.data && profile.data['preview-port']) {
                        port = profile.data['preview-port'];
                    }
                } catch (e) {}
            }

            if (event.reply) {
                event.reply(null, port);
            }
        },
        'mcp-scan-clients'(event: any) {
            try {
                const { scanMcpClients } = require('./mcp-client/configurator');
                const list = scanMcpClients();
                if (event.reply) event.reply(null, list);
            } catch(e: any) {
                if (event.reply) event.reply(new Error("scan 出错: " + e.message));
            }
        },
        'mcp-get-payload'(event: any) {
            try {
                const { getPayload } = require('./mcp-client/configurator');
                const pl = getPayload();
                if (event.reply) event.reply(null, pl);
            } catch(e: any) {
                if (event.reply) event.reply(new Error("payload 出错: " + e.message));
            }
        },
        'mcp-inject-client'(event: any, clientId: number) {
            try {
                const { injectMcpConfig } = require('./mcp-client/configurator');
                const log = injectMcpConfig(clientId === -1 ? undefined : clientId);
                if (event.reply) event.reply(null, log);
            } catch (e: any) {
                if (event.reply) event.reply(null, "配置写入报错: " + e.message);
            }
        },
        // --- 用户脚本系统: 文件 I/O handlers ---
        'script-save-file'(event: any, args: { fileName: string; content: string }) {
            const fs = require('fs');
            const path = require('path');
            const extDir = path.join(Editor.Project.path || __dirname, 'extensions');
            if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });
            const filePath = path.join(extDir, args.fileName);
            fs.writeFileSync(filePath, args.content, 'utf-8');

            const profile = Editor.Profile.load('profile://project/mcp-scripts.json', 'mcp-inspector-bridge');
            const scripts = profile.get('scripts') || {};
            const key = args.fileName.replace(/\.user\.js$/i, '');
            scripts[key] = { enabled: true, installedAt: Date.now() };
            profile.set('scripts', scripts);
            profile.save();

            if (event.reply) event.reply(null, { success: true });
        },
        'script-set-enabled'(event: any, args: { fileName: string; enabled: boolean }) {
            const profile = Editor.Profile.load('profile://project/mcp-scripts.json', 'mcp-inspector-bridge');
            const scripts = profile.get('scripts') || {};
            const key = args.fileName.replace(/\.user\.js$/i, '');
            if (scripts[key]) {
                scripts[key].enabled = args.enabled;
            } else {
                scripts[key] = { enabled: args.enabled, installedAt: Date.now() };
            }
            try {
                profile.set('scripts', scripts);
                profile.save();
            } catch (e: any) {
                Editor.warn(`[Script] profile 写入失败: ${e.message}`);
            }
            if (event.reply) event.reply(null, { success: true });
        },
        'script-delete-file'(event: any, args: { fileName: string }) {
            const fs = require('fs');
            const path = require('path');
            const extDir = path.join(Editor.Project.path || __dirname, 'extensions');
            const filePath = path.join(extDir, args.fileName);
            try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}

            const profile = Editor.Profile.load('profile://project/mcp-scripts.json', 'mcp-inspector-bridge');
            const scripts = profile.get('scripts') || {};
            const key = args.fileName.replace(/\.user\.js$/i, '');
            delete scripts[key];
            profile.set('scripts', scripts);
            profile.save();

            if (event.reply) event.reply(null, { success: true });
        },
        'script-list-files'(event: any) {
            const fs = require('fs');
            const path = require('path');
            const extDir = path.join(Editor.Project.path || __dirname, 'extensions');
            if (!fs.existsSync(extDir)) { if (event.reply) event.reply(null, []); return; }
            const profile = Editor.Profile.load('profile://project/mcp-scripts.json', 'mcp-inspector-bridge');
            const scripts = profile.get('scripts') || {};
            const files = fs.readdirSync(extDir).filter((f: string) => f.endsWith('.user.js'));
            const result = files.map((f: string) => {
                const key = f.replace(/\.user\.js$/i, '');
                return { name: f, enabled: scripts[key]?.enabled !== false };
            });
            if (event.reply) event.reply(null, result);
        },
        'script-read-file'(event: any, args: { fileName: string }) {
            const fs = require('fs');
            const path = require('path');
            const extDir = path.join(Editor.Project.path || __dirname, 'extensions');
            const filePath = path.join(extDir, args.fileName);
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                if (event.reply) event.reply(null, { content });
            } catch (e: any) {
                if (event.reply) event.reply(null, { error: e.message });
            }
        },
        'script-import-dialog'(event: any) {
            const { dialog } = require('electron');
            const path = require('path');
            const fs = require('fs');
            const extDir = path.join(Editor.Project.path || __dirname, 'extensions');
            if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });

            dialog.showOpenDialog({
                title: '导入用户脚本',
                filters: [{ name: 'UserScript', extensions: ['js'] }],
                properties: ['openFile'],
            }).then((result: any) => {
                if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                    if (event.reply) event.reply(null, { canceled: true });
                    return;
                }
                const srcPath = result.filePaths[0];
                const fileName = path.basename(srcPath).replace(/\.js$/i, '.user.js');
                const destPath = path.join(extDir, fileName);
                fs.copyFileSync(srcPath, destPath);
                const content = fs.readFileSync(destPath, 'utf-8');
                if (event.reply) event.reply(null, { fileName, content });
            }).catch((e: any) => {
                if (event.reply) event.reply(null, { error: e.message });
            });
        },
        'script-export-file'(event: any, args: { fileName: string }) {
            const { dialog } = require('electron');
            const path = require('path');
            const fs = require('fs');
            const extDir = path.join(Editor.Project.path || __dirname, 'extensions');
            const srcPath = path.join(extDir, args.fileName);

            dialog.showSaveDialog({
                title: '导出用户脚本',
                defaultPath: args.fileName,
                filters: [{ name: 'UserScript', extensions: ['js'] }],
            }).then((result: any) => {
                if (result.canceled || !result.filePath) return;
                try { fs.copyFileSync(srcPath, result.filePath); } catch (_) {}
            }).catch(() => {});
        },
        'script-register-tool'(event: any, toolDef: any) {
            // 动态 MCP 工具注册预留（面板→主进程）
            if (event.reply) event.reply(null, { success: true });
        },
        'script-unregister-tool'(event: any, name: string) {
            if (event.reply) event.reply(null, { success: true });
        },

        'query-cdp-logs'(event: any, args: any) {
            // 懒启动 CDP 监听器（首次查询时自动 attach）
            async function handle() {
                try {
                    const { initCdpLogListener, getCdpLogs, getCdpStatus } = require('./cdp-log-listener');

                    const status = getCdpStatus();
                    if (!status.attached) {
                        const ok = await initCdpLogListener();
                        if (!ok) {
                            Editor.log('[CDP Log] 懒启动未找到预览页面 WebContents');
                        }
                    }

                    if (event.reply) {
                        const logs = await getCdpLogs(args?.tail || 50, args?.level || 'all');
                        // ★ 返回诊断信息：CDP 连接状态 + 日志数据
                        event.reply(null, {
                            _debug: { ...getCdpStatus(), ts: Date.now() },
                            result: logs,
                        });
                    }
                } catch (e: any) {
                    if (event.reply) {
                        event.reply(null, { error: e.message, _debug: { attached: false, size: 0 } });
                    }
                }
            }
            handle();
        }
    },
};
