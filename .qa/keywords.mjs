import { readFileSync } from "node:fs";

const html = readFileSync("public/index.html", "utf8");
const start = html.indexOf("const CV_DATA");
const end = html.indexOf("const UI =", start);
const CV_DATA = new Function(html.slice(start, end) + "; return CV_DATA;")();

const STOP = new Set(
  ("the and for with of in to a an y de en la el los las con para por del al un una que se su sus es son mas " +
   "at least al menos as through mediante from by on or o u across five countries paises anos years")
    .split(/\s+/).filter(Boolean)
);

const norm = (s) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const words = (s) => norm(s).match(/[a-z0-9/+€.%-]+/g) || [];

function fieldsOf(d) {
  const f = [{ label: "summary", text: d.summaryText }];
  d.competencies.forEach((c, i) => f.push({ label: `competency[${i}]`, text: `${c[0]} ${c[1]}` }));
  f.push({ label: "skills", text: d.skills.join(", ") });
  d.jobs.forEach((j) =>
    j.bullets.forEach((b, i) => f.push({ label: `bullet "${j.company.split(" –")[0]}" #${i + 1}`, text: b }))
  );
  d.education.forEach((e, i) => f.push({ label: `education[${i}]`, text: e }));
  return f;
}

for (const lang of ["en", "es"]) {
  const d = CV_DATA[lang];
  const fields = fieldsOf(d);
  console.log("=".repeat(80));
  console.log(lang.toUpperCase(), "| palabras repetidas dentro del MISMO campo");
  for (const { label, text } of fields) {
    const w = words(text).filter((x) => x.length > 3 && !STOP.has(x));
    const dup = [...new Set(w)].filter((x) => w.filter((y) => y === x).length > 1);
    if (dup.length) {
      console.log(`  ! ${label}: ${dup.map((x) => `${x} x${w.filter((y) => y === x).length}`).join(", ")}`);
      console.log(`    ${text}`);
    }
  }

  console.log("-".repeat(80));
  console.log(lang.toUpperCase(), "| frases de 3+ palabras repetidas entre campos");
  const seen = new Map();
  for (const { label, text } of fields) {
    const w = words(text);
    for (let n = 3; n <= 6; n++) {
      for (let i = 0; i + n <= w.length; i++) {
        const gram = w.slice(i, i + n).join(" ");
        if (!seen.has(gram)) seen.set(gram, new Set());
        seen.get(gram).add(label);
      }
    }
  }
  const repeats = [...seen.entries()]
    .filter(([, where]) => where.size > 1)
    .sort((a, b) => b[0].split(" ").length - a[0].split(" ").length || b[1].size - a[1].size);
  const longest = repeats.filter(([g]) => !repeats.some(([h]) => h !== g && h.includes(g + " ") && h.length > g.length));
  for (const [gram, where] of longest) {
    console.log(`  ${[...where].join(" + ")}\n    "${gram}"`);
  }
}
