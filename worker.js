/* برق — محرك المعالجة المحلي (Web Worker)
   بارس streaming + فهرسة + مطابقة + تخزين OPFS. كل حاجة على جهاز المستخدم. */
'use strict';

/* ====================== 1. أدوات عامة ====================== */
const TE = new TextEncoder();
const TD = () => new TextDecoder('utf-8', { fatal: false });
const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };

/* نفس normalize_expr في app.py */
function normKey(s) {
  if (!s) return '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const a = AR_DIGITS[ch];
    if (a) { out += a; continue; }
    if (/[\p{L}\p{N}]/u.test(ch)) out += ch;
  }
  const m = /^(\p{L}*)0*([1-9][0-9]*|0)$/u.exec(out);
  return m ? m[1] + m[2] : out;
}
function looksLikePlate(s) {
  if (!s) return 0;
  const l = /\p{L}/u.test(s), d = /\p{N}/u.test(s);
  if (l && d && s.length <= 24) return 2;
  if (d && s.length <= 12) return 1;
  return 0;
}
const PLATE_KEYWORDS = ['لوحة', 'لوحات', 'لوح', 'رقم اللوحة', 'plate', 'plat'];
const DATE_KEYWORDS = ['تاريخ', 'التاريخ'];
const EXCLUDED_LABELS = ['المعادلة'];

