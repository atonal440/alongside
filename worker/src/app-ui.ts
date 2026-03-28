// MCP App UI — self-contained HTML that communicates with the host
// via postMessage JSON-RPC per the MCP Apps spec (2026-01-26).
//
// Key: the VIEW initiates the handshake by sending ui/initialize,
// the HOST responds with context/capabilities, then the VIEW
// confirms with ui/notifications/initialized.

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
    }
    .task input[type="checkbox"] {
      accent-color: #6b9fff;
      cursor: pointer;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }
    .task .title { flex: 1; }
    .task .due { font-size: 12px; color: light-dark(#666, #888); }
    .task .status-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
      font-weight: 500;
    }
    .status-pending { background: light-dark(#eee, #333); color: light-dark(#666, #888); }
    .status-active { background: light-dark(#e0edff, #1a3a5c); color: light-dark(#2563eb, #6b9fff); }
    .status-snoozed { background: light-dark(#fef3e0, #3a2a1a); color: light-dark(#b8860b, #d4a06a); }
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
    .loading { color: light-dark(#666, #888); padding: 12px 0; font-size: 13px; }
  </style>
</head>
<body>
  <div class="header"><span class="dot"></span> Tasks</div>
  <hr class="divider" />
  <div id="tasks"><div class="loading">Loading tasks...</div></div>
  <div class="toast" id="toast"></div>

  <script>
    // ── MCP App postMessage JSON-RPC ──
    let rpcId = 1;
    const pending = new Map();
    let tasks = [];
    let hostContext = {};

    // Send JSON-RPC request to host and await response
    function rpcRequest(method, params) {
      return new Promise((resolve, reject) => {
        const id = rpcId++;
        pending.set(id, { resolve, reject });
        window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
      });
    }

    // Send JSON-RPC notification to host (no response expected)
    function rpcNotify(method, params) {
      window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
    }

    // Send JSON-RPC response to host
    function rpcRespond(id, result) {
      window.parent.postMessage({ jsonrpc: '2.0', id, result }, '*');
    }

    // Handle incoming messages from host
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.jsonrpc !== '2.0') return;

      // Response to one of our requests (ui/initialize, tools/call, etc.)
      if ('id' in msg && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
        return;
      }

      // Notification or request from host
      switch (msg.method) {
        case 'ui/notifications/tool-input':
          // Tool arguments — could use these to filter by session
          break;

        case 'ui/notifications/tool-result':
          handleToolResult(msg.params);
          break;

        case 'ui/notifications/host-context-changed':
          hostContext = { ...hostContext, ...msg.params };
          applyTheme(hostContext);
          break;

        case 'ui/resource-teardown':
          rpcRespond(msg.id, {});
          break;
      }
    });

    // ── Initialization: VIEW initiates the handshake ──
    async function init() {
      try {
        // Step 1: Send ui/initialize to the host
        const result = await rpcRequest('ui/initialize', {
          protocolVersion: '2026-01-26',
          appCapabilities: {},
          appInfo: { name: 'alongside-tasks', version: '1.0.0' },
        });

        // Step 2: Process host response
        if (result?.hostContext) {
          hostContext = result.hostContext;
          applyTheme(hostContext);
        }

        // Step 3: Confirm initialization
        rpcNotify('ui/notifications/initialized');

        // Report initial size
        reportSize();
      } catch (err) {
        console.error('MCP App init failed:', err);
      }
    }

    function applyTheme(ctx) {
      if (ctx.theme) {
        // Set color-scheme based on host theme
        document.documentElement.style.colorScheme = ctx.theme;
      }
      if (ctx.styles?.variables) {
        for (const [key, value] of Object.entries(ctx.styles.variables)) {
          document.documentElement.style.setProperty(key, value);
        }
      }
      if (ctx.styles?.css?.fonts) {
        const existing = document.getElementById('host-fonts');
        if (!existing) {
          const style = document.createElement('style');
          style.id = 'host-fonts';
          style.textContent = ctx.styles.css.fonts;
          document.head.appendChild(style);
        }
      }
    }

    function handleToolResult(params) {
      const sc = params?.structuredContent;
      if (!sc) return;

      // Handle different tool result shapes
      if (Array.isArray(sc.tasks)) {
        tasks = sc.tasks;
      } else if (Array.isArray(sc)) {
        tasks = sc;
      } else if (sc.id && sc.title) {
        // Single task result (add_task, etc.) — refresh
        refreshViaToolCall();
        return;
      } else if (sc.completed || sc.next) {
        // complete_task result
        if (sc.next) {
          showToast('Done! Next: <span class="next">' + escapeHtml(sc.next.due_date || '') + '</span>');
        }
        refreshViaToolCall();
        return;
      }

      renderTasks();
      reportSize();
    }

    async function refreshViaToolCall() {
      try {
        const result = await rpcRequest('tools/call', {
          name: 'list_tasks',
          arguments: { statuses: ['pending', 'active'] },
        });
        if (result?.structuredContent?.tasks) {
          tasks = result.structuredContent.tasks;
        } else if (result?.content?.[0]?.text) {
          try {
            const parsed = JSON.parse(result.content[0].text);
            tasks = parsed.tasks || parsed;
          } catch {}
        }
        renderTasks();
        reportSize();
      } catch (err) {
        console.error('Failed to refresh tasks:', err);
      }
    }

    function renderTasks() {
      const container = document.getElementById('tasks');
      if (!tasks.length) {
        container.innerHTML = '<div class="empty">No tasks</div>';
        return;
      }
      container.innerHTML = tasks.map(t => {
        const statusClass = 'status-' + (t.status || 'pending');
        return '<div class="task" data-id="' + escapeAttr(t.id) + '">' +
          (t.status !== 'done' ? '<input type="checkbox" data-id="' + escapeAttr(t.id) + '" />' : '') +
          '<span class="title">' + escapeHtml(t.title) + '</span>' +
          (t.due_date ? '<span class="due">' + escapeHtml(t.due_date) + '</span>' : '') +
          '<span class="status-badge ' + statusClass + '">' + escapeHtml(t.status || 'pending') + '</span>' +
          '</div>';
      }).join('');
    }

    // Complete task on checkbox click
    document.getElementById('tasks').addEventListener('change', async (e) => {
      if (e.target.type !== 'checkbox') return;
      const id = e.target.dataset.id;
      const taskEl = e.target.closest('.task');
      taskEl.classList.add('completing');
      e.target.disabled = true;

      try {
        const result = await rpcRequest('tools/call', {
          name: 'complete_task',
          arguments: { task_id: id },
        });

        // Check for recurrence
        let resultData = result?.structuredContent;
        if (!resultData && result?.content?.[0]?.text) {
          try { resultData = JSON.parse(result.content[0].text); } catch {}
        }
        if (resultData?.next) {
          showToast('Done! Next: <span class="next">' + escapeHtml(resultData.next.due_date || '') + '</span>');
        }

        // Refresh task list
        await refreshViaToolCall();
      } catch (err) {
        taskEl.classList.remove('completing');
        e.target.disabled = false;
        e.target.checked = false;
        console.error('Failed to complete task:', err);
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

    // Start the handshake
    init();
  </script>
</body>
</html>`;
}
