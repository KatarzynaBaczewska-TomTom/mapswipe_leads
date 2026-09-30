// Builds the MapSwipe daily activity report (report.html) from MapSwipe open data.
// Usage: node report/build.js  ->  writes _site/index.html (published by GitHub Pages)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FOCUS_ORG = /tomtom/i;
const WINDOW_DAYS = 30;
const PROJECTS_URL = 'https://backend.mapswipe.org/media/global/asset/projects_centroid.geojson';
const projectPage = (fid) => `https://mapswipe.org/en/projects/${fid}/`;
const OUT_DIR = __dirname;
const SITE_DIR = path.join(__dirname, '..', '_site');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

async function get(url, { gz = false, retries = 3 } = {}) {
  for (let a = 1; ; a++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return (gz ? zlib.gunzipSync(buf) : buf).toString('utf8');
    } catch (e) {
      if (a >= retries) throw e;
      await new Promise(r => setTimeout(r, 1500 * a));
    }
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const day = (d) => d.toISOString().slice(0, 10);
// Some volunteers use an e-mail address as username; don't print it in a shared report.
const who = (x) => (x.username || x.user_id.slice(0, 8)).replace(/^([^@\s]{1,3})[^@\s]*@\S+$/, '$1…@…');

async function main() {
  const now = new Date();
  const days = Array.from({ length: WINDOW_DAYS }, (_, k) => day(new Date(now - (WINDOW_DAYS - 1 - k) * 864e5)));
  const since = days[0];

  console.log('Downloading project list...');
  const all = JSON.parse(await get(PROJECTS_URL)).features.map(f => f.properties);
  const projects = all
    .filter(p => !['Draft', 'Discarded', 'Withdrawn', 'Processing Failed'].includes(p.status_display))
    .map(p => ({
      id: p.id, fid: p.firebase_id, name: p.name, org: (p.organization_name || 'Unknown').trim(),
      type: p.project_type_display, status: p.status_display, progress: +p.progress || 0,
      results: +p.number_of_results || 0, users: +p.number_of_contributor_users || 0,
      last: p.last_contribution_date || '', created: (p.created_at || '').slice(0, 10),
    }));

  // Detail needed for projects active in the window, plus every focus-org project.
  const detailed = projects.filter(p => p.last >= since || FOCUS_ORG.test(p.org));
  console.log(`${projects.length} projects, fetching details for ${detailed.length}...`);

  const history = {}, usersByProject = {}, focusDaily = [];
  await pool(detailed, 6, async (p) => {
    try {
      const html = await get(projectPage(p.fid));
      const link = (kind) => {
        const m = html.match(new RegExp(`https://backend\\.mapswipe\\.org/media/project/\\d+/asset/export/[A-Z0-9]+/${kind}_\\d+\\.csv(\\.gz)?`));
        return m && m[0];
      };
      const h = link('history'), u = link('users'), r = link('results');
      if (h) history[p.fid] = parseCsv(await get(h, { gz: h.endsWith('.gz') }))
        .map(x => [x.day, +x.number_of_results || 0, +x.number_of_users || 0]);
      if (u) usersByProject[p.fid] = parseCsv(await get(u, { gz: u.endsWith('.gz') }))
        .map(x => [who(x), +x.total_contributions || 0]);
      if (r && FOCUS_ORG.test(p.org)) {
        const counts = {};
        for (const x of parseCsv(await get(r, { gz: r.endsWith('.gz') }))) {
          const k = `${x.timestamp.slice(0, 10)}|${who(x)}`;
          counts[k] = (counts[k] || 0) + 1;
        }
        for (const [k, n] of Object.entries(counts)) { const [d, name] = k.split('|'); focusDaily.push([d, name, p.fid, n]); }
      }
    } catch (e) {
      console.warn(`  ! ${p.fid} ${p.name}: ${e.message}`);
    }
  });

  // Projects missing from the public website (new or paused) have no history file.
  // Keep a daily snapshot of cumulative totals and use day-to-day differences for them.
  const snapFile = path.join(OUT_DIR, 'snapshots.json');
  const snaps = fs.existsSync(snapFile) ? JSON.parse(fs.readFileSync(snapFile, 'utf8')) : {};
  snaps[day(now)] = Object.fromEntries(projects.map(p => [p.fid, p.results]));
  for (const d of Object.keys(snaps)) if (d < since) delete snaps[d];
  fs.writeFileSync(snapFile, JSON.stringify(snaps));
  const snapDays = Object.keys(snaps).sort();
  for (const p of detailed) {
    if (history[p.fid]) continue;
    const rows = [];
    for (let k = 1; k < snapDays.length; k++) {
      const a = snaps[snapDays[k - 1]][p.fid], b = snaps[snapDays[k]][p.fid];
      if (b > (a ?? 0) && a !== undefined) rows.push([snapDays[k], b - a, 0]);
    }
    if (!rows.length && p.results > 0 && p.created >= since) rows.push([p.last || p.created, p.results, p.users]);
    history[p.fid] = rows;
    p.estimated = true;
  }

  const data = {
    generatedAt: now.toISOString(),
    days,
    focusOrg: 'TomTom',
    projects,
    history,
    users: usersByProject,
    focusDaily,
  };

  const tpl = fs.readFileSync(path.join(OUT_DIR, 'template.html'), 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  fs.mkdirSync(SITE_DIR, { recursive: true });
  fs.writeFileSync(path.join(SITE_DIR, 'index.html'), tpl.replace('/*__DATA__*/null', json));
  console.log(`Wrote _site/index.html (${(json.length / 1024).toFixed(0)} KB of data)`);
}

main().catch(e => { console.error(e); process.exit(1); });