function stamp() {
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
function progress(phase, frac, name) {
  self.postMessage({ type: 'progress', phase, frac: Math.max(0, Math.min(1, frac || 0)), name: name || '' });
}

/* ====================== 2. تخزين OPFS ====================== */
/* أسماء المجلدات لازم تكون ASCII بس: المتصفح بيُلغي الفروق بين أسماء غير ASCII في المسارات
   (profiles/مروة == profiles/سامي!) فبنحوّل اسم المستخدم لـ hex ثابت وبنرجّع الاسم المعروض منه. */
let ROOT = 'profiles/p64656661756c74';
function safeName(s) {
  return String(s || '').replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}
function pidOf(name) {
  const n = safeName(name);
  if (!n) return '';
  const bytes = TE.encode(n);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return 'p' + hex;
}
function nameOfPid(id) {
  if (!/^p[0-9a-f]*$/.test(id)) return id; // مجلد قديم/ASCII
  try {
    const bytes = new Uint8Array((id.slice(1).match(/../g) || []).map(h => parseInt(h, 16)));
    return TD().decode(bytes);
  } catch { return id; }
}
async function dirOf(path, create) {
  let d = await navigator.storage.getDirectory();
  for (const part of (ROOT + '/' + path).split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
  return d;
}
async function fileOf(path, create) {
  const i = path.lastIndexOf('/');
  const dir = await dirOf(i < 0 ? '' : path.slice(0, i), !!create);
  return dir.getFileHandle(path.slice(i + 1), { create: !!create });
}
async function tryFile(path) { try { return await fileOf(path); } catch { return null; } }
async function opfsFile(path) { const h = await tryFile(path); return h ? await h.getFile() : null; }
async function readBytes(path) { const f = await opfsFile(path); return f ? new Uint8Array(await f.arrayBuffer()) : null; }
async function readJSON(path, fb) {
  const b = await readBytes(path); if (!b) return fb;
  try { return JSON.parse(TD().decode(b)); } catch { return fb; }
}
async function writeBytes(path, data) {
  const w = await (await fileOf(path, true)).createWritable();
  await w.write(data); await w.close();
}
async function writeJSON(path, obj) { await writeBytes(path, TE.encode(JSON.stringify(obj))); }
async function removeEntry(path) {
  const i = path.lastIndexOf('/');
  try {
    const dir = await dirOf(i < 0 ? '' : path.slice(0, i), false);
    await dir.removeEntry(path.slice(i + 1), { recursive: true });
  } catch {}
}
const u32 = (arr) => new Uint8Array(new Uint32Array(arr).buffer);
const f64 = (arr) => new Uint8Array(new Float64Array(arr).buffer);
/* قراءة registries بروفايل تاني بدون ما نغيّر ROOT (لشاشة اختيار المستخدم) */
async function peekProfile(name) {
    let d = await navigator.storage.getDirectory();
    const pid = pidOf(name);
    if (!pid) return { ok: true, exists: false, mains: [], refs: [], runs: 0 };
    try {
      d = await d.getDirectoryHandle('profiles').then((p) => p.getDirectoryHandle(pid));
    } catch { return { ok: true, exists: false, mains: [], refs: [], runs: 0 }; }
    const read = async (p) => {
      try { return JSON.parse(TD().decode(await (await (await (await d.getDirectoryHandle(p.slice(0, p.lastIndexOf('/')))).getFileHandle(p.slice(p.lastIndexOf('/') + 1))).getFile()).arrayBuffer())); }
      catch { return null; }
    };
    const mains = ((await read('main/registry.json')) || []).map(f => f.name);
    const refs = ((await read('ref/registry.json')) || []).map(f => f.name);
    const runs = ((await read('history/runs.json')) || []).length;
    return { ok: true, exists: true, mains, refs, runs };
}

/* ====================== 3. بارس CSV (على مستوى البايت) ======================
   الفاصلة/سطر الجديد/العلامة ASCII، فتقسيم البايت آمن مع العربية. */
function makeCsvSplitter(onRow) {
  const dec = TD();
  let hold = new Uint8Array(0), base = 0, colStart = 0, rowStart = 0, row = [], inQ = false;
  const cell = (from, to) => (to <= from ? '' : dec.decode(hold.subarray(from - base, to - base)));
  return {
    async feed(chunk) {
      const nb = new Uint8Array(hold.length + chunk.length);
      nb.set(hold); nb.set(chunk, hold.length); hold = nb;
      for (let i = Math.max(0, colStart - base); i < hold.length; i++) {
        const b = hold[i];
        if (b === 0x22) { inQ = !inQ; continue; }
        if (inQ) continue;
        if (b === 0x2C) { row.push(cell(colStart, base + i)); colStart = base + i + 1; continue; }
        if (b === 0x0A || b === 0x0D) {
          if (b === 0x0D && i + 1 >= hold.length) break;
          row.push(cell(colStart, base + i));
          await onRow(row, rowStart, base + i + 1);
          row = []; colStart = base + i + 1;
          if (b === 0x0D && hold[i + 1] === 0x0A) { colStart++; i++; }
          rowStart = colStart;
        }
      }
      const drop = Math.min(colStart - base, hold.length);
      if (drop > 0) { hold = hold.subarray(drop); base += drop; }
    },
    async end() {
      if (row.length || colStart < base + hold.length) {
        row.push(cell(colStart, base + hold.length));
        await onRow(row, rowStart, base + hold.length);
        row = [];
      }
    },
  };
}
function splitCsvLine(line) {
  if (line.indexOf('"') < 0) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
const csvEscape = (v) => (/[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);

/* ====================== 4. بارس XLSX (streaming) ====================== */
async function openZip(file) {
  const tailBuf = await file.slice(Math.max(0, file.size - 65557), file.size).arrayBuffer();
  const tail = new DataView(tailBuf);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('الملف مش Excel صالح');
  const tailStart = Math.max(0, file.size - 65557);
  let count = tail.getUint16(eocd + 10, true), cdOff = tail.getUint32(eocd + 16, true);
  if (count === 0 && cdOff === 0 && tailStart > 0) {
    const z6 = tailStart + eocd - 20;
    if (z6 >= 0 && tail.getUint32(z6, true) === 0x07064b50) {
      const z6off = Number(tail.getBigUint64(z6 + 8, true));
      const z6v = new DataView(await file.slice(z6off, z6off + 56).arrayBuffer());
      if (z6v.getUint32(0, true) === 0x06064b50) { count = Number(z6v.getBigUint64(32, true)); cdOff = Number(z6v.getBigUint64(48, true)); }
    }
  }
  const cd = new Uint8Array(await file.slice(cdOff, Math.min(file.size, cdOff + 8388608)).arrayBuffer());
  const entries = {}, dec = TD();
  const cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (cdv.getUint32(p, true) !== 0x02014b50) break;
    const nl = cdv.getUint16(p + 28, true), el = cdv.getUint16(p + 30, true), cl = cdv.getUint16(p + 32, true);
    entries[dec.decode(cd.subarray(p + 46, p + 46 + nl))] =
      { method: cdv.getUint16(p + 10, true), csize: cdv.getUint32(p + 20, true), lho: cdv.getUint32(p + 42, true) };
    p += 46 + nl + el + cl;
  }
  return { file, entries };
}
async function dataOffset(z, e) {
  const lh = new DataView(await z.file.slice(e.lho, e.lho + 30).arrayBuffer());
  return e.lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
}
async function entryText(z, name) {
  const e = z.entries[name]; if (!e) return null;
  const start = await dataOffset(z, e);
  const bytes = new Uint8Array(await z.file.slice(start, start + e.csize).arrayBuffer());
  if (e.method === 0) return TD().decode(bytes);
  return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
}
function xmlUnescape(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
          .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function colIndexOf(ref) { let n = -1; for (const ch of ref) { if (ch < 'A' || ch > 'Z') break; n = (n + 1) * 26 + ch.charCodeAt(0) - 64; } return n; }
async function loadSst(z) {
  const name = Object.keys(z.entries).find(n => /xl\/sharedStrings\.xml$/.test(n));
  if (!name) return null;
  const xml = await entryText(z, name);
  const sst = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g))
    sst.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => xmlUnescape(x[1])).join(''));
  return sst;
}
function parseCells(body, sst) {
  const cells = [];
  for (const m of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const inner = m[2] || '';
    const rr = / r="([A-Z]+)\d+"/.exec(m[1]);
    const idx = rr ? colIndexOf(rr[1]) : cells.length;
    const tm = / t="([^"]+)"/.exec(m[1]);
    const type = tm ? tm[1] : 'n';
    const vm = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
    let text = '';
    if (type === 's') text = (sst && vm) ? (sst[+vm[1]] ?? '') : '';
    else if (type === 'inlineStr') text = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => xmlUnescape(x[1])).join('');
    else if (type === 'b') text = vm && vm[1] === '1' ? '1' : '0';
    else if (type !== 'e' && vm) { text = xmlUnescape(vm[1]); if (/^-?\d+\.0+$/.test(text)) text = text.replace(/\.0+$/, ''); }
    while (cells.length < idx) cells.push('');
    cells[idx] = text;
  }
  return cells;
}
async function streamSheetRows(z, onRow) {
  const sheets = Object.keys(z.entries).filter(n => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort();
  if (!sheets.length) throw new Error('مفيش ورقة في الملف');
  const e = z.entries[sheets[0]];
  const sst = await loadSst(z);
  const start = await dataOffset(z, e);
  const raw = z.file.slice(start, start + e.csize).stream();
  const decoded = (e.method === 0 ? raw : raw.pipeThrough(new DecompressionStream('deflate-raw')))
                    .pipeThrough(new TextDecoderStream('utf-8'));
  const reader = decoded.getReader();
  let buf = '', rowNo = 0, seen = 0, inBytes = 0;
  const ROW = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  while (true) {
    const { done, value } = await reader.read();
    if (value) { buf += value; inBytes += value.length; }
    const last = buf.lastIndexOf('</row>');
    const cut = last >= 0 ? last + 6 : (done ? buf.length : 0);
    if (cut > 0) {
      const text = buf.slice(0, cut); buf = buf.slice(cut);
      ROW.lastIndex = 0;
      let m;
      while ((m = ROW.exec(text))) {
        const rm = / r="(\d+)"/.exec(m[1]);
        rowNo = rm ? +rm[1] : rowNo + 1;
        await onRow(parseCells(m[2] || '', sst));
        if (++seen % 50000 === 0) progress('parse', Math.min(0.99, inBytes / (e.csize || 1)));
      }
    }
    if (done) break;
  }
  if (buf.length) { ROW.lastIndex = 0; for (const m of buf.matchAll(ROW)) await onRow(parseCells(m[2] || '', sst)); }
}

/* ====================== 5. تحليل الأعمدة ====================== */
function detectPlateCol(rows) {
  if (!rows.length) return { col: 0, header: false, label: null };
  const head = rows[0].map(c => String(c ?? '').trim());
  for (let i = 0; i < head.length; i++)
    if (PLATE_KEYWORDS.some(kw => head[i].toLowerCase().includes(kw)))
      return { col: i, header: true, label: head[i] };
  const ncols = Math.max(1, ...rows.slice(0, 20).map(r => r.length));
  let best = 0, bestScore = -1;
  for (let c = 0; c < ncols; c++) {
    let score = 0;
    for (const r of rows) if (c < r.length) score += looksLikePlate(String(r[c] ?? '').trim());
    if (score > bestScore) { bestScore = score; best = c; }
  }
  const first = head[best] || '';
  const isHeader = first && !/[0-9\u0660-\u0669]/.test(first) && rows.length > 1;
  return { col: best, header: !!isHeader, label: null };
}
function colNamesOf(headerRow, ncols, usedHeader) {
  const seen = {}, names = [];
  for (let i = 0; i < ncols; i++) {
    let n = usedHeader ? String(headerRow[i] ?? '').trim() : '';
    if (!n) n = `عمود ${i + 1}`;
    if (seen[n] !== undefined) { seen[n]++; n = `${n} (${seen[n]})`; } else seen[n] = 0;
    names.push(n);
  }
  return names;
}
function dateIndexOf(names) {
  for (let i = 0; i < names.length; i++)
    if (DATE_KEYWORDS.some(kw => names[i].includes(kw)) || names[i].toLowerCase().includes('date')) return i;
  return -1;
}
function epochDays(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.exec(s);
  if (m) return dayOf(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})([ T]\d{1,2}:\d{2}(:\d{2})?)?$/.exec(s);
  if (m) {
    let a = +m[1], b = +m[2];
    if (b > 12 && a <= 12) { const t = a; a = b; b = t; }
    return dayOf(+m[3], b, a);
  }
  return null;
}
function dayOf(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Math.floor(Date.UTC(y, mo - 1, d) / 864e5);
}

