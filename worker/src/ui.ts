import { DB, Task } from './db';

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
  </style>
</head>
<body>
  <div class="header"><span class="dot"></span> Active Tasks</div>
  <hr class="divider" />
  <div id="tasks">
    ${tasks.length ? taskRows : '<div class="empty">No active tasks</div>'}
  </div>
  <a class="add-link" id="add-link">+ add to session</a>

  <script>
    const BASE = ${JSON.stringify(baseUrl)};

    // Complete task on checkbox
    document.getElementById('tasks').addEventListener('change', async (e) => {
      if (e.target.type !== 'checkbox') return;
      const id = e.target.dataset.id;
      const taskEl = e.target.closest('.task');

      try {
        const res = await fetch(BASE + '/api/tasks/' + id + '/complete', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + getToken() },
        });
        if (res.ok) {
          taskEl.classList.add('done');
          // Notify parent if embedded
          window.parent?.postMessage({ type: 'task-completed', taskId: id }, '*');
        }
      } catch (err) {
        e.target.checked = false;
        console.error('Failed to complete task:', err);
      }
    });

    function getToken() {
      // Token can be passed via query param or postMessage
      const params = new URLSearchParams(location.search);
      return params.get('token') || '';
    }

    // Poll for updates every 10s
    setInterval(async () => {
      try {
        const params = new URLSearchParams(location.search);
        const session = params.get('session') || '';
        const url = BASE + '/api/tasks?status=active' + (session ? '&session=' + session : '');
        const res = await fetch(url, {
          headers: { 'Authorization': 'Bearer ' + getToken() },
        });
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
    const sessionId = url.searchParams.get('session') || undefined;
    const tasks = await db.getActiveTasks(sessionId);
    const html = renderActiveTasksHTML(tasks, baseUrl);
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  }

  return new Response('Not found', { status: 404 });
}
