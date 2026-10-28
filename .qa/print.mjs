import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL_FILE = "file:///G:/Trabajos/JulietteCV/public/index.html";
const PORT = 9334;
const OUT = {
  en: "G:/Trabajos/JulietteCV/Juliette_Gonzalez_Strategic_Sourcing_Specialist.pdf",
  es: "G:/Trabajos/JulietteCV/Juliette_Gonzalez_Especialista_Sourcing_Estrategico.pdf",
};
const SHOT = {
  en: "G:/Trabajos/JulietteCV/.qa/screens/skills_en.png",
  es: "G:/Trabajos/JulietteCV/.qa/screens/skills_es.png",
};
const EXPECTED_TITLE = {
  en: "Strategic Sourcing Specialist",
  es: "Especialista en Sourcing Estratégico",
};

const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.cwd()}/.qa/chrome-profile-print`,
  "about:blank",
], { stdio: "ignore" });

let ws;
const shutdown = () => {
  try { ws?.close(); } catch {}
  try { chrome.kill(); } catch {}
};
process.on("exit", shutdown);

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

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1200, height: 1400, deviceScaleFactor: 1, mobile: false,
});
await send("Page.navigate", { url: URL_FILE });

let ready = false;
for (let i = 0; i < 80 && !ready; i++) {
  ready = await evaluate(
    `location.href.startsWith("file:") && typeof buildCV === "function" && !!document.querySelector(".cv-page")`
  ).catch(() => false);
  if (!ready) await sleep(150);
}
if (!ready) {
  const state = await evaluate(`({ href: location.href, state: document.readyState })`).catch(() => null);
  throw new Error(`La página no cargó: ${JSON.stringify(state)}`);
}
await sleep(400);

for (const lang of ["en", "es"]) {
  const info = await evaluate(`(() => {
    currentLang = "${lang}";
    localStorage.setItem("cv_html_${lang}", buildCV(CV_DATA.${lang}));
    localStorage.setItem("cv_ver_${lang}", DATA_VERSION);
    renderUI();
    renderCV();
    return {
      title: document.querySelector(".cv-page .cv-title").textContent,
      h2s: [...document.querySelectorAll(".cv-page h2")].map(h => h.textContent),
      skills: document.querySelector(".cv-skills")?.textContent ?? null
    };
  })()`);

  if (info?.title !== EXPECTED_TITLE[lang] || info.skills !== (lang === "en"
      ? "SAP Ariba, Coupa, SAP (Iberian, MDG, B1), SSP-SRM, Prism, Power BI, Advanced Excel, Microsoft Office"
      : "SAP Ariba, Coupa, SAP (Iberian, MDG, B1), SSP-SRM, Prism, Power BI, Excel avanzado, Microsoft Office")) {
    throw new Error(`Render inesperado para ${lang}: ${JSON.stringify(info)}`);
  }
  console.log(lang.toUpperCase(), JSON.stringify(info));

  const rect = await evaluate(`(() => {
    const r = document.querySelector(".cv-page").getBoundingClientRect();
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
  })()`);
  const shot = await send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: true,
    clip: { ...rect, scale: 1 },
  });
  writeFileSync(SHOT[lang], Buffer.from(shot.result.data, "base64"));

  const pdf = await send("Page.printToPDF", {
    printBackground: true, preferCSSPageSize: true,
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
  });
  writeFileSync(OUT[lang], Buffer.from(pdf.result.data, "base64"));
  console.log("PDF:", OUT[lang]);
}

ws.close();
chrome.kill();