/* ====================== 6. حالة مساحة العمل ====================== */
let mains = new Map();   // id -> info (موجود على القرص)
let refs = new Map();    // id -> info (الصفوف في الذاكرة + نسخة على القرص)
let manuals = [];
let lastRun = null;
const SAMPLE = 200;

function brief(f, i) {
  return { id: f.id, name: f.name, size: f.size, count: f.count, index: i + 1,
           colLabel: f.colLabel, columns: f.colNames, enabled: f.enabled !== false, uploadedAt: f.uploadedAt };
}
const briefAll = (m) => [...m.values()].map(brief);
const manualBrief = () => manuals.map((x, i) => ({ id: x.id, raw: x.raw, label: x.label, index: i + 1 }));

async function saveMains() {
  const list = [...mains.values()].map(f => ({
    id: f.id, name: f.name, size: f.size, count: f.count, colLabel: f.colLabel, colNames: f.colNames,
    plateName: f.plateName, dateIdx: f.dateIdx, csvBytes: f.csvBytes, enabled: f.enabled, uploadedAt: f.uploadedAt,
  }));
  await writeJSON('main/registry.json', list);
}
async function loadWorkspace() {
  mains = new Map(); refs = new Map(); manuals = [];
  for (const f of (await readJSON('main/registry.json', [])) || []) {
    if (await opfsFile(`main/${f.id}.csv`)) mains.set(f.id, f);
  }
  const reg = await readJSON('ref/registry.json', []);
  for (const f of reg) {
    const rows = await readJSON(`ref/${f.id}.rows.json`, null);
    if (rows) refs.set(f.id, { ...f, rows });
  }
  manuals = (await readJSON('manual.json', [])) || [];
  lastRun = await readJSON('last_run.json', null);
}

