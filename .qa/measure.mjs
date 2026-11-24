import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL_FILE = "file:///G:/Trabajos/JulietteCV/public/index.html";
const WIDTH = Number(process.argv[2] || 390);
const SHOT = process.argv[3];
const PORT = 9333;

const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.cwd()}/.qa/chrome-profile`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome DevTools not reachable");
}

const ws = new WebSocket(await getTarget());
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

function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((r) => pending.set(mid, r));
}

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: WIDTH < 1080,
});
const nav = await send("Page.navigate", { url: URL_FILE });
if (nav.result?.errorText) throw new Error(nav.result.errorText);
for (let i = 0; i < 40; i++) {
  const ready = await send("Runtime.evaluate", {
    expression: "!!document.querySelector('.cv-page .cv-section')",
    returnByValue: true,
  });
  if (ready.result?.result?.value === true) break;
  await sleep(150);
}
await sleep(300);

const expr = `(() => {
  const vw = window.innerWidth;
  const offenders = [...document.querySelectorAll("*")]
    .map(el => { const r = el.getBoundingClientRect(); return {el, r}; })
    .filter(({r}) => r.right > vw + 0.5)
    .map(({el, r}) => el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "") + " right=" + Math.round(r.right) + " width=" + Math.round(r.width) + " text=\\"" + (el.textContent || "").trim().slice(0, 50) + "\\"")
    .slice(0, 12);
  return {
    vw,
    docScrollW: document.documentElement.scrollWidth,
    docScrollH: document.documentElement.scrollHeight,
    cvH: Math.round(document.querySelector(".cv-page").getBoundingClientRect().height),
    layoutW: Math.round(document.querySelector(".layout").getBoundingClientRect().width),
    colW: Math.round(document.querySelector(".cv-column").getBoundingClientRect().width),
    wrapW: Math.round(document.querySelector(".cv-column > div").getBoundingClientRect().width),
    pageW: Math.round(document.querySelector(".cv-page").getBoundingClientRect().width),
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
    offenders
  };
})()`;

const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
console.log(JSON.stringify(res.result?.result?.value ?? res, null, 2));

if (SHOT) {
  const hRes = await send("Runtime.evaluate", {
    expression: "document.documentElement.scrollHeight", returnByValue: true,
  });
  const h = hRes.result.result.value;
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: WIDTH, height: h, scale: 1 },
  });
  writeFileSync(SHOT, Buffer.from(shot.result.data, "base64"));
  console.log("screenshot:", SHOT, WIDTH + "x" + h);
}

ws.close();
chrome.kill();
