import { DB } from './db';
import type { Task } from '@shared/types';
import { materializeDueDuties } from './duties';

function renderActiveTasksHTML(tasks: Task[], baseUrl: string): string {
  const taskRows = tasks.map(t => `
    <div class="task" data-id="${t.id}">
      <input type="checkbox" data-id="${t.id}" />
      <span class="title">${escapeHtml(t.title)}</span>
      ${t.due_date ? `<span class="due">${escapeHtml(t.due_date)}</span>` : ''}
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #1a1a1a;
      color: #e0e0e0;
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
    .divider { border: none; border-top: 1px solid #333; margin-bottom: 12px; }
    .task {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
    }
    .task input[type="checkbox"] {
      accent-color: #6b9fff;
      cursor: pointer;
    }
    .task .title { flex: 1; }
    .task .due { font-size: 12px; color: #888; }
    .task.done .title { text-decoration: line-through; color: #4a4a4a; }
    .add-link {
      display: block;
      margin-top: 12px;
      color: #6b9fff;
      font-size: 13px;
      cursor: pointer;
      text-decoration: none;
    }
    .add-link:hover { text-decoration: underline; }
    .empty { color: #888; padding: 12px 0; font-size: 13px; }
    .toast {
      position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%) translateY(10px);
      background: #252525; border: 1px solid #333; border-radius: 6px;
      padding: 8px 14px; font-size: 12px; color: #e0e0e0;
      opacity: 0; transition: opacity 0.2s, transform 0.2s; pointer-events: none;
    }
    .toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
    .toast .next { color: #6b9fff; }
  </style>
</head>
<body>
  <div class="header"><span class="dot"></span> Focused Tasks</div>
  <hr class="divider" />
  <div id="tasks">
    ${tasks.length ? taskRows : '<div class="empty">No focused tasks</div>'}
  </div>
  <div class="add-link">ask Claude to add more tasks</div>
  <div class="toast" id="toast"></div>

  <script>
    const BASE = ${JSON.stringify(baseUrl)};

    // Forward the sig and t params from the iframe URL to all /ui/ requests
    function sigParams() {
      const params = new URLSearchParams(location.search);
      const t = params.get('t') || '';
      const sig = params.get('sig') || '';
      return 't=' + encodeURIComponent(t) + '&sig=' + encodeURIComponent(sig);
    }

    // Complete task on checkbox
    document.getElementById('tasks').addEventListener('change', async (e) => {
      if (e.target.type !== 'checkbox') return;
      const id = e.target.dataset.id;
      const taskEl = e.target.closest('.task');

      try {
        const res = await fetch(BASE + '/ui/complete/' + id + '?' + sigParams(), {
          method: 'POST',
        });
        if (res.ok) {
          const data = await res.json();
          taskEl.classList.add('done');
          if (data.next) {
            showToast('Done! Next: <span class="next">' + escapeHtml(data.next.due_date) + '</span>');
          }
          window.parent?.postMessage({ type: 'task-completed', taskId: id }, '*');
        }
      } catch (err) {
        e.target.checked = false;
        console.error('Failed to complete task:', err);
      }
    });

    // Poll for updates every 10s
    setInterval(async () => {
      try {
        const url = BASE + '/ui/tasks?' + sigParams();
        const res = await fetch(url);
        if (res.ok) {
          const tasks = await res.json();
          refreshTasks(tasks);
        }
      } catch (err) {
        // Silently fail on poll
      }
    }, 10000);

    function refreshTasks(tasks) {
      const container = document.getElementById('tasks');
      if (tasks.length === 0) {
        container.innerHTML = '<div class="empty">No active tasks</div>';
        return;
      }
      container.innerHTML = tasks.map(t =>
        '<div class="task" data-id="' + t.id + '">' +
        '<input type="checkbox" data-id="' + t.id + '" />' +
        '<span class="title">' + escapeHtml(t.title) + '</span>' +
        (t.due_date ? '<span class="due">' + escapeHtml(t.due_date) + '</span>' : '') +
        '</div>'
      ).join('');
    }

    function escapeHtml(str) {
      const d = document.createElement('div');
      d.textContent = str || '';
      return d.innerHTML;
    }

    function showToast(html) {
      const el = document.getElementById('toast');
      el.innerHTML = html;
      el.classList.add('visible');
      clearTimeout(el._timer);
      el._timer = setTimeout(() => el.classList.remove('visible'), 3000);
    }
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function handleUiRequest(request: Request, url: URL, db: DB): Promise<Response> {
  const path = url.pathname;
  const baseUrl = url.origin;

  if (path === '/ui/active') {
    const tasks = await db.listFocusedTasks();
    const html = renderActiveTasksHTML(tasks, baseUrl);
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  }

  // Unauthenticated JSON endpoint for widget polling
  if (path === '/ui/tasks') {
    const tasks = await db.listFocusedTasks();
    return new Response(JSON.stringify(tasks), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // Unauthenticated complete endpoint for the iframe widget
  const completeMatch = path.match(/^\/ui\/complete\/([^/]+)$/);
  if (request.method === 'POST' && completeMatch) {
    await materializeDueDuties(db, new Date().toISOString());
    const result = await db.completeTask(completeMatch[1]);
    if (!result) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response('Not found', { status: 404 });
}
