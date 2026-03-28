// Dev harness: a minimal MCP Apps host for testing the widget locally.
// Served at /dev/app — loads the app-ui HTML in an iframe and implements
// the host side of the postMessage JSON-RPC protocol.
// The app HTML is fetched from /dev/app-html to avoid template escaping issues.

export function getHarnessHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Alongside — Dev Harness</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: system-ui, sans-serif;
      background: #111;
      color: #e0e0e0;
      padding: 20px;
    }
    h1 { font-size: 16px; margin-bottom: 4px; }
    .subtitle { font-size: 12px; color: #888; margin-bottom: 16px; }
    .controls {
      display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap;
    }
    button {
      background: #252525; border: 1px solid #333; color: #e0e0e0;
      padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
    }
    button:hover { border-color: #6b9fff; }
    .theme-toggle { background: #4a7ad4; border-color: #4a7ad4; color: white; }
    #app-frame {
      width: 100%; max-width: 500px; border: 1px solid #333;
      border-radius: 8px; background: #1a1a1a; min-height: 100px;
    }
    #log {
      margin-top: 16px; background: #0a0a0a; border: 1px solid #222;
      border-radius: 6px; padding: 12px; font-family: monospace;
      font-size: 11px; max-height: 300px; overflow-y: auto;
      white-space: pre-wrap; color: #888;
    }
    .log-in { color: #6b9fff; }
    .log-out { color: #8bc34a; }
  </style>
</head>
<body>
  <h1>MCP App Dev Harness</h1>
  <p class="subtitle">Simulates a MCP Apps host for local testing</p>
  <div class="controls">
    <button class="theme-toggle" onclick="toggleTheme()">Toggle Light/Dark</button>
    <button onclick="sendToolResult()">Re-send tool result</button>
    <button onclick="document.getElementById('log').textContent = ''">Clear log</button>
  </div>
  <iframe id="app-frame" sandbox="allow-scripts"></iframe>
  <div id="log"></div>

  <script>
    var API = location.origin;
    var TOKEN = localStorage.getItem('alongside_token') || 'dev-token-change-me';
    var theme = 'dark';
    var tasks = [];

    var frame = document.getElementById('app-frame');
    var logEl = document.getElementById('log');

    function log(dir, msg) {
      var prefix = dir === 'in' ? '\\u2190 APP' : '\\u2192 APP';
      var cls = dir === 'in' ? 'log-in' : 'log-out';
      var line = document.createElement('div');
      line.className = cls;
      line.textContent = prefix + ' ' + (typeof msg === 'string' ? msg : JSON.stringify(msg));
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function fetchTasks(statuses) {
      var qs = (statuses || ['pending', 'active']).map(function(s) { return 'status=' + s; }).join('&');
      return fetch(API + '/api/tasks?' + qs, {
        headers: { 'Authorization': 'Bearer ' + TOKEN },
      }).then(function(res) {
        if (res.ok) return res.json();
        return [];
      }).then(function(t) {
        tasks = t;
        return tasks;
      }).catch(function(e) {
        log('in', 'ERROR fetching tasks: ' + e.message);
        return tasks;
      });
    }

    function completeTask(taskId) {
      return fetch(API + '/api/tasks/' + taskId + '/complete', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + TOKEN },
      }).then(function(res) {
        if (res.ok) return res.json();
        return null;
      }).catch(function(e) {
        log('in', 'ERROR completing task: ' + e.message);
        return null;
      });
    }

    function hostCtx() {
      return {
        theme: theme,
        displayMode: 'inline',
        containerDimensions: { width: 500, maxHeight: 600 },
        styles: {
          variables: {
            '--color-background-primary': theme === 'dark' ? '#1a1a1a' : '#ffffff',
            '--color-text-primary': theme === 'dark' ? '#e0e0e0' : '#1a1a1a',
          },
          css: {},
        },
      };
    }

    window.addEventListener('message', function(event) {
      if (event.source !== frame.contentWindow) return;
      var msg = event.data;
      if (!msg || msg.jsonrpc !== '2.0') return;

      log('in', msg.method || ('response #' + msg.id));

      if (msg.id && msg.method) {
        if (msg.method === 'ui/initialize') {
          var resp = {
            jsonrpc: '2.0', id: msg.id,
            result: {
              protocolVersion: '2026-01-26',
              hostCapabilities: {
                serverTools: { listChanged: false },
                serverResources: { listChanged: false },
              },
              hostInfo: { name: 'dev-harness', version: '1.0.0' },
              hostContext: hostCtx(),
            },
          };
          log('out', 'ui/initialize response');
          frame.contentWindow.postMessage(resp, '*');
        } else if (msg.method === 'tools/call') {
          var name = msg.params && msg.params.name;
          var args = (msg.params && msg.params.arguments) || {};
          log('in', 'tools/call: ' + name);

          if (name === 'list_tasks') {
            fetchTasks(args.statuses).then(function(t) {
              frame.contentWindow.postMessage({
                jsonrpc: '2.0', id: msg.id,
                result: {
                  content: [{ type: 'text', text: JSON.stringify({ tasks: t }) }],
                  structuredContent: { tasks: t },
                },
              }, '*');
              log('out', 'list_tasks result (' + t.length + ' tasks)');
            });
          } else if (name === 'complete_task') {
            completeTask(args.task_id).then(function(result) {
              frame.contentWindow.postMessage({
                jsonrpc: '2.0', id: msg.id,
                result: {
                  content: [{ type: 'text', text: JSON.stringify(result) }],
                  structuredContent: result,
                },
              }, '*');
              log('out', 'complete_task result');
            });
          } else {
            frame.contentWindow.postMessage({
              jsonrpc: '2.0', id: msg.id,
              error: { code: -32601, message: 'Not implemented in harness: ' + name },
            }, '*');
          }
        } else {
          frame.contentWindow.postMessage({
            jsonrpc: '2.0', id: msg.id, result: {},
          }, '*');
        }
      }

      if (msg.method && !('id' in msg)) {
        if (msg.method === 'ui/notifications/size-changed') {
          var h = msg.params && msg.params.height;
          if (h) frame.style.height = Math.min(h + 2, 600) + 'px';
        }
      }
    });

    function sendToolResult() {
      fetchTasks().then(function() {
        frame.contentWindow.postMessage({
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: {
            content: [{ type: 'text', text: JSON.stringify({ tasks: tasks }) }],
            structuredContent: { tasks: tasks },
          },
        }, '*');
        log('out', 'tool-result notification');
      });
    }

    function toggleTheme() {
      theme = theme === 'dark' ? 'light' : 'dark';
      document.body.style.background = theme === 'dark' ? '#111' : '#f5f5f5';
      document.body.style.color = theme === 'dark' ? '#e0e0e0' : '#333';
      frame.contentWindow.postMessage({
        jsonrpc: '2.0',
        method: 'ui/notifications/host-context-changed',
        params: hostCtx(),
      }, '*');
      log('out', 'host-context-changed (theme: ' + theme + ')');
    }

    // Load the app HTML from a separate endpoint
    fetch('/dev/app-html').then(function(r) { return r.text(); }).then(function(html) {
      frame.srcdoc = html;
    });
  </script>
</body>
</html>`;
}