/* ====================== 7. استيراد ملف داتا ====================== */
const WRITE_FLUSH = 4 << 20;   // نكتب على دفعات ~4 ميجا بدل مليون استدعاء
async function ingestMain(meta, file) {
  const isXlsx = /\.(xlsx|xls)$/i.test(meta.name);
  const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (magic[0] === 0xD0 && magic[1] === 0xCF && magic[2] === 0x11 && magic[3] === 0xE0)
    throw new Error('ملف قديم (.xls) أو محمي بكلمة سر — افتحه في Excel واحفظه CSV أو xlsx من غير حماية');
  const out = await (await fileOf(`main/${meta.id}.csv`, true)).createWritable();
  let decided = null, pending = [];
  let totalRows = 0, seq = 0, written = 0, bytesDone = 0;
  const offs = [], lens = [], rks = [], nkChunks = [];
  let nkLen = 0;
  let batch = [], batchLen = 0;
  async function flush() {
    if (!batchLen) return;
    const buf = new Uint8Array(batchLen);
    let q = 0; for (const b of batch) { buf.set(b, q); q += b.length; }
    batch = []; batchLen = 0;
    await out.write(buf);
  }
  async function wbytes(b) { batch.push(b); batchLen += b.length; if (batchLen >= WRITE_FLUSH) await flush(); }

  async function decide(rows) {
    const d = detectPlateCol(rows);
    const body = d.header ? rows.slice(1) : rows;
    const ncols = Math.max(1, ...body.map(r => r.length), ...rows.slice(0, 1).map(r => r.length));
    const names = colNamesOf(rows[0], ncols, d.header);
    decided = {
      col: d.col, header: d.header, names,
      dateIdx: dateIndexOf(names),
      label: d.header ? (d.label || names[d.col]) : `عمود ${d.col + 1}`,
    };
    if (!isXlsx) return;                       // CSV: بنخزّن الملف زي ما هو
    const hb = TE.encode(names.map(csvEscape).join(',') + '\n');
    await wbytes(hb);
    written += hb.length;
  }
  function emit(cells, off, len) {
    seq++;
    const raw = String(cells.length > decided.col ? cells[decided.col] : '');
    if (!raw.trim()) return;
    totalRows++;
    const nk = normKey(raw);
    if (!nk) return;
    const b = TE.encode(nk);
    offs.push(off); lens.push(len); nkChunks.push(b); nkLen += b.length;
    let rk = seq;
    if (decided.dateIdx >= 0) {
      const dv = epochDays(cells.length > decided.dateIdx ? cells[decided.dateIdx] : '');
      if (dv !== null) rk = dv;
    }
    rks.push(rk);
  }
  async function handle(cells, off, len) {
    if (!decided) {
      pending.push([cells, off, len]);
      if (pending.length < SAMPLE) return;
      await decide(pending.map(p => p[0]));
      const drained = pending; pending = null;
      for (let i = 0; i < drained.length; i++) { const [c, o, l] = drained[i]; if (!(decided.header && i === 0)) emit(c, o, l); }
      return;
    }
    if (!isXlsx) { emit(cells, off, len); return; }
    const b = TE.encode(cells.map(c => csvEscape(String(c ?? ''))).join(',') + '\n');
    emit(cells, written, b.length);
    written += b.length;
    await wbytes(b);
  }

  if (isXlsx) {
    const z = await openZip(file);
    await streamSheetRows(z, (cells) => handle(cells.map(String), 0, 0));
  } else {
    const reader = file.stream().getReader();
    const sp = makeCsvSplitter((cells, s, e) => handle(cells.map(String), s, e - s));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await out.write(value);                    // نسخ البايت زي ما هو
      bytesDone += value.length;
      await sp.feed(value);
      progress('parse', bytesDone / (file.size || 1), meta.name);
    }
    await sp.end();
    written = bytesDone;
  }
  if (!decided) {
    const rows = pending && pending.length ? pending : [];
    await decide(rows.length ? rows.map(p => p[0]) : [[]]);
    if (pending) for (let i = 0; i < pending.length; i++) { const [c, o, l] = pending[i]; if (!(decided.header && i === 0)) emit(c, o, l); }
    pending = null;
  }
  await flush();
  await out.close();

  const keys = new Uint8Array(nkLen + nkChunks.length);
  let p = 0;
  for (const b of nkChunks) { keys.set(b, p); p += b.length; keys[p++] = 0x0A; }
  await writeBytes(`main/${meta.id}.nk`, keys);
  await writeBytes(`main/${meta.id}.off`, u32(offs));
  await writeBytes(`main/${meta.id}.len`, u32(lens));
  await writeBytes(`main/${meta.id}.rk`, f64(rks));

  const info = {
    id: meta.id, name: meta.name, size: meta.size, count: totalRows,
    colLabel: decided.label, colNames: decided.names, plateName: decided.names[decided.col],
    dateIdx: decided.dateIdx, csvBytes: written, enabled: true, uploadedAt: stamp(),
  };
  mains.set(info.id, info);
  await saveMains();
  return info;
}

/* ====================== 8. استيراد ملف إحالة ====================== */
async function ingestRef(meta, file) {
  const isXlsx = /\.(xlsx|xls)$/i.test(meta.name);
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head[0] === 0xD0 && head[1] === 0xCF && head[2] === 0x11 && head[3] === 0xE0)
    throw new Error('ملف قديم (.xls) أو محمي بكلمة سر — افتحه في Excel واحفظه CSV أو xlsx من غير حماية');
  const rows = [];
  if (isXlsx) {
    const z = await openZip(file);
    await streamSheetRows(z, (c) => rows.push(c.map(String)));
  } else {
    const sp = makeCsvSplitter((c) => rows.push(c.map(String)));
    const reader = file.stream().getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; await sp.feed(value); }
    await sp.end();
  }
  if (!rows.length) return null;
  const d = detectPlateCol(rows);
  const body = (d.header ? rows.slice(1) : rows).filter(r => String(r[d.col] ?? '').trim() !== '');
  if (!body.length) return null;
  const names = colNamesOf(rows[0], Math.max(1, ...rows.map(r => r.length)), d.header);
  const info = {
    id: meta.id, name: meta.name, size: meta.size, count: body.length,
    colLabel: d.header ? (d.label || names[d.col]) : `عمود ${d.col + 1}`,
    colNames: names, plateName: names[d.col], enabled: true, uploadedAt: stamp(), rows: body,
  };
  await writeJSON(`ref/${info.id}.rows.json`, body);
  refs.set(info.id, info);
  await writeJSON('ref/registry.json', [...refs.values()].map(f => {
    const { rows, ...rest } = f; return rest;
  }));
  return info;
}

