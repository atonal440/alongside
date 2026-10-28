// Prompt lab for on-device task entry. Starts llama-server (CPU, small context, greedy)
// to approximate what a phone's small local model can do, and scores three strategies
// on the non-date fields (dates are meant to be resolved in code, not by the model):
//   json   one prompt, grammar-constrained JSON       (llama.cpp only; not available on phones)
//   free   one prompt, schema in the prompt text, parse + one retry   (like the ML Kit Prompt API)
//   split  one short question per field, plain text answers
// Models and binaries live outside the repo: $ALONGSIDE_AI_DIR (default ~/ai).
//   node scripts/llm-lab/run.mjs [model-file] [cases.json]
// Env: LLM_MODES=json,free,split  LLM_CTX=2048  LLM_THREADS=6  LLM_NGL=0
//   GPU: LLM_BUILD=llama.cpp-cuda LLM_NGL=99 (timings then say nothing about a phone)
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from './nlparse.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.ALONGSIDE_AI_DIR ?? join(homedir(), 'ai');
const modelName = process.argv[2] ?? 'gemma-3n-E2B-it-Q4_0.gguf';
const model = join(root, 'models', modelName);
const cases = JSON.parse(readFileSync(process.argv[3] ?? join(here, 'cases.json'), 'utf8'));
const server = join(root, process.env.LLM_BUILD ?? 'llama.cpp', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
const port = 8099, threads = process.env.LLM_THREADS ?? '6', ctx = process.env.LLM_CTX ?? '2048';
const modes = (process.env.LLM_MODES ?? 'json,free,split').split(',');
const prepass = process.env.LLM_PREPASS === '1';
if (!existsSync(model) || !existsSync(server)) throw new Error(`missing ${model} or ${server}`);

const schema = {
  type: 'object', additionalProperties: false,
  required: ['title', 'recurrence', 'notes', 'task_type'],
  properties: {
    title: { type: 'string' },
    recurrence: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
    task_type: { enum: ['action', 'plan'] },
  },
};

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const header = readFileSync(join(here, 'prompt.txt'), 'utf8')
  .replace('{{now}}', `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`)
  .replace('{{weekday}}', now.toLocaleDateString('en-US', { weekday: 'long' }))
  .replace('{{tz}}', Intl.DateTimeFormat().resolvedOptions().timeZone);
const fieldHelp = readFileSync(join(here, 'fields.txt'), 'utf8');

const questions = {
  title: 'Reply with only the short imperative task title, leaving out any date or time words.',
  recurrence: 'Does this task repeat? Reply with only an iCalendar RRULE such as FREQ=WEEKLY;BYDAY=MO, or the word none.',
  task_type: 'Is this one thing to do ("action") or a goal that needs breaking into steps ("plan")? Reply with only action or plan.',
  notes: 'Is there extra detail that does not belong in the title? Reply with only that detail, or the word none.',
};

const proc = spawn(server, ['-m', model, '--port', String(port), '-c', ctx, '-t', threads,
  '-ngl', process.env.LLM_NGL ?? '0', '--no-webui'], { stdio: 'ignore' });
const stop = () => proc.kill();
process.on('exit', stop);

const chat = async (messages, extra = {}) => (await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ temperature: 0, max_tokens: 160, messages, ...extra }),
})).json()).choices?.[0]?.message?.content ?? '';

const clean = (s) => s.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
const noneish = (s) => s == null || /^(none|null|n\/a|no|)\.?$/i.test(String(s).trim());

function parseJson(text) {
  let o; try { o = JSON.parse(clean(text)); } catch { return null; }
  if (!o || typeof o.title !== 'string' || !o.title || !['action', 'plan'].includes(o.task_type)) return null;
  return { title: o.title, recurrence: noneish(o.recurrence) ? null : o.recurrence, notes: noneish(o.notes) ? null : o.notes, task_type: o.task_type };
}

