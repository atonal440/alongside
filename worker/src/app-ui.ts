// MCP App UI — self-contained HTML that communicates with the host
// via postMessage JSON-RPC per the MCP Apps spec (2026-01-26).
//
// Key: the VIEW initiates the handshake by sending ui/initialize,
// the HOST responds with context/capabilities, then the VIEW
// confirms with ui/notifications/initialized.
//
// The widget renders tasks only when told to via show_tasks or show_project
// tool results. It never fetches all tasks on its own.

export function getAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif);
      background: var(--color-background-primary, light-dark(#ffffff, #1a1a1a));
      color: var(--color-text-primary, light-dark(#1a1a1a, #e0e0e0));
      padding: 16px;
      font-size: 14px;
    }
    .project-header {
      margin-bottom: 12px;
    }
    .project-title {
      font-weight: 600;
      font-size: 15px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .project-dot { width: 8px; height: 8px; background: #6b9fff; border-radius: 50%; flex-shrink: 0; }
    .project-kickoff {
      margin-top: 6px;
      font-size: 12px;
      color: light-dark(#555, #999);
      line-height: 1.5;
      padding-left: 16px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
      font-weight: 600;
      font-size: 14px;
    }
    .dot { width: 8px; height: 8px; background: #6b9fff; border-radius: 50%; }
    .divider { border: none; border-top: 1px solid light-dark(#ddd, #333); margin-bottom: 12px; }
    .task {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid light-dark(#f0f0f0, #252525);
    }
    .task:last-child { border-bottom: none; }
    .task input[type="checkbox"] {
      accent-color: #6b9fff;
      cursor: pointer;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }
    .task .title { flex: 1; line-height: 1.4; }
    .task .due { font-size: 12px; color: light-dark(#666, #888); flex-shrink: 0; }
    .task .project-tag {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: light-dark(#e8f0ff, #1a2a4a);
      color: light-dark(#3b5bdb, #7fa8ff);
      font-weight: 500;
      flex-shrink: 0;
      max-width: 100px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .task .status-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      font-weight: 500;
      flex-shrink: 0;
    }
    .status-pending { background: light-dark(#eee, #333); color: light-dark(#666, #888); }


    .task.completing .title { text-decoration: line-through; color: light-dark(#999, #4a4a4a); }
    .empty { color: light-dark(#666, #888); padding: 12px 0; font-size: 13px; }
    .toast {
      position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%) translateY(10px);
      background: light-dark(#f5f5f5, #252525); border: 1px solid light-dark(#ddd, #333); border-radius: 6px;
      padding: 8px 14px; font-size: 12px;
      opacity: 0; transition: opacity 0.2s, transform 0.2s; pointer-events: none;
    }
    .toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
    .toast .next { color: #6b9fff; }
  </style>
</head>
<body>
  <div id="root"></div>
  <div class="toast" id="toast"></div>

  <script>
    // ── MCP App postMessage JSON-RPC ──
    let rpcId = 1;
    const pending = new Map();

    // Widget state
    let tasks = [];
    let projects = {}; // project_id → title map
    let displayedTaskIds = []; // IDs from the last show_tasks / show_project call
    let currentProject = null; // Project object if in project mode

    function rpcRequest(method, params) {
      return new Promise((resolve, reject) => {
        const id = rpcId++;
        pending.set(id, { resolve, reject });
        window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
      });
    }

    function rpcNotify(method, params) {
      window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
    }

    function rpcRespond(id, result) {
      window.parent.postMessage({ jsonrpc: '2.0', id, result }, '*');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.jsonrpc !== '2.0') return;

      if ('id' in msg && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
        return;
      }

      switch (msg.method) {
        case 'ui/notifications/tool-result':
          handleToolResult(msg.params);
          break;

        case 'ui/notifications/host-context-changed':
          applyTheme(msg.params);
          break;

        case 'ui/resource-teardown':
          rpcRespond(msg.id, {});
          break;
      }
    });

    async function init() {
      try {
        const result = await rpcRequest('ui/initialize', {
          protocolVersion: '2026-01-26',
          appCapabilities: {},
          appInfo: { name: 'alongside-tasks', version: '1.0.0' },
        });
        if (result?.hostContext) applyTheme(result.hostContext);
        rpcNotify('ui/notifications/initialized');
        // Don't fetch anything — wait for show_tasks / show_project tool-result
        render();
      } catch (err) {
        console.error('MCP App init failed:', err);
      }
    }

    function applyTheme(ctx) {
      if (ctx.theme) document.documentElement.style.colorScheme = ctx.theme;
      if (ctx.styles?.variables) {
        for (const [k, v] of Object.entries(ctx.styles.variables)) {
          document.documentElement.style.setProperty(k, v);
        }
      }
      if (ctx.styles?.css?.fonts && !document.getElementById('host-fonts')) {
        const style = document.createElement('style');
        style.id = 'host-fonts';
        style.textContent = ctx.styles.css.fonts;
        document.head.appendChild(style);
      }
    }

    function handleToolResult(params) {
      const sc = params?.structuredContent;
      if (!sc) return;

      // show_project result
      if (sc.project && Array.isArray(sc.tasks)) {
        currentProject = sc.project;
        tasks = sc.tasks;
        projects = {};
        displayedTaskIds = tasks.map(t => t.id);
        render();
        reportSize();
        return;
      }

      // show_tasks result
      if (Array.isArray(sc.tasks)) {
        currentProject = null;
        tasks = sc.tasks;
        projects = sc.projects || {};
        displayedTaskIds = tasks.map(t => t.id);
        render();
        reportSize();
        return;
      }

      // Mutation results — refresh only the currently displayed tasks
      if (displayedTaskIds.length === 0) return;

      if (sc.next) {
        showToast('Done! Next: <span class="next">' + escapeHtml(sc.next.due_date || '') + '</span>');
      }
      refreshDisplayed();
    }

    async function refreshDisplayed() {
      if (displayedTaskIds.length === 0) return;
      try {
        const result = await rpcRequest('tools/call', {
          name: 'list_tasks',
          arguments: { statuses: ['pending', 'done'] },
        });
        const all = result?.structuredContent?.tasks || [];
        tasks = all.filter(t => displayedTaskIds.includes(t.id));
        render();
        reportSize();
      } catch (err) {
        console.error('Failed to refresh tasks:', err);
      }
    }

    function render() {
      const root = document.getElementById('root');

      if (currentProject) {
        let html = '<div class="project-header">' +
          '<div class="project-title"><span class="project-dot"></span>' + escapeHtml(currentProject.title) + '</div>';
        if (currentProject.kickoff_note) {
          html += '<div class="project-kickoff">' + escapeHtml(currentProject.kickoff_note) + '</div>';
        }
        html += '</div><hr class="divider" />';
        root.innerHTML = html + renderTaskList();
      } else if (displayedTaskIds.length > 0) {
        root.innerHTML = '<div class="header"><span class="dot"></span> Tasks</div>' +
          '<hr class="divider" />' + renderTaskList();
      } else {
        root.innerHTML = '';
      }
    }

    function renderTaskList() {
      if (!tasks.length) {
        return '<div class="empty">No tasks</div>';
      }
      return tasks.map(t => {
        const statusClass = 'status-' + (t.status || 'pending');
        const projectName = t.project_id ? projects[t.project_id] : null;
        return '<div class="task" data-id="' + escapeAttr(t.id) + '">' +
          '<input type="checkbox" data-id="' + escapeAttr(t.id) + '"' + (t.status === 'done' ? ' checked' : '') + ' />' +
          '<span class="title">' + escapeHtml(t.title) + '</span>' +
          (projectName && !currentProject ? '<span class="project-tag">' + escapeHtml(projectName) + '</span>' : '') +
          (t.due_date ? '<span class="due">' + escapeHtml(t.due_date) + '</span>' : '') +
          '<span class="status-badge ' + statusClass + '">' + escapeHtml(t.status || 'pending') + '</span>' +
          '</div>';
      }).join('');
    }

    document.getElementById('root').addEventListener('change', async (e) => {
      if (e.target.type !== 'checkbox') return;
      const id = e.target.dataset.id;
      const taskEl = e.target.closest('.task');
      const completing = e.target.checked;

      e.target.disabled = true;
      if (completing) taskEl.classList.add('completing');

      try {
        if (completing) {
          const result = await rpcRequest('tools/call', {
            name: 'complete_task',
            arguments: { task_id: id },
          });
          let resultData = result?.structuredContent;
          if (!resultData && result?.content?.[0]?.text) {
            try { resultData = JSON.parse(result.content[0].text); } catch {}
          }
          if (resultData?.next) {
            showToast('Done! Next: <span class="next">' + escapeHtml(resultData.next.due_date || '') + '</span>');
          }
        } else {
          await rpcRequest('tools/call', {
            name: 'reopen_task',
            arguments: { task_id: id },
          });
        }
        await refreshDisplayed();
      } catch (err) {
        taskEl.classList.remove('completing');
        e.target.disabled = false;
        e.target.checked = completing;
        console.error('Failed to update task:', err);
      }
    });

    function reportSize() {
      requestAnimationFrame(() => {
        rpcNotify('ui/notifications/size-changed', {
          width: document.body.scrollWidth,
          height: document.body.scrollHeight,
        });
      });
    }

    function escapeHtml(str) {
      const d = document.createElement('div');
      d.textContent = str || '';
      return d.innerHTML;
    }

    function escapeAttr(str) {
      return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }

    function showToast(html) {
      const el = document.getElementById('toast');
      el.innerHTML = html;
      el.classList.add('visible');
      clearTimeout(el._timer);
      el._timer = setTimeout(() => el.classList.remove('visible'), 3000);
    }

    init();
  </script>
</body>
</html>`;
}

export function getActionLogHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif);
      background: var(--color-background-primary, light-dark(#ffffff, #1a1a1a));
      font-size: 13px;
    }
    .entry {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      white-space: nowrap;
      overflow: hidden;
    }
    .badge {
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 3px;
      text-transform: uppercase;
      flex-shrink: 0;
      letter-spacing: 0.04em;
    }
    .badge-add_task      { background: light-dark(#d1fae5, #052e16); color: light-dark(#065f46, #6ee7b7); }
    .badge-complete_task { background: light-dark(#dbeafe, #0c1a3a); color: light-dark(#1e40af, #93c5fd); }
    .badge-delete_task   { background: light-dark(#fee2e2, #2d0a0a); color: light-dark(#991b1b, #fca5a5); }
    .badge-snooze_task   { background: light-dark(#fef3c7, #2d1a00); color: light-dark(#92400e, #fcd34d); }
    .badge-update_task   { background: light-dark(#ede9fe, #1a0a3a); color: light-dark(#5b21b6, #c4b5fd); }
    .badge-create_project { background: light-dark(#ccfbf1, #022c22); color: light-dark(#065f46, #5eead4); }
    .badge-link_tasks    { background: light-dark(#e0f2fe, #041626); color: light-dark(#075985, #7dd3fc); }
    .badge-reopen_task   { background: light-dark(#f0f0f0, #2a2a2a); color: light-dark(#555, #aaa); }
    .badge-focus_task    { background: light-dark(#fff7ed, #2d1a00); color: light-dark(#9a3412, #fb923c); }
    .badge-update_project { background: light-dark(#ccfbf1, #022c22); color: light-dark(#065f46, #5eead4); }
    .badge-delete_project { background: light-dark(#fee2e2, #2d0a0a); color: light-dark(#991b1b, #fca5a5); }
    .badge-unlink_tasks  { background: light-dark(#e0f2fe, #041626); color: light-dark(#075985, #7dd3fc); }
    .title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--color-text-primary, light-dark(#1a1a1a, #e0e0e0));
    }
    .detail {
      font-size: 11px;
      color: light-dark(#888, #666);
      flex-shrink: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 120px;
    }
  </style>
</head>
<body>
  <div id="root"></div>

  <script>
    // ── MCP App postMessage JSON-RPC (minimal — read-only widget) ──
    let rpcId = 1;
    const pending = new Map();

    function rpcNotify(method, params) {
      window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
    }

    function rpcRespond(id, result) {
      window.parent.postMessage({ jsonrpc: '2.0', id, result }, '*');
    }

    function rpcRequest(method, params) {
      return new Promise((resolve, reject) => {
        const id = rpcId++;
        pending.set(id, { resolve, reject });
        window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
      });
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.jsonrpc !== '2.0') return;

      if ('id' in msg && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(msg.error); else resolve(msg.result);
        return;
      }

      switch (msg.method) {
        case 'ui/notifications/tool-result': {
          const entry = msg.params?.structuredContent?.action_log_entry;
          if (entry) { render(entry); reportSize(); }
          break;
        }
        case 'ui/notifications/host-context-changed':
          applyTheme(msg.params);
          break;
        case 'ui/resource-teardown':
          rpcRespond(msg.id, {});
          break;
      }
    });

    function applyTheme(ctx) {
      if (ctx.theme) document.documentElement.style.colorScheme = ctx.theme;
      if (ctx.styles?.variables) {
        for (const [k, v] of Object.entries(ctx.styles.variables)) {
          document.documentElement.style.setProperty(k, v);
        }
      }
      if (ctx.styles?.css?.fonts && !document.getElementById('host-fonts')) {
        const style = document.createElement('style');
        style.id = 'host-fonts';
        style.textContent = ctx.styles.css.fonts;
        document.head.appendChild(style);
      }
    }

    const LABELS = {
      add_task:        'ADDED',
      complete_task:   'DONE',
      delete_task:     'DELETED',
      snooze_task:     'SNOOZED',
      update_task:     'UPDATED',
      create_project:  'PROJECT',
      update_project:  'UPDATED',
      delete_project:  'DELETED',
      link_tasks:      'LINKED',
      unlink_tasks:    'UNLINKED',
      reopen_task:     'REOPENED',
      focus_task:      'FOCUSED',
    };

    function render(entry) {
      const label = LABELS[entry.tool_name] || entry.tool_name.replace(/_/g, ' ').toUpperCase();
      document.getElementById('root').innerHTML =
        '<div class="entry">' +
        '<span class="badge badge-' + entry.tool_name + '">' + label + '</span>' +
        '<span class="title">' + escapeHtml(entry.title) + '</span>' +
        (entry.detail ? '<span class="detail">' + escapeHtml(entry.detail) + '</span>' : '') +
        '</div>';
    }

    function reportSize() {
      requestAnimationFrame(() => {
        rpcNotify('ui/notifications/size-changed', {
          width: document.body.scrollWidth,
          height: document.body.scrollHeight,
        });
      });
    }

    function escapeHtml(str) {
      const d = document.createElement('div');
      d.textContent = str || '';
      return d.innerHTML;
    }

    async function init() {
      try {
        const result = await rpcRequest('ui/initialize', {
          protocolVersion: '2026-01-26',
          appCapabilities: {},
          appInfo: { name: 'alongside-action-log', version: '1.0.0' },
        });
        if (result?.hostContext) applyTheme(result.hostContext);
        rpcNotify('ui/notifications/initialized');
        reportSize();
      } catch (err) {
        console.error('Action log init failed:', err);
      }
    }

    init();
  </script>
</body>
</html>`;
}