/* ====================== 9. قراءة صفوف بالموضع ====================== */
/* بنقرأ على شكل نوافذ متتابعة (مش طلبات عشوائية) — أرخص بكتير على موبايل */
async function readLinesAt(fileId, offsets) {
  const found = new Map();
  const list = [...new Set(offsets)].sort((a, b) => a - b);
  if (!list.length) return found;
  const file = await opfsFile(`main/${fileId}.csv`);
  if (!file) return found;
  const dec = TD();
  let ptr = 0;
  while (ptr < list.length) {
    const winStart = list[ptr];
    const far = list[Math.min(ptr + 600, list.length - 1)];
    const winEnd = Math.min(file.size, Math.max(far + 8192, winStart + 6000000));
    const u8 = new Uint8Array(await file.slice(winStart, winEnd).arrayBuffer());
    for (let i = ptr; i < list.length && list[i] < winEnd; i++) {
      const rel = list[i] - winStart;
      let end = rel;
      while (end < u8.length && u8[end] !== 0x0A) end++;
      if (end > rel) found.set(list[i], dec.decode(u8.subarray(rel, Math.min(end, u8.length))));
      ptr = i + 1;
    }
    if (winEnd >= file.size) break;
  }
  return found;
}
/* أول N صفوف صالحة (لسلاحفة "غير المطابقة"/"الكل")، مع تخطي مواضع معيّنة */
async function readFirstValid(fileId, limit, skip) {
  const info = mains.get(fileId);
  if (!info) return [];
  const nkB = await readBytes(`main/${fileId}.nk`);
  const offs = new Uint32Array((await readBytes(`main/${fileId}.off`)).buffer);
  if (!nkB) return [];
  const take = [];
  const skipSet = skip || new Set();
  for (let i = 0; i < offs.length && take.length < limit; i++)
    if (!skipSet.has(offs[i])) take.push(offs[i]);
  const lines = await readLinesAt(fileId, take);
  return take.map(o => [splitCsvLine((lines.get(o) || '').replace(/[\r\n]+$/, '')), o]).filter(x => x[0].length);
}
function rowDisplay(info, cells) {
  const names = info.colNames, n = Math.max(names.length, cells.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push(`${names[i] || `عمود ${i + 1}`}: ${cells[i] ?? ''}`);
  return out.join('   |   ');
}
function plateOf(info, cells) {
  const idx = (info.colNames || []).indexOf(info.plateName);
  return idx >= 0 ? String(cells[idx] ?? '') : String(cells[0] ?? '');
}

/* ====================== 10. الفرز ====================== */
function refMap() {
  const map = new Map();
  const add = (nk, src, display) => {
    if (!nk) return;
    let e = map.get(nk);
    if (!e) map.set(nk, (e = { sources: new Set(), display }));
    e.sources.add(src);
  };
  for (const f of refs.values()) {
    if (f.enabled === false) continue;
    const col = (f.colNames || []).indexOf(f.plateName);
    for (const r of f.rows)
      add(normKey(String(col >= 0 ? r[col] ?? '' : '')), f.name,
          (f.colNames || []).map((n, i) => `${n}: ${String(r[i] ?? '')}`).join('   |   '));
  }
  for (const m of manuals)
    add(normKey(m.raw), m.label || 'إدخال يدوي', m.label ? `الجهة: ${m.label}` : m.raw);
  return map;
}
const orderOf = (m) => { const p = {}; let i = 0;
  for (const f of (m === 'main' ? mains.values() : refs.values())) if (!(f.name in p)) p[f.name] = i++;
  if (m === 'ref') for (const x of manuals) { const l = x.label || 'إدخال يدوي'; if (!(l in p)) p[l] = i++; }
  return p; };

async function runMatch(mode) {
  const t0 = performance.now();
  const rm = refMap();
  if (!rm.size) throw new Error('لازم ترفع ملف إحالة أو تضيف لوحات يدوية الأول');
  const enabled = [...mains.values()].filter(f => f.enabled !== false);
  if (!enabled.length) throw new Error('لازم يكون في ملف داتا واحد مفعّل على الأقل');
  const seen = mode === 'new' ? await readSeen() : null;

  const hits = [];
  let total = 0;
  for (const info of enabled) {
    const nkB = await readBytes(`main/${info.id}.nk`);
    if (!nkB) continue;
    const offs = new Uint32Array((await readBytes(`main/${info.id}.off`)).buffer);
    const rks = new Float64Array((await readBytes(`main/${info.id}.rk`)).buffer);
    total += info.count;
    const dec = TD();
    let start = 0, k = 0;
    for (let i = 0; i < nkB.length; i++) {
      if (nkB[i] !== 0x0A) continue;
      const nk = dec.decode(nkB.subarray(start, i));
      start = i + 1;
      const e = rm.get(nk);
      if (e && !(seen && seen.has(nk)))
        hits.push({ fileId: info.id, nk, off: offs[k], rk: rks[k], sources: [...e.sources], refDisplay: e.display });
      k++;
    }
    progress('match', 0.4);
  }

  const mp = orderOf('main'), sp = orderOf('ref');
  hits.sort((a, b) => {
    const mk = (h) => mp[(mains.get(h.fileId) || {}).name] ?? 1e7;
    const d = mk(a) - mk(b); if (d) return d;
    const rk = (h) => Math.min(...h.sources.map(s => sp[s] ?? 1e8));
    const d2 = rk(a) - rk(b); if (d2) return d2;
    return (b.rk || 0) - (a.rk || 0);
  });

  const byFile = new Map();
  for (const h of hits) { if (!byFile.has(h.fileId)) byFile.set(h.fileId, []); byFile.get(h.fileId).push(h.off); }
  const lines = new Map();
  for (const [fid, offs] of byFile) {
    const got = await readLinesAt(fid, offs);
    for (const [k, v] of got) lines.set(fid + ':' + k, v);
    progress('match', 0.8);
  }

  const counts = new Map();
  for (const h of hits) counts.set(h.nk, (counts.get(h.nk) || 0) + 1);
  const first = new Set();
  let duplicateCount = 0;
  const cards = [];
  for (const h of hits) {
    const info = mains.get(h.fileId);
    const cells = splitCsvLine((lines.get(h.fileId + ':' + h.off) || '').replace(/[\r\n]+$/, ''));
    const dup = first.has(h.nk);
    if (dup) duplicateCount++; else first.add(h.nk);
    cards.push({
      plate: plateOf(info, cells), matched: true, duplicate: dup, hasDuplicates: counts.get(h.nk) > 1,
      sources: h.sources, mainFile: info.name, mainRow: [rowDisplay(info, cells)], refRow: [h.refDisplay],
      _off: h.off, _nk: h.nk,
    });
  }
  if (mode === 'new' && cards.length) { for (const c of cards) seen.add(c._nk); await writeSeen(seen); }
  const matchedCount = cards.length;
  lastRun = { mode, cards, total, matchedCount, notMatched: Math.max(0, total - matchedCount), duplicateCount };
  await writeJSON('last_run.json', lastRun);
  if (matchedCount) await pushHistory();
  progress('match', 1);
  return {
    summary: { matched: matchedCount, notMatched: lastRun.notMatched, duplicate: duplicateCount, total,
               elapsed: Math.round((performance.now() - t0) / 100) / 10 },
    preview: cards,
  };
}

/* ====================== 11. فرز جديد (seen) ====================== */
async function readSeen() {
  const b = await readBytes('seen.txt');
  if (!b) return new Set();
  return new Set(TD().decode(b).split('\n').filter(Boolean));
}
async function writeSeen(set) { await writeBytes('seen.txt', TE.encode([...set].join('\n'))); }

/* ====================== 12. السجل ====================== */
async function pushHistory() {
  const runs = (await readJSON('history/runs.json', [])) || [];
  const id = Math.random().toString(16).slice(2, 18);
  const entry = {
    id, date: stamp().slice(0, 10), dateFull: stamp(),
    mainFiles: [...new Set(lastRun.cards.map(c => c.mainFile))],
    refSources: [...new Set(lastRun.cards.flatMap(c => c.sources || []))],
    matchedCount: lastRun.matchedCount, duplicateCount: lastRun.duplicateCount,
  };
  await writeJSON(`history/${id}.json`, lastRun.cards);
  await writeBytes(`history/${id}.xlsx`, await buildWorkbook(lastRun.cards, null, 'فرز ' + entry.date));
  runs.push(entry);
  await writeJSON('history/runs.json', runs.slice(-200));
}

/* ====================== 13. كاتب Excel (بدون مكتبات) ====================== */
const CRC_TABLE = (() => { const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
const xesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
function colLetter(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - m - 1) / 26; } return s; }

function parseDisplay(s) {
  if (!s) return [];
  return s.split('   |   ').map(seg => { const i = seg.indexOf(': '); return i < 0 ? ['', seg] : [seg.slice(0, i), seg.slice(i + 2)]; });
}
async function buildWorkbook(cards, selectedRef, sheetName) {
  const mainOrder = [], refOrder = [];
  const prepped = cards.map(c => {
    const mf = parseDisplay((c.mainRow || [])[0] || '').filter(([l, v]) => v !== c.plate && !EXCLUDED_LABELS.includes(l));
    for (const [l] of mf) if (l && !mainOrder.includes(l)) mainOrder.push(l);
    let rf = parseDisplay((c.refRow || [])[0] || '').filter(([l]) => !EXCLUDED_LABELS.includes(l));
    if (selectedRef && selectedRef.size) rf = rf.filter(([l]) => selectedRef.has(l));
    for (const [l] of rf) if (l && !refOrder.includes(l)) refOrder.push(l);
    return { c, mf: Object.fromEntries(mf), rf: Object.fromEntries(rf) };
  });

  const rows = [];
  const head = ['رقم اللوحة', ...mainOrder, ...refOrder.map(x => x + ' (إحالة)')];
  rows.push(head.map(x => ({ v: x, s: 1 })));
  for (const { c, mf, rf } of prepped) {
    const line = [{ v: c.plate, s: c.duplicate ? 3 : 2 }];
    for (const l of mainOrder) line.push({ v: mf[l] ?? '', s: 2 });
    for (const l of refOrder) line.push({ v: rf[l] ?? '', s: 2 });
    rows.push(line);
  }
  const cells = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((cl, ci) => {
    const ref = colLetter(ci) + (ri + 1);
    const t = typeof cl.v === 'number' ? '' : ` t="inlineStr"`;
    const body = typeof cl.v === 'number' ? `<v>${cl.v}</v>` : `<is><t xml:space="preserve">${xesc(cl.v)}</t></is>`;
    return `<c r="${ref}" s="${cl.s}"${t}>${body}</c>`;
  }).join('') + '</row>').join('');

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${head.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="20"/>`).join('')}</cols><sheetData>${cells}</sheetData></worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFC00000"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B1E3D"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFADBD8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyleName="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const safe = xesc(String(sheetName).slice(0, 31));
  const parts = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${safe}</dc:title></cp:coreProperties>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safe}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': styles,
    'xl/worksheets/sheet1.xml': sheet,
  };
  return await zipSync(parts);
}
async function deflateRaw(data) {
  try {
    const s = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const out = new Uint8Array(await new Response(s).arrayBuffer());
    return out.length < data.length - 64 ? out : null;
  } catch { return null; }
}
async function zipSync(parts) {
  const enc = TE, chunks = [], central = [];
  let offset = 0, n = 0;
  for (const [name, text] of Object.entries(parts)) {
    const nb = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const comp = await deflateRaw(data);
    const stored = comp === null ? data : comp;
    const method = comp === null ? 0 : 8;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, method, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, stored.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, nb.length, true);
    chunks.push(new Uint8Array(lh.buffer), nb, stored);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(10, method, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, stored.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, nb.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), nb);
    offset += 30 + nb.length + stored.length;
    n++;
  }
  const cdStart = offset;
  let cdLen = 0; for (const c of central) cdLen += c.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, n, true); end.setUint16(10, n, true);
  end.setUint32(12, cdLen, true); end.setUint32(16, cdStart, true);
  const all = chunks.concat(central, [new Uint8Array(end.buffer)]);
  let total = 0; for (const c of all) total += c.length;
  const out = new Uint8Array(total); let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

/* ====================== 14. الإدخال اليدوي (نفس split_plate_and_label) ====================== */
function splitPlateAndLabel(line) {
  line = line.trim();
  if (!line) return [null, null];
  const t = line.split(/\s+/).filter(Boolean);
  for (let i = 0; i < t.length; i++)
    if (looksLikePlate(t[i]) === 2) return [t[i], (t.slice(0, i).concat(t.slice(i + 1)).join(' ').trim() || null)];
  const shortL = (x) => x.length <= 2 && /^\p{L}+$/u.test(x);
  const digits = (x) => /^[\p{N}]+$/u.test(x);
  for (let i = 0; i < t.length; i++) {
    if (!digits(t[i])) continue;
    let s = i; while (s > 0 && shortL(t[s - 1])) s--;
    let e = i; while (e < t.length - 1 && shortL(t[e + 1])) e++;
    if (s !== i || e !== i) return [t.slice(s, e + 1).join(''), (t.slice(0, s).concat(t.slice(e + 1)).join(' ').trim() || null)];
  }
  for (let i = 0; i < t.length; i++)
    if (looksLikePlate(t[i]) >= 1) return [t[i], (t.slice(0, i).concat(t.slice(i + 1)).join(' ').trim() || null)];
  return [line, null];
}

/* ====================== 15. التوجيه (router) ====================== */
const routes = {
  async 'GET /api/state'() {
    return { mainFiles: briefAll(mains), refFiles: briefAll(refs), manualPlates: manualBrief() };
  },
  async 'POST /api/upload/main'(msg) {
    for (const file of msg.files) {
      const meta = { id: msg.metas ? msg.metas[file.name] : crypto.randomUUID(), name: file.name, size: file.size };
      progress('upload', 0, file.name);
      await ingestMain(meta, file);
    }
    return { ok: true, mainFiles: briefAll(mains) };
  },
  async 'POST /api/upload/ref'(msg) {
    const failed = [];
    for (const file of msg.files) {
      try {
        const meta = { id: msg.metas ? msg.metas[file.name] : crypto.randomUUID(), name: file.name, size: file.size };
        await ingestRef(meta, file);
      }
      catch (e) { failed.push(`${file.name}: ${e.message}`); }
    }
    return { ok: true, refFiles: briefAll(refs), failed };
  },
  async 'DELETE /api/file'(msg) {
    if (msg.kind === 'main') {
      mains.delete(msg.id);
      await Promise.all(['csv', 'nk', 'off', 'len', 'rk'].map(x => removeEntry(`main/${msg.id}.${x}`)));
      await saveMains();
      return { ok: true, mainFiles: briefAll(mains) };
    }
    refs.delete(msg.id);
    await removeEntry(`ref/${msg.id}.rows.json`);
    await writeJSON('ref/registry.json', [...refs.values()].map(({ rows, ...r }) => r));
    return { ok: true, refFiles: briefAll(refs) };
  },
  async 'POST /api/toggle'(msg) {
    const store = msg.kind === 'main' ? mains : refs;
    const f = store.get(msg.id);
    if (!f) throw new Error('الملف مش موجود');
    f.enabled = f.enabled === false;
    if (msg.kind === 'main') await saveMains();
    else await writeJSON('ref/registry.json', [...refs.values()].map(({ rows, ...r }) => r));
    return { ok: true, mainFiles: briefAll(mains), refFiles: briefAll(refs) };
  },
  async 'POST /api/manual'(msg) {
    for (const line of String(msg.text || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean)) {
      const [raw, label] = splitPlateAndLabel(line);
      if (raw) manuals.push({ id: crypto.randomUUID(), raw, label });
    }
    await writeJSON('manual.json', manuals);
    return { ok: true, manualPlates: manualBrief() };
  },
  async 'DELETE /api/manual'(msg) {
    manuals = msg.id ? manuals.filter(x => x.id !== msg.id) : [];
    await writeJSON('manual.json', manuals);
    return { ok: true, manualPlates: manualBrief() };
  },
  async 'POST /api/match'(msg) { return await runMatch(msg.mode); },
  async 'GET /api/preview'(msg) {
    if (!lastRun) throw new Error('لم يتم تنفيذ الفرز بعد');
    if (msg.filter === 'matched')
      return { ok: true, total: lastRun.matchedCount, rows: lastRun.cards };
    const rows = [];
    for (const info of mains.values()) {
      if (info.enabled === false || rows.length >= 300) continue;
      const skip = msg.filter === 'notmatched'
        ? new Set(lastRun.cards.filter(c => c.mainFile === info.name).map(c => c._off)) : null;
      for (const [cells, off] of await readFirstValid(info.id, 300 - rows.length, skip)) {
        rows.push({
          plate: plateOf(info, cells), matched: false, duplicate: false, hasDuplicates: false,
          sources: [], mainFile: info.name, mainRow: [rowDisplay(info, cells)], refRow: null, _off: off,
        });
        if (rows.length >= 300) break;
      }
    }
    if (msg.filter === 'all') {
      const sp = orderOf('ref'), mp = orderOf('main');
      rows.sort((a, b) => (mp[a.mainFile] ?? 1e7) - (mp[b.mainFile] ?? 1e7) || (b._off || 0) - (a._off || 0));
    }
    return { ok: true, total: msg.filter === 'notmatched' ? lastRun.notMatched : lastRun.total, rows };
  },
  async 'GET /api/search'(msg) {
    if (!lastRun) throw new Error('لازم تعمل فرز الأول');
    const q = normKey(msg.q || '');
    if (!q) return { ok: true, total: 0, rows: [] };
    const matchedNk = new Map(lastRun.cards.map(c => [c._nk, c]));
    const rows = [];
    for (const info of mains.values()) {
      if (info.enabled === false || rows.length >= 50) continue;
      const nkB = await readBytes(`main/${info.id}.nk`);
      if (!nkB) continue;
      const offs = new Uint32Array((await readBytes(`main/${info.id}.off`)).buffer);
      const dec = TD();
      const want = [];
      let start = 0;
      for (let i = 0, k = 0; i < nkB.length && want.length < 50 - rows.length; i++) {
        if (nkB[i] !== 0x0A) continue;
        const nk = dec.decode(nkB.subarray(start, i)); start = i + 1;
        if (nk.includes(q)) want.push({ nk, off: offs[k] });
        k++;
      }
      if (!want.length) continue;
      const lines = await readLinesAt(info.id, want.map(w => w.off));
      for (const w of want) {
        const line = lines.get(w.off);
        if (line === undefined) continue;
        const cells = splitCsvLine(line.replace(/[\r\n]+$/, ''));
        const hit = matchedNk.get(w.nk);
        rows.push({
          plate: plateOf(info, cells), matched: !!hit, duplicate: false, hasDuplicates: false,
          sources: hit ? hit.sources : [], mainFile: info.name,
          mainRow: [rowDisplay(info, cells)], refRow: hit ? hit.refRow : null,
        });
      }
    }
    return { ok: true, total: rows.length, rows };
  },
  async 'GET /api/export'(msg) {
    if (!lastRun) throw new Error('لم يتم تنفيذ الفرز بعد');
    const cards = msg.type === 'matched' ? lastRun.cards : lastRun.cards;
    const sel = msg.ref_cols ? new Set(String(msg.ref_cols).split(',').filter(Boolean)) : null;
    const bytes = await buildWorkbook(cards, sel, 'فرز ' + stamp().slice(0, 10));
    return { ok: true, bytes: bytes.buffer, name: `فرز ${stamp().slice(0, 10)} - ${msg.type === 'matched' ? 'مطابقة' : 'الكل'}.xlsx` };
  },
  async 'GET /api/history'() {
    const runs = (await readJSON('history/runs.json', [])) || [];
    return { ok: true, runs: runs.slice().reverse() };
  },
  async 'GET /api/history/cards'(msg) {
    const cards = await readJSON(`history/${msg.id}.json`, null);
    if (!cards) throw new Error('السجل ده مش موجود');
    return { ok: true, cards };
  },
  async 'GET /api/history/download'(msg) {
    const b = await readBytes(`history/${msg.id}.xlsx`);
    if (!b) throw new Error('الشيت ده مش موجود');
    return { ok: true, bytes: b.buffer, name: `فرز.xlsx` };
  },
  async 'GET /api/history/delete'(msg) {
    await removeEntry(`history/${msg.id}.json`);
    await removeEntry(`history/${msg.id}.xlsx`);
    const runs = ((await readJSON('history/runs.json', [])) || []).filter(r => r.id !== msg.id);
    await writeJSON('history/runs.json', runs);
    return { ok: true };
  },
  async 'POST /api/clear_seen'() { await writeBytes('seen.txt', new Uint8Array(0)); return { ok: true }; },
  async 'GET /api/seen_count'() { return { ok: true, count: (await readSeen()).size }; },
  async 'GET /api/profiles'() {
    const out = [];
    try {
      let root = await navigator.storage.getDirectory();
      const profs = await root.getDirectoryHandle('profiles');
      for await (const [id, h] of profs.entries()) if (h.kind === 'directory' && /^p[0-9a-f]+$/.test(id)) out.push(nameOfPid(id));
    } catch {}
    return { ok: true, profiles: [...new Set(out)].sort() };
  },
  async 'GET /api/profile_peek'(msg) {
    return await peekProfile(msg.profile);
  },
  async 'POST /api/profile/delete'(msg) {
    const pid = pidOf(msg.profile);
    if (!pid) throw new Error('اسم غير صالح');
    try {
      let root = await navigator.storage.getDirectory();
      const profs = await root.getDirectoryHandle('profiles');
      await profs.removeEntry(pid, { recursive: true });
    } catch {}
    return { ok: true };
  },
  async 'GET /api/inbox'() {
    const files = [];
    try {
      let root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('inbox');
      for await (const [name, h] of dir.entries()) {
        if (h.kind !== 'file') continue;
        const f = await h.getFile();
        let shown = name;
        try { shown = decodeURIComponent(name); } catch {}
        files.push(new File([f], shown, { type: f.type, lastModified: f.lastModified }));
      }
    } catch {}
    return { ok: true, files };
  },
  async 'POST /api/inbox/clear'() {
    try {
      let root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('inbox');
      for await (const [name] of dir.entries()) await dir.removeEntry(name);
    } catch {}
    return { ok: true };
  },
  async 'POST /api/use'(msg) {
    const pid = pidOf(msg.profile);
    if (!pid) throw new Error('اسم غير صالح');
    ROOT = `profiles/${pid}`;
    await dirOf('main', true);
    await loadWorkspace();
    return { ok: true, mainFiles: briefAll(mains), refFiles: briefAll(refs), manualPlates: manualBrief() };
  },
};

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    const fn = routes[msg.route];
    if (!fn) throw new Error('مسار غير معروف: ' + msg.route);
    const out = await fn(msg);
    self.postMessage({ type: 'result', reqId: msg.reqId, ...out });
  } catch (err) {
    self.postMessage({ type: 'error', reqId: msg.reqId, message: (err && err.message) || String(err) });
  }
};