const strategies = {
  async json(input) {
    const text = await chat([{ role: 'system', content: `${header}${fieldHelp}\nReply with JSON only.` }, { role: 'user', content: input }],
      { response_format: { type: 'json_schema', json_schema: { name: 'task', strict: true, schema } } });
    return { value: parseJson(text), calls: 1, raw: text };
  },
  async free(input) {
    // An example, not the raw schema: small models tend to echo a schema back instead of filling it in.
    const sys = `${header}${fieldHelp}\nReply with a single JSON object and nothing else, like this:\n`
      + `Entry: return Sam's drill\n{"title":"Return Sam's drill","recurrence":null,"notes":null,"task_type":"action"}`;
    let text = await chat([{ role: 'system', content: sys }, { role: 'user', content: input }]), v = parseJson(text), calls = 1;
    if (!v) { text = await chat([{ role: 'system', content: sys }, { role: 'user', content: input }]); v = parseJson(text); calls++; }
    return { value: v, calls, raw: text };
  },
  async split(input) {
    const out = {}; let raw = '';
    for (const [k, q] of Object.entries(questions)) {
      // Same system + entry first so the server's prompt cache covers the shared prefix.
      const a = clean(await chat([{ role: 'system', content: header + fieldHelp },
        { role: 'user', content: `Task entry: ${input}\n\n${q}` }], { max_tokens: 40 })).split('\n')[0].replace(/^"|"$/g, '');
      out[k] = a; raw += `${k}=${a} | `;
    }
    const tt = /plan/i.test(out.task_type) ? 'plan' : 'action';
    return { value: out.title ? { title: out.title, recurrence: noneish(out.recurrence) ? null : out.recurrence.replace(/^RRULE:/i, ''), notes: noneish(out.notes) ? null : out.notes, task_type: tt } : null, calls: 4, raw };
  },
};

const canonRule = (r) => r == null ? null : r.replace(/^RRULE:/i, '').toUpperCase().split(';').filter(Boolean)
  .map((p) => { const [k, v = ''] = p.split('='); return k === 'BYDAY' ? `${k}=${v.split(',').sort()}` : p; }).sort().join(';');
const words = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

function score(v, c) {
  if (!v) return { title: 0, recurrence: 0, task_type: 0, notes: 0 };
  const tw = words(v.title);
  return {
    title: c.title.every((w) => tw.includes(w)) && tw.length <= c.title.length + 2 ? 1 : 0,
    recurrence: canonRule(v.recurrence) === canonRule(c.recurrence) ? 1 : 0,
    task_type: v.task_type === c.task_type ? 1 : 0,
    notes: (v.notes != null) === c.notes ? 1 : 0,
  };
}

try {
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`model=${modelName} ctx=${ctx} threads=${threads} ngl=${process.env.LLM_NGL ?? 0} cases=${cases.length}\n`);
  const summary = [];
  for (const mode of modes) {
    const tot = { title: 0, recurrence: 0, task_type: 0, notes: 0 }; let unparsed = 0, ms = 0, calls = 0;
    console.log(`=== ${mode}`);
    for (const c of cases) {
      const t0 = performance.now();
      // LLM_PREPASS=1: the deterministic parser takes dates and recurrence out first; the model sees the rest.
      const pre = prepass ? parse(c.in) : null;
      const r = await strategies[mode](pre ? pre.rest : c.in);
      if (pre && r.value) r.value.recurrence = pre.recurrence;
      ms += performance.now() - t0; calls += r.calls;
      const s = score(r.value, c);
      if (!r.value) unparsed++;
      for (const k in s) tot[k] += s[k];
      const bad = Object.keys(s).filter((k) => !s[k]);
      if (bad.length) console.log(`  ${c.in}\n    wrong: ${bad.join(',')}  got ${r.value ? JSON.stringify(r.value) : 'UNPARSEABLE ' + r.raw.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    const n = cases.length;
    summary.push({ mode, ...Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, `${v}/${n}`])), unparsed, 'ms/entry': Math.round(ms / n), 'calls/entry': +(calls / n).toFixed(1) });
    console.log();
  }
  console.table(summary);
} finally { stop(); }
