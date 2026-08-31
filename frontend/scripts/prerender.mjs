// Post-build SEO prerender: writes static HTML for /templates and each /t/{slug}
// with route-specific <title>, description, and Open Graph tags, plus a <noscript>
// content block for non-JS crawlers/social scrapers. The SPA bundle still hydrates
// the full app on load. Run after `vite build` (see package.json build script).
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { marked } from "marked";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const shell = readFileSync(join(dist, "index.html"), "utf8");
const tpl = readFileSync(join(root, "src/lib/templates.ts"), "utf8");

const re =
  /slug: "([^"]+)",\s*name: "([^"]+)",\s*category: "([^"]+)",\s*icon: "([^"]*)",\s*description: "([^"]+)"/g;
const templates = [...tpl.matchAll(re)].map((m) => ({
  slug: m[1], name: m[2], category: m[3], description: m[5],
}));
if (!templates.length) {
  console.error("prerender: no templates parsed from templates.ts — aborting");
  process.exit(1);
}

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title, description, bodyHtml) {
  let html = shell;
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  if (/<meta name="description"[^>]*>/.test(html)) {
    html = html.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(description)}">`);
  } else {
    html = html.replace("</head>", `<meta name="description" content="${esc(description)}"></head>`);
  }
  const og =
    `<meta property="og:title" content="${esc(title)}">` +
    `<meta property="og:description" content="${esc(description)}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:site_name" content="Abracadata">` +
    `<meta name="twitter:card" content="summary">`;
  html = html.replace("</head>", og + "</head>");
  html = html.replace('<div id="root"></div>', `<div id="root"></div><noscript>${bodyHtml}</noscript>`);
  return html;
}

for (const t of templates) {
  const body =
    `<main><h1>${esc(t.name)}</h1><p>${esc(t.description)}</p>` +
    `<p>${esc(t.category)} template · runs entirely in your browser — your data never leaves your machine.</p>` +
    `<p><a href="/">Abracadata</a> — describe a spreadsheet chore once, re-run it forever.</p></main>`;
  const dir = join(dist, "t", t.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), page(`${t.name} — Abracadata`, t.description, body));
}

const galleryBody =
  `<main><h1>Abracadata templates</h1><ul>` +
  templates.map((t) => `<li><a href="/t/${t.slug}">${esc(t.name)}</a> — ${esc(t.description)}</li>`).join("") +
  `</ul></main>`;
const galleryDesc =
  "Ready-made spreadsheet recipes: total by category, top N, monthly totals, merge files, find duplicates, reconcile two lists. Pick one, drop your file, get results. Runs in your browser.";
mkdirSync(join(dist, "templates"), { recursive: true });
writeFileSync(join(dist, "templates", "index.html"), page("Templates — Abracadata", galleryDesc, galleryBody));

// Legal pages: full text prerendered for crawlers (the SPA hydrates over it).
const legalDocs = [
  { slug: "terms", file: "terms-of-use.md", title: "Terms of Use", desc: "The terms governing use of Abracadata." },
  { slug: "privacy", file: "privacy-policy.md", title: "Privacy Policy", desc: "How Abracadata handles your information — your files never leave your browser." },
];
for (const d of legalDocs) {
  const md = readFileSync(join(root, "src/content/legal", d.file), "utf8");
  const body = `<main class="legal-body">${marked.parse(md)}</main>`;
  mkdirSync(join(dist, d.slug), { recursive: true });
  writeFileSync(join(dist, d.slug, "index.html"), page(`${d.title} — Abracadata`, d.desc, body));
}

console.log(`prerender: wrote ${templates.length} template pages + /templates gallery + ${legalDocs.length} legal pages`);
