/** 侧栏 webview 内联脚本（由 inspector-provider 注入） */
export function buildSidebarScript(): string {
    return `
    const vscode = acquireVsCodeApi();
    const saved = vscode.getState() || {};
    let selectedUuid = saved.selectedUuid || '';
    let searchQuery = saved.searchQuery || '';
    let activeTab = saved.activeTab || 'tree';
    let treeData = null;
    let detailData = null;
    let detailText = '选中节点查看属性';
    let treeSyncHint = '';
    let perfData = null;
    let memoryData = null;
    let scriptList = null;
    let renderPayload = null;
    let requestSeq = 0;
    let perfTimer = null;
    const pendingTools = {};

    function persistState() {
      vscode.setState({ selectedUuid, searchQuery, activeTab });
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function callTool(name, args) {
      const id = String(++requestSeq);
      pendingTools[id] = name;
      vscode.postMessage({ type: 'callTool', id, name, args: args || {} });
      return id;
    }

    function updateSyncHint() {
      const el = document.getElementById('sync-hint');
      if (el) el.textContent = treeSyncHint;
    }

    function loadTree() {
      treeSyncHint = '手动刷新中...';
      updateSyncHint();
      document.getElementById('tree').textContent = '加载中...';
      callTool('get_node_tree', { depth: 8 });
    }

    function reloadDetail() {
      if (!selectedUuid) return;
      detailData = null;
      detailText = '加载属性中...';
      renderDetailPanel();
      callTool('get_node_detail', { uuid: selectedUuid });
    }

    function getSearchQueries() {
      return searchQuery.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    }

    function markTreeMatches(node, queries, cache) {
      if (!node || typeof node !== 'object' || !node.id) {
        return { isMatch: false, hasMatchedDescendant: false, matchedComponent: '' };
      }
      let isMatch = false;
      let matchedComponent = '';
      if (queries.length > 0) {
        const nodeNameLower = (node.name || '').toLowerCase();
        const cList = node.componentNames || [];
        const cNamesLower = cList.map(function(c) { return String(c).toLowerCase(); });
        isMatch = queries.every(function(q) {
          if (nodeNameLower.includes(q)) return true;
          const matchIdx = cNamesLower.findIndex(function(c) { return c.includes(q); });
          if (matchIdx !== -1) {
            if (!matchedComponent) matchedComponent = cList[matchIdx];
            return true;
          }
          return false;
        });
      }
      let hasMatchedDescendant = false;
      if (Array.isArray(node.children)) {
        node.children.forEach(function(child) {
          if (typeof child !== 'object' || child === null) return;
          const childRes = markTreeMatches(child, queries, cache);
          if (childRes.isMatch || childRes.hasMatchedDescendant) hasMatchedDescendant = true;
        });
      }
      const state = { isMatch: isMatch, hasMatchedDescendant: hasMatchedDescendant, matchedComponent: matchedComponent };
      cache.set(node.id, state);
      return state;
    }

    function nodeLabel(node) {
      if (!node || typeof node !== 'object') return '?';
      if (typeof node === 'string') return node;
      if (node.isScene) return node.name || 'Scene';
      return node.name || node.id || '?';
    }

    function flattenTree(node, depth, rows, matchCache, queries) {
      if (!node) return;
      if (typeof node === 'string') {
        rows.push({ label: node, depth: depth, id: '', isTruncated: true });
        return;
      }
      if (typeof node !== 'object') return;
      const isSearching = queries.length > 0;
      if (isSearching && node.id) {
        const state = matchCache.get(node.id);
        if (!state || (!state.isMatch && !state.hasMatchedDescendant)) return;
      }
      rows.push({
        label: nodeLabel(node), depth: depth, id: node.id || '',
        inactive: node.activeInHierarchy === false, isScene: !!node.isScene,
        compCount: typeof node.components === 'number' ? node.components : 0,
        isMatch: isSearching && node.id ? (matchCache.get(node.id) || {}).isMatch : false,
        matchedComponent: isSearching && node.id ? (matchCache.get(node.id) || {}).matchedComponent : '',
      });
      if (Array.isArray(node.children)) {
        node.children.forEach(function(child) { flattenTree(child, depth + 1, rows, matchCache, queries); });
      }
    }

    function renderTree(node) {
      const queries = getSearchQueries();
      const matchCache = new Map();
      if (queries.length > 0 && node) markTreeMatches(node, queries, matchCache);
      const rows = [];
      flattenTree(node, 0, rows, matchCache, queries);
      if (rows.length === 0) {
        return queries.length > 0
          ? '<div class="node" style="color:#888">没有找到匹配的节点</div>'
          : '<div class="node">（空节点树）</div>';
      }
      return rows.map(function(row) {
        const icon = row.isScene ? '🌐 ' : (row.isTruncated ? '… ' : '');
        const style = 'padding-left:' + (row.depth * 12) + 'px' + (row.inactive ? ';opacity:0.45' : '');
        const badge = row.compCount > 0 ? ' <span style="color:#888;font-size:10px">' + row.compCount + '</span>' : '';
        const compHint = row.matchedComponent ? ' <span style="color:#888;font-size:10px">(' + escapeHtml(row.matchedComponent) + ')</span>' : '';
        const matchCls = row.isMatch ? ' match' : '';
        if (row.id) {
          return '<div class="node' + matchCls + '" style="' + style + '" data-uuid="' + row.id + '">' + icon + escapeHtml(row.label) + badge + compHint + '</div>';
        }
        return '<div class="node" style="' + style + ';color:#888">' + icon + escapeHtml(row.label) + '</div>';
      }).join('');
    }

    function unwrapTree(data) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
      if (data.tree && typeof data.tree === 'object' && !Array.isArray(data.children)) return data.tree;
      return data;
    }

    function isLikelyFullTree(node) {
      if (!node || typeof node !== 'object') return false;
      if (node.isScene) return true;
      if (node.name === 'Scene' || node.name === 'Main') return true;
      return false;
    }

    function renderTreePanel() {
      const treeEl = document.getElementById('tree');
      if (!treeData) { treeEl.textContent = '（无节点树数据）'; return; }
      treeEl.innerHTML = renderTree(treeData);
      bindTreeNodeClicks();
      if (selectedUuid) {
        const sel = treeEl.querySelector('.node[data-uuid="' + selectedUuid + '"]');
        if (sel) sel.style.background = '#37373d';
      }
    }

    function propInputHtml(compName, compIndex, p) {
      if (!p || !p.key || detailData && detailData._fromCache) return '';
      const t = p.type || 'unsupported';
      if (t !== 'number' && t !== 'string' && t !== 'boolean') {
        let val = p.value;
        if (val !== null && typeof val === 'object') val = JSON.stringify(val);
        return '<div class="detail-kv"><span class="k">' + escapeHtml(p.key) + '</span><span>' + escapeHtml(String(val)) + '</span></div>';
      }
      const ds = ' data-comp-name="' + escapeHtml(compName || '') + '" data-comp-index="' + compIndex + '" data-prop-key="' + escapeHtml(p.key) + '" data-prop-type="' + t + '"';
      if (t === 'boolean') {
        const chk = p.value ? ' checked' : '';
        return '<div class="detail-kv"><span class="k">' + escapeHtml(p.key) + '</span><input type="checkbox" class="prop-input"' + ds + chk + '></div>';
      }
      if (t === 'number') {
        return '<div class="detail-kv"><span class="k">' + escapeHtml(p.key) + '</span><input type="number" class="prop-input" step="any"' + ds + ' value="' + escapeHtml(String(p.value)) + '"></div>';
      }
      return '<div class="detail-kv"><span class="k">' + escapeHtml(p.key) + '</span><input type="text" class="prop-input"' + ds + ' value="' + escapeHtml(String(p.value ?? '')) + '"></div>';
    }

    function bindDetailEditors() {
      document.querySelectorAll('#detail .prop-input').forEach(function(input) {
        input.onchange = function() {
          if (!selectedUuid || detailData && detailData._fromCache) return;
          const compName = input.dataset.compName || null;
          const compIndex = parseInt(input.dataset.compIndex || '-1', 10);
          const propKey = input.dataset.propKey;
          const propType = input.dataset.propType;
          let value = input.type === 'checkbox' ? input.checked : input.value;
          if (propType === 'number') value = parseFloat(value);
          callTool('update_node_property', {
            uuid: selectedUuid,
            compName: compName || undefined,
            propKey: propKey,
            value: value,
            compIndex: compIndex,
          });
        };
      });
    }

    function renderDetailPanel() {
      const el = document.getElementById('detail');
      if (!detailData || typeof detailData !== 'object') {
        el.innerHTML = '<div class="detail-placeholder">' + escapeHtml(detailText) + '</div>';
        return;
      }
      const d = detailData;
      let html = '';
      if (d._fromCache) {
        html += '<div class="detail-section" style="color:#dcdcaa;font-size:11px">' + escapeHtml(d._hint || '来自节点树缓存（只读）') + '</div>';
      }
      html += '<div class="detail-section"><h4>基础</h4>';
      html += '<div class="detail-kv"><span class="k">name</span><span>' + escapeHtml(d.name || '') + '</span></div>';
      html += '<div class="detail-kv"><span class="k">id</span><span style="word-break:break-all">' + escapeHtml(d.id || '') + '</span></div>';
      html += '<div class="detail-kv"><span class="k">active</span><span>' + escapeHtml(String(d.active)) + '</span></div>';
      if (d.x !== undefined || d.y !== undefined) {
        html += '<div class="detail-kv"><span class="k">position</span><span>' + escapeHtml(String(d.x)) + ', ' + escapeHtml(String(d.y)) + '</span></div>';
      }
      if (d.width !== undefined) {
        html += '<div class="detail-kv"><span class="k">size</span><span>' + escapeHtml(String(d.width)) + ' × ' + escapeHtml(String(d.height)) + '</span></div>';
      }
      html += '</div>';
      if (Array.isArray(d.components) && d.components.length > 0) {
        html += '<div class="detail-section"><h4>组件 (' + d.components.length + ')</h4>';
        d.components.forEach(function(comp, idx) {
          const cname = comp.name || comp.type || ('Component' + idx);
          html += '<details class="comp"' + (idx < 2 ? ' open' : '') + '><summary>' + escapeHtml(cname) + '</summary>';
          if (Array.isArray(comp.props)) {
            comp.props.forEach(function(p) { html += propInputHtml(cname, idx, p); });
          }
          html += '</details>';
        });
        html += '</div>';
      }
      html += '<details class="raw-json"><summary>原始 JSON</summary><pre>' + escapeHtml(JSON.stringify(d, null, 2)) + '</pre></details>';
      el.innerHTML = html;
      bindDetailEditors();
    }

    function renderPerfPanel() {
      const el = document.getElementById('perf-content');
      if (!perfData) { el.textContent = '加载中...'; return; }
      const p = perfData;
      el.innerHTML = [
        '<div class="stat-grid">',
        '<div class="stat"><span class="label">FPS</span><span class="val">' + escapeHtml(String(p.fps ?? '-')) + '</span></div>',
        '<div class="stat"><span class="label">Avg</span><span class="val">' + escapeHtml(String(p.avgFps ?? '-')) + '</span></div>',
        '<div class="stat"><span class="label">1% Low</span><span class="val">' + escapeHtml(String(p.fps1pLow ?? '-')) + '</span></div>',
        '<div class="stat"><span class="label">DrawCall</span><span class="val">' + escapeHtml(String(p.drawCall ?? '-')) + '</span></div>',
        '<div class="stat"><span class="label">Logic ms</span><span class="val">' + escapeHtml(String(p.logicTime ?? '-')) + '</span></div>',
        '<div class="stat"><span class="label">Render ms</span><span class="val">' + escapeHtml(String(p.renderTime ?? '-')) + '</span></div>',
        '</div>',
      ].join('');
    }

    function renderMemoryPanel() {
      const el = document.getElementById('memory-content');
      if (!memoryData) { el.textContent = '加载中...'; return; }
      const bundles = memoryData.bundles || memoryData.ranking || [];
      if (!Array.isArray(bundles) || bundles.length === 0) {
        el.innerHTML = '<pre style="font-size:10px">' + escapeHtml(JSON.stringify(memoryData, null, 2)) + '</pre>';
        return;
      }
      let html = '<div class="mem-total">总内存约: ' + escapeHtml(String(memoryData.totalMemory || memoryData.total || '?')) + ' KB</div>';
      bundles.slice(0, 20).forEach(function(b) {
        const name = b.name || b.bundleName || '?';
        const mem = b.currentMemory || b.memory || 0;
        html += '<div class="mem-row"><span>' + escapeHtml(name) + '</span><span>' + escapeHtml(String(mem)) + ' KB</span></div>';
      });
      el.innerHTML = html;
    }

    function renderEnginePanel(msg) {
      const el = document.getElementById('engine-msg');
      if (el && msg) el.textContent = msg;
    }

    function renderRenderPanel() {
      const el = document.getElementById('render-content');
      if (!renderPayload) { el.textContent = '等待渲染调试数据（需在 Creator 面板开启渲染调试器）...'; return; }
      el.innerHTML = '<pre style="font-size:10px">' + escapeHtml(JSON.stringify(renderPayload, null, 2)) + '</pre>';
    }

    function renderScriptsPanel() {
      const el = document.getElementById('scripts-content');
      if (!scriptList) { el.textContent = '加载中...'; return; }
      const scripts = scriptList.scripts || scriptList.list || scriptList;
      if (!Array.isArray(scripts)) {
        el.innerHTML = '<pre style="font-size:10px">' + escapeHtml(JSON.stringify(scriptList, null, 2)) + '</pre>';
        return;
      }
      if (scripts.length === 0) { el.textContent = '（无用户脚本）'; return; }
      el.innerHTML = scripts.map(function(s) {
        const name = s.name || s.file || String(s);
        const on = s.enabled !== false ? '✓' : '○';
        return '<div class="script-row">' + on + ' ' + escapeHtml(name) + '</div>';
      }).join('') + '<p class="hint">在 VS Code 资源管理器中编辑项目 extensions/*.user.js</p>';
    }

    function bindTreeNodeClicks() {
      document.querySelectorAll('.node[data-uuid]').forEach(function(el) {
        el.onclick = function() {
          selectedUuid = el.dataset.uuid;
          persistState();
          detailData = null;
          detailText = '加载属性中...';
          renderDetailPanel();
          switchTab('detail');
          callTool('get_node_detail', { uuid: selectedUuid });
        };
      });
    }

    function applyTreeData(tree, source) {
      const root = unwrapTree(tree);
      if (!root || typeof root !== 'object') return;
      treeData = root;
      treeSyncHint = source === 'probe' ? '探针自动同步' : (source === 'manual' ? '已手动刷新' : treeSyncHint);
      updateSyncHint();
      if (activeTab === 'tree') renderTreePanel();
    }

    function parseToolJson(text) {
      if (!text || typeof text !== 'string') return null;
      if (text.startsWith('Execution failed:') || text.startsWith('Tool unknown:')) throw new Error(text);
      try {
        const data = JSON.parse(text);
        if (data && data.error) throw new Error(data.msg || data.error);
        return data;
      } catch (e) {
        if (e.message && (e.message.startsWith('Execution failed:') || e.message.startsWith('Tool unknown:'))) throw e;
        throw new Error('解析失败: ' + (text.length > 80 ? text.substring(0, 80) + '...' : text));
      }
    }

    function handleTreeText(text) {
      try {
        applyTreeData(unwrapTree(parseToolJson(text)), 'manual');
      } catch (e) {
        document.getElementById('tree').textContent = e.message;
      }
    }

    function handleDetailText(text) {
      try {
        detailData = parseToolJson(text);
        detailText = JSON.stringify(detailData, null, 2);
      } catch (e) {
        detailData = null;
        detailText = e.message;
      }
      if (activeTab === 'detail') renderDetailPanel();
    }

    function handlePerfText(text) {
      try { perfData = parseToolJson(text); renderPerfPanel(); } catch (e) { perfData = null; document.getElementById('perf-content').textContent = e.message; }
    }

    function handleMemoryText(text) {
      try { memoryData = parseToolJson(text); renderMemoryPanel(); } catch (e) { memoryData = null; document.getElementById('memory-content').textContent = e.message; }
    }

    function handleScriptsText(text) {
      try { scriptList = parseToolJson(text); renderScriptsPanel(); } catch (e) { scriptList = null; document.getElementById('scripts-content').textContent = e.message; }
    }

    function handleUpdatePropText(text) {
      try {
        const data = parseToolJson(text);
        if (data && data.success) reloadDetail();
        else renderEnginePanel('属性更新失败');
      } catch (e) { renderEnginePanel('属性更新: ' + e.message); }
    }

    function handleEngineText(text) {
      try {
        const data = parseToolJson(text);
        renderEnginePanel(data.paused ? '已暂停' : (data.muted !== undefined ? (data.muted ? '已静音' : '已恢复音量') : '操作成功'));
      } catch (e) { renderEnginePanel('引擎: ' + e.message); }
    }

    function resolveToolName(msg) { return msg.name || pendingTools[msg.id] || ''; }

    function dispatchToolResult(toolName, text) {
      if (toolName === 'get_node_detail') handleDetailText(text);
      else if (toolName === 'get_node_tree') handleTreeText(text);
      else if (toolName === 'get_runtime_stats') handlePerfText(text);
      else if (toolName === 'get_memory_ranking') handleMemoryText(text);
      else if (toolName === 'list_scripts') handleScriptsText(text);
      else if (toolName === 'update_node_property') handleUpdatePropText(text);
      else if (toolName === 'control_engine') handleEngineText(text);
    }

    window.addEventListener('message', function(e) {
      const msg = e.data;
      if (msg.type === 'toolResult' && msg.result && msg.result.content) {
        const toolName = resolveToolName(msg);
        delete pendingTools[msg.id];
        if (!toolName) return;
        dispatchToolResult(toolName, msg.result.content[0].text);
      } else if (msg.type === 'toolError') {
        const toolName = resolveToolName(msg);
        delete pendingTools[msg.id];
        const err = '错误: ' + msg.error;
        if (toolName === 'get_node_detail') { detailData = null; detailText = err; if (activeTab === 'detail') renderDetailPanel(); }
        else if (toolName === 'get_node_tree') document.getElementById('tree').textContent = err;
        else if (toolName === 'get_runtime_stats') document.getElementById('perf-content').textContent = err;
        else if (toolName === 'get_memory_ranking') document.getElementById('memory-content').textContent = err;
        else if (toolName === 'list_scripts') document.getElementById('scripts-content').textContent = err;
        else renderEnginePanel(err);
      } else if (msg.type === 'bridgeEvent' && msg.event) {
        if (msg.event.type === 'probe:event' && msg.event.channel === 'update-tree') {
          try {
            const payload = typeof msg.event.args[0] === 'string' ? JSON.parse(msg.event.args[0]) : msg.event.args[0];
            if (payload && payload.tree && isLikelyFullTree(unwrapTree(payload.tree))) applyTreeData(payload.tree, 'probe');
          } catch(_) {}
        } else if (msg.event.type === 'probe:event' && msg.event.channel === 'render-debugger-payload') {
          try {
            renderPayload = typeof msg.event.args[0] === 'string' ? JSON.parse(msg.event.args[0]) : msg.event.args[0];
            if (activeTab === 'render') renderRenderPanel();
          } catch(_) {}
        }
      }
    });

    const TAB_IDS = ['tree', 'detail', 'perf', 'memory', 'engine', 'render', 'scripts'];

    function stopPerfPoll() {
      if (perfTimer) { clearInterval(perfTimer); perfTimer = null; }
    }

    function startPerfPoll() {
      stopPerfPoll();
      callTool('get_runtime_stats', {});
      perfTimer = setInterval(function() { callTool('get_runtime_stats', {}); }, 500);
    }

    function switchTab(tab) {
      activeTab = tab;
      persistState();
      TAB_IDS.forEach(function(id) {
        const panel = document.getElementById('panel-' + id);
        const tabEl = document.getElementById('tab-' + id);
        if (panel) panel.style.display = id === tab ? '' : 'none';
        if (tabEl) tabEl.classList.toggle('active', id === tab);
      });
      if (tab === 'tree') renderTreePanel();
      else if (tab === 'detail') renderDetailPanel();
      else if (tab === 'perf') startPerfPoll();
      else if (tab === 'memory') { callTool('get_memory_ranking', {}); stopPerfPoll(); }
      else if (tab === 'engine') stopPerfPoll();
      else if (tab === 'render') { renderRenderPanel(); stopPerfPoll(); }
      else if (tab === 'scripts') { callTool('list_scripts', {}); stopPerfPoll(); }
      else stopPerfPoll();
    }

    TAB_IDS.forEach(function(id) {
      const el = document.getElementById('tab-' + id);
      if (el) el.onclick = function() { switchTab(id); };
    });

    document.getElementById('tree-search').value = searchQuery;
    document.getElementById('tree-search').addEventListener('input', function(e) {
      searchQuery = e.target.value || '';
      persistState();
      renderTreePanel();
    });

    document.getElementById('btn-pause').onclick = function() { callTool('control_engine', { action: 'toggle_pause' }); };
    document.getElementById('btn-step').onclick = function() { callTool('control_engine', { action: 'step' }); };
    document.getElementById('btn-mute').onclick = function() { callTool('control_engine', { action: 'mute_on' }); };
    document.getElementById('btn-unmute').onclick = function() { callTool('control_engine', { action: 'mute_off' }); };

    switchTab(activeTab);
    loadTree();
    `;
}
