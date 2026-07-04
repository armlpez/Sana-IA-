#!/usr/bin/env node
/**
 * Local battery — end-to-end smoke test against a LOCAL Sana-IA backend.
 *
 * Runs two modes (BATTERY_MODE env):
 *   happy    (default) — auth, multi-turn chat, OCR+S3 roundtrip, PDF report.
 *   fallback           — auth, chat that MUST hit the SafeFallback, then verifies
 *                        the failure metadata persisted WHICH model failed
 *                        (metadata.failure.failedProvider + attemptedProviders),
 *                        read back via GET /v1/ai/conversations/:id.
 *
 * Node 22+ (native fetch / FormData / Blob). No external deps.
 *
 * Env:
 *   BASE_URL      default http://localhost:3000
 *   BATTERY_MODE  happy | fallback   (default happy)
 *   LAB_IMAGE     path to a lab image for the OCR step
 *   EMAIL/PASSWORD  seed user creds (default user@gmail.com / 12345678)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const MODE = process.env.BATTERY_MODE || 'happy';
const EMAIL = process.env.EMAIL || 'user@gmail.com';
const PASSWORD = process.env.PASSWORD || '12345678';
const LAB_IMAGE =
  process.env.LAB_IMAGE ||
  '/mnt/c/Users/ajlopez/.gemini/antigravity/brain/bf2fa469-4238-4d6e-a203-fc61a3010103/medical_lab_report_1783179636922.png';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ' — ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const res = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const token = body.access_token || body.accessToken;
  if (!token) throw new Error(`login returned no access_token: ${JSON.stringify(body)}`);
  return token;
}

async function chatTurn(token, message, conversationId) {
  const body = { message };
  if (conversationId) body.conversationId = conversationId;
  const res = await fetch(`${BASE}/v1/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------

async function runHappy(token) {
  console.log('\n== FASE: CHAT (happy path) ==');
  const messages = [
    'Hola, tengo 45 años. Desde hace 3 semanas me siento muy cansado, con mucha sed y orino demasiado de noche.',
    'Tambien he bajado de peso sin proponermelo y a veces se me nubla la vista.',
    'Me hice examenes de sangre. Con estos sintomas, dame por favor tu analisis y diagnostico final.',
  ];
  let convId = null;
  let lastStatus = null;
  for (const msg of messages) {
    const { status, json } = await chatTurn(token, msg, convId);
    if (status !== 200) {
      record('chat turn', false, `HTTP ${status}`);
      break;
    }
    convId = json.conversationId ?? convId;
    lastStatus = json.status;
    console.log(`     paciente> ${msg.slice(0, 60)}...`);
    console.log(`     sana-ia < [${json.status}] ${String(json.message).slice(0, 90)}...`);
  }
  record('chat multi-turn responde 200 + mensaje', convId != null, `convId=${convId}, status=${lastStatus}`);

  // Nudge toward completion so the report precondition (COMPLETED + diagnosis) can be met.
  if (convId && lastStatus !== 'completed') {
    const { json } = await chatTurn(
      token,
      'Con la evidencia que tienes, entrega el diagnostico final y el especialista sugerido.',
      convId,
    );
    lastStatus = json.status ?? lastStatus;
    console.log(`     sana-ia < [${json.status}] ${String(json.message).slice(0, 90)}...`);
  }
  record('chat alcanza estado completed', lastStatus === 'completed', `status=${lastStatus}`);

  // --- OCR + S3 ---
  console.log('\n== FASE: OCR + S3 ==');
  let ocrOk = false;
  let biomarkers = 0;
  try {
    const buf = readFileSync(LAB_IMAGE);
    const fd = new FormData();
    fd.append('image', new Blob([buf], { type: 'image/png' }), 'report.png');
    fd.append('consultationId', String(convId));
    const up = await fetch(`${BASE}/v1/ocr/analyze`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    const upJson = await up.json().catch(() => ({}));
    const jobId = upJson.jobId;
    // NestJS POST defaults to HTTP 201; the controller carries 202 in the body only.
    record('OCR upload (S3 save) → 201/202 + jobId', (up.status === 201 || up.status === 202) && !!jobId, `HTTP ${up.status}, jobId=${jobId}`);

    if (jobId) {
      const deadline = Date.now() + 90_000;
      let jobStatus = 'queued';
      while (Date.now() < deadline) {
        const jr = await fetch(`${BASE}/v1/ocr/jobs/${jobId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const jj = await jr.json().catch(() => ({}));
        jobStatus = jj.status;
        if (jobStatus === 'completed') {
          biomarkers = jj.extractedData?.biomarkers?.length ?? 0;
          ocrOk = true;
          break;
        }
        if (jobStatus === 'failed') break;
        await sleep(2500);
      }
      // Reaching 'completed' proves S3 save + worker S3 get + remove all executed.
      record('OCR job completa (S3 get+remove por el worker)', ocrOk, `status=${jobStatus}, biomarkers=${biomarkers}`);
      record('OCR extrajo biomarcadores', biomarkers > 0, `${biomarkers} biomarcadores`);
    }
  } catch (e) {
    record('OCR + S3', false, e.message);
  }

  // --- Report (PDF) ---
  console.log('\n== FASE: REPORTE (PDF) ==');
  try {
    const rep = await fetch(`${BASE}/v1/consultations/${convId}/report`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (rep.status === 200) {
      const bytes = Buffer.from(await rep.arrayBuffer());
      const isPdf = bytes.slice(0, 5).toString('latin1') === '%PDF-';
      const out = `/tmp/sana-report-${convId}.pdf`;
      if (isPdf) writeFileSync(out, bytes);
      record('reporte devuelve PDF válido', isPdf, isPdf ? `${bytes.length} bytes → ${out}` : 'no es PDF');
    } else {
      const t = await rep.text();
      record('reporte devuelve PDF válido', false, `HTTP ${rep.status}: ${t.slice(0, 120)} (¿consulta no completed?)`);
    }
  } catch (e) {
    record('reporte', false, e.message);
  }
}

// ---------------------------------------------------------------------------

async function runFallback(token) {
  console.log('\n== FASE: FALLBACK + metadata (qué modelo falló) ==');
  const { status, json } = await chatTurn(
    token,
    'Hola, me duele la cabeza desde ayer, ¿qué me recomiendas?',
  );
  // The service must NEVER 500 — it degrades to a safe fallback message.
  record('chat con proveedores caídos responde 200 (no 500)', status === 200, `HTTP ${status}`);
  const convId = json.conversationId;
  console.log(`     sana-ia < ${String(json.message).slice(0, 100)}...`);

  if (!convId) {
    record('recupera metadata.failure.failedProvider', false, 'sin conversationId');
    return;
  }

  // Read the persisted metadata back the way an operator would: from the DB via the API.
  const conv = await fetch(`${BASE}/v1/ai/conversations/${convId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const convJson = await conv.json().catch(() => ({}));
  const msgs = convJson.messages || [];
  const assistant = [...msgs].reverse().find((m) => m.role === 'assistant');
  const failure = assistant?.metadata?.failure;

  record(
    'metadata persiste failedProvider',
    !!failure?.failedProvider,
    `failedProvider=${failure?.failedProvider}`,
  );
  record(
    'metadata persiste attemptedProviders (cadena completa)',
    Array.isArray(failure?.attemptedProviders) && failure.attemptedProviders.length > 0,
    `attempted=[${(failure?.attemptedProviders || []).join(' -> ')}], errorKind=${failure?.errorKind}`,
  );
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n=== BATERÍA LOCAL — modo: ${MODE} — base: ${BASE} ===`);
  let token;
  try {
    token = await login();
    record('auth login', true, 'token obtenido');
  } catch (e) {
    record('auth login', false, e.message);
    summary();
    process.exit(1);
  }

  if (MODE === 'fallback') await runFallback(token);
  else await runHappy(token);

  summary();
}

function summary() {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log('\n=== RESUMEN ===');
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n  ${pass}/${results.length} checks OK` + (fail ? `  (\x1b[31m${fail} fallaron\x1b[0m)` : '  \x1b[32m✓\x1b[0m'));
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error('battery crashed:', e);
  process.exit(1);
});
