import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = process.cwd();
const PUB = join(ROOT, "public");
const HTTP_PORT = 8766;
const CDP_PORT = 9335;
const SHOT = join(ROOT, ".qa/screens/ats_section.png");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

const server = createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = normalize(join(PUB, url));
  if (!file.startsWith(PUB + sep)) { res.writeHead(403).end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) { res.writeHead(404).end("not found"); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));

const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${join(ROOT, ".qa/chrome-profile-ats")}`,
  "about:blank",
], { stdio: "ignore" });

let ws;
const close = () => {
  try { ws?.close(); } catch {}
  try { chrome.kill(); } catch {}
  try { server.close(); } catch {}
};
process.on("exit", close);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome DevTools not reachable");
}

ws = new WebSocket(await getTarget());
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) => {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((r) => pending.set(mid, r));
};

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (res.result?.exceptionDetails) {
    const d = res.result.exceptionDetails;
    throw new Error(d.exception?.description || d.text);
  }
  return res.result?.result?.value;
}

async function waitFor(expression, label, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expression).catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`Timeout esperando: ${label}`);
}

const frameText = `document.getElementById("atsFrame")?.contentDocument?.body?.innerText || ""`;

const MARKER = { en: "Procurement Negotiator & Analyst (LATAM)", es: "Negociadora y Analista de Procurement (LATAM)" };

async function analyze(lang) {
  await evaluate(`setLang("${lang}"); runAts(); true`);
  const header = `VEREDICTO · CV ACTUAL (${lang.toUpperCase()})`;
  let text = "";
  let prev = null;
  for (let i = 0; i < 100; i++) {
    text = await evaluate(frameText).catch(() => "");
    if (text && text.includes(header) && text.includes(MARKER[lang]) && text === prev) break;
    prev = text;
    await sleep(150);
  }
  if (!text.includes(header)) throw new Error(`Timeout esperando el veredicto ${lang}`);
  if (!text.includes("Schneider Electric Colombia")) {
    throw new Error(`El revisor no leyó Schneider (${lang}): ${text.slice(0, 600)}`);
  }
  const row = text.match(/Schneider Electric Colombia[^\n]*/)?.[0] ?? "";
  const bullets = Number(row.trim().split(/\s+/).pop());
  if (!(bullets >= 5)) throw new Error(`Viñetas de Schneider en ${lang}: ${bullets} (esperado 5)`);
  const chrono = text.slice(text.indexOf("Cronología detectada"), text.indexOf("Hallazgos por impacto"));
  const rows = chrono.split("\n").filter((l) => /^.+?\t.+?\t\d+\t\d+$/.test(l.trim()));
  if (rows.length !== 4) throw new Error(`Cargos detectados en ${lang}: ${rows.length} (esperado 4)\n${chrono}`);
  if (!/2010[^\n]*\t33\t1/.test(chrono)) throw new Error(`Falta el cargo 2010–2013 en ${lang}\n${chrono}`);
  if (text.includes("projects")) throw new Error(`Sección fantasma "projects" en ${lang}`);
  const verdict = text.match(/VEREDICTO[^\n]*\n+([^\n]+)/)?.[1] ?? "";
  console.log(`${lang.toUpperCase()} · ${verdict} · Schneider ${bullets} viñetas · ${rows.length} cargos`);
  return text;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/` });

await waitFor(`typeof runAts === "function" && !!document.querySelector(".cv-page .cv-section")`, "builder listo");
await sleep(400);

await analyze("en");
await analyze("es");

await sleep(3000);

const rect = await evaluate(`(() => {
  const r = document.getElementById("atsSection").getBoundingClientRect();
  return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
})()`);
const shot = await send("Page.captureScreenshot", {
  format: "png", captureBeyondViewport: true,
  clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
});
writeFileSync(SHOT, Buffer.from(shot.result.data, "base64"));
console.log(`Sección ATS: ${Math.round(rect.width)}x${Math.round(rect.height)} px → ${SHOT}`);

await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
await sleep(600);
const mobile = await evaluate(`(() => {
  const r = document.getElementById("atsSection").getBoundingClientRect();
  return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, overflowX: document.documentElement.scrollWidth > window.innerWidth };
})()`);
if (mobile.overflowX) throw new Error("Overflow horizontal en móvil con la sección ATS");
const shotM = await send("Page.captureScreenshot", {
  format: "png", captureBeyondViewport: true,
  clip: { x: mobile.x, y: mobile.y, width: mobile.width, height: mobile.height, scale: 1 },
});
writeFileSync(SHOT.replace(".png", "_mobile.png"), Buffer.from(shotM.result.data, "base64"));
console.log(`Móvil: ${Math.round(mobile.width)}x${Math.round(mobile.height)} px, sin overflow`);

close();
