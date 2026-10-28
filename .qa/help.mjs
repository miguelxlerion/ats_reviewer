import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = process.cwd();
const PUB = join(ROOT, "public");
const HTTP_PORT = 8767;
const CDP_PORT = 9336;
const SHOTS = join(ROOT, ".qa/screens");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

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
  `--user-data-dir=${join(ROOT, ".qa/chrome-profile-help")}`,
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
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) {
    const d = res.result.exceptionDetails;
    throw new Error(d.exception?.description || d.text);
  }
  return res.result?.result?.value;
}

async function waitFor(expression, label, tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expression).catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`Timeout esperando: ${label}`);
}

async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, name), Buffer.from(res.result.data, "base64"));
  console.log(`captura ${name}`);
}

async function pressEscape() {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}

await send("Page.enable");
await send("Runtime.enable");

// 1) icon assets
const assets = [
  "/favicon.ico", "/icons/favicon-16.png", "/icons/favicon-32.png", "/icons/favicon-48.png",
  "/icons/apple-touch-icon.png", "/icons/icon-192.png", "/icons/icon-512.png", "/site.webmanifest",
];
for (const path of assets) {
  const r = await fetch(`http://127.0.0.1:${HTTP_PORT}${path}`);
  if (r.status !== 200 || Number(r.headers.get("content-length") || 1) === 0) {
    throw new Error(`Asset ${path}: HTTP ${r.status}`);
  }
}
const manifest = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/site.webmanifest`)).json();
if (manifest.icons.length !== 2) throw new Error("Manifest sin los dos iconos");
console.log("iconos y manifest OK");

// 2) desktop help
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/index.html` });
await waitFor(`typeof openHelp === "function" && !!document.querySelector(".cv-page .cv-section")`, "builder listo");
const links = await evaluate(`[...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')].map(l => l.getAttribute("href"))`);
console.log("links de icono:", links.join(", "));

await evaluate(`document.getElementById("btnHelp").click(); true`);
await waitFor(`document.getElementById("helpDialog").open`, "diálogo abierto");
await sleep(250);
await shot("help_desktop.png");

const esText = await evaluate(`document.getElementById("helpDialog").innerText`);
if (!esText.includes("esposa mía")) throw new Error("Falta la nota personal en español");
if (!esText.includes("— Miguel")) throw new Error("Falta la firma en español");
if ((await evaluate(`document.querySelectorAll("#helpSteps li").length`)) !== 5) throw new Error("Se esperaban 5 pasos");
const dialogBox = await evaluate(`(() => { const r = document.getElementById("helpDialog").getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top, bottom: r.bottom }; })()`);
if (dialogBox.w > 640 || dialogBox.top < 0 || dialogBox.bottom > 900) throw new Error(`Diálogo fuera de vista: ${JSON.stringify(dialogBox)}`);

await pressEscape();
await sleep(200);
if (await evaluate(`document.getElementById("helpDialog").open`)) throw new Error("Esc no cerró el diálogo");

// 3) backdrop click closes
await evaluate(`document.getElementById("btnHelp").click(); true`);
await waitFor(`document.getElementById("helpDialog").open`, "diálogo reabierto");
await sleep(150);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 6, y: 6, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 6, y: 6, button: "left", clickCount: 1 });
await sleep(200);
if (await evaluate(`document.getElementById("helpDialog").open`)) throw new Error("El clic en el fondo no cerró el diálogo");

// 4) English content
await evaluate(`setLang("en"); document.getElementById("btnHelp").click(); true`);
await waitFor(`document.getElementById("helpDialog").open`, "diálogo EN");
await sleep(250);
const enText = await evaluate(`document.getElementById("helpDialog").innerText`);
if (!enText.includes("my wife") || !enText.includes("— Miguel")) throw new Error("Nota personal EN incompleta");
await shot("help_en_desktop.png");
await evaluate(`document.getElementById("helpDialog").close(); setLang("es"); true`);

// 5) mobile
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(300);
const overflow = await evaluate(`document.documentElement.scrollWidth > window.innerWidth`);
if (overflow) throw new Error("Desbordamiento horizontal en móvil");
await shot("help_mobile_closed.png");
const helpBtn = await evaluate(`(() => {
  const b = document.getElementById("btnHelp").getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, vw: innerWidth };
})()`);
if (helpBtn.w < 40 || helpBtn.h < 20) throw new Error(`Botón de ayuda invisible en móvil: ${JSON.stringify(helpBtn)}`);
if (helpBtn.x > helpBtn.vw) throw new Error(`Botón de ayuda fuera de pantalla: ${JSON.stringify(helpBtn)}`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: helpBtn.x, y: helpBtn.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: helpBtn.x, y: helpBtn.y, button: "left", clickCount: 1 });
await waitFor(`document.getElementById("helpDialog").open`, "diálogo móvil");
await sleep(300);
const mobile = await evaluate(`(() => {
  const d = document.getElementById("helpDialog").getBoundingClientRect();
  const body = document.querySelector(".help-body");
  return { w: d.width, h: d.height, vw: innerWidth, vh: innerHeight, scrollable: body.scrollHeight > body.clientHeight };
})()`);
if (mobile.w > 390 || mobile.h > 844) throw new Error(`Diálogo no cabe en móvil: ${JSON.stringify(mobile)}`);
await shot("help_mobile.png");

console.log(`móvil · diálogo ${Math.round(mobile.w)}×${Math.round(mobile.h)} · scroll interno: ${mobile.scrollable}`);

// 6) printing while help is open must not leak the modal into the PDF
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await evaluate(`document.getElementById("helpDialog").close(); document.getElementById("btnHelp").click(); true`);
await waitFor(`document.getElementById("helpDialog").open`, "diálogo para impresión");
await sleep(200);
const pdf = await send("Page.printToPDF", { printBackground: false, preferCSSPageSize: true });
if (!pdf.result?.data) throw new Error("printToPDF sin datos");
writeFileSync(join(ROOT, ".qa/help_open_print.pdf"), Buffer.from(pdf.result.data, "base64"));
console.log("PDF con ayuda abierta · .qa/help_open_print.pdf");

// 7) file:// sanity check — opening the HTML directly must still load the icon and the dialog
await send("Page.navigate", { url: "file:///G:/Trabajos/JulietteCV/public/index.html" });
await waitFor(`typeof openHelp === "function" && !!document.querySelector(".cv-page .cv-section")`, "file:// listo");
const iconLoaded = await evaluate(`(() => { const im = document.querySelector(".help-head img"); return !!im && im.complete && im.naturalWidth > 0; })()`);
if (!iconLoaded) throw new Error("El icono del diálogo no carga en file://");
await evaluate(`document.getElementById("btnHelp").click(); true`);
await waitFor(`document.getElementById("helpDialog").open`, "diálogo en file://");
await evaluate(`document.getElementById("helpDialog").close(); true`);
console.log("file:// OK");

console.log("HELP_OK");
process.exit(0);
