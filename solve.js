// Faster drop-in replacement for makefun-site 1.0.0 (site-generator-speed-01).
// run(input) returns exactly makefun-site 1.0.0's build(input): the output tree
// as an object of path -> text, byte for byte. Optimisations over the reference:
// compiled templates (each template is turned into a JS function once per case
// instead of walking a node tree for every page), per-case memoised slugify and
// longDate, allocation-free word counting, fast-path HTML escaping, and a
// single-pass Markdown renderer that emits blocks without token objects.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text rules

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) { start = i; break; }
  }
  if (start === -1) return text;
  let out = text.slice(0, start);
  for (let i = start; i < text.length; i++) {
    const e = ESC[text[i]];
    out += e === undefined ? text[i] : e;
  }
  return out;
}

const SLUG_MAX = 64;

// Per-case memo for slugify: titles and tag names repeat a lot inside one site.
let slugCache = new Map();

function slugifyRaw(text) {
  // Fast path: pure ASCII is unchanged by NFKD and holds no combining marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

export function slugify(text) {
  let s = slugCache.get(text);
  if (s === undefined) { s = slugifyRaw(text); slugCache.set(text, s); }
  return s;
}

export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let dateCache = new Map();

export function longDate(date) {
  let s = dateCache.get(date);
  if (s === undefined) {
    const parts = date.split('-');
    s = `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
    dateCache.set(date, s);
  }
  return s;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // "
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function isSlugValue(raw) {
  // /^[a-z0-9]+(?:-[a-z0-9]+)*$/ and at most 64 chars
  if (raw.length === 0 || raw.length > 64) return false;
  let seg = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) { if (seg === 0) return false; seg = 0; }
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) seg++;
    else return false;
  }
  return seg > 0;
}

function isNameValue(raw) {
  // /^[a-z0-9-]+$/
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      // YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4)); mo = Number(raw.slice(5, 7)); d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isNameValue(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugValue(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

export function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { close = i; break; }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line === '' || line.startsWith('#')) continue;
    // blank = spaces and tabs only
    let blank = true;
    for (let j = 0; j < line.length; j++) { const c = line.charCodeAt(j); if (c !== 32 && c !== 9) { blank = false; break; } }
    if (blank) continue;
    // /^([a-z_]+):(?: (.*))?$/
    let k = 0;
    while (k < line.length) { const c = line.charCodeAt(k); if ((c >= 97 && c <= 122) || c === 95) k++; else break; }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    raw = raw.replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b) { const c = line.charCodeAt(a); if (c === 32 || c === 9) a++; else break; }
  while (b > a) { const c = line.charCodeAt(b - 1); if (c === 32 || c === 9) b--; else break; }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// Fence open: ``` + optional lang [A-Za-z0-9_+-]* + spaces/tabs. Returns lang or null.
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) { const c = line.charCodeAt(i); if (c === 32 || c === 9) i++; else return null; }
  return lang;
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

// Heading: 1-6 '#', at least one space/tab, non-empty text (trailing blanks dropped).
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let a = n;
  while (a < line.length) { const cc = line.charCodeAt(a); if (cc === 32 || cc === 9) a++; else break; }
  let b = line.length;
  while (b > a) { const cc = line.charCodeAt(b - 1); if (cc === 32 || cc === 9) b--; else break; }
  if (b <= a) return null;
  return { depth: n, text: line.slice(a, b) };
}

function isHr(line) {
  let b = line.length;
  while (b > 0) { const c = line.charCodeAt(b - 1); if (c === 32 || c === 9) b--; else break; }
  const t = b === line.length ? line : line.slice(0, b);
  return t === '---' || t === '***';
}

function bulletOf(line) {
  if ((line.startsWith('- ') || line.startsWith('* '))) return line.slice(2);
  return null;
}

function orderedOf(line) {
  // /^(\d{1,9})\. (.*)$/
  let i = 0;
  while (i < line.length && i < 10) { const c = line.charCodeAt(i); if (c >= 48 && c <= 57) i++; else break; }
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { num: line.slice(0, i), rest: line.slice(i + 2) };
}

function isContinued(line) {
  // /^ {2,}\S/
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  const c = line[i];
  return c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== '\f' && c !== '\v';
}

function findUnescaped(s, what, from) {
  const w0 = what.charCodeAt(0);
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.charCodeAt(j) === w0 && s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

const escChar = (c) => ESC[c] ?? c;

const INLINE_SPECIAL = /[\\`*[]/;

export function inline(s, env) {
  // Fast path: no inline markup anywhere — the whole string is plain text.
  const firstSpecial = s.search(INLINE_SPECIAL);
  if (firstSpecial === -1) return escapeHtml(s);
  const parts = [];
  let i = firstSpecial;
  let plain = 0; // start of the current plain run
  const flush = (upto) => { if (upto > plain) parts.push(escapeHtml(s.slice(plain, upto))); };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      flush(i); parts.push(escChar(s[i + 1])); i += 2; plain = i; continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) { flush(i); parts.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>'); i = j + 1; plain = i; }
      else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) { flush(i); parts.push('<strong>', inline(s.slice(i + 2, j), env), '</strong>'); i = j + 2; plain = i; }
        else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) { flush(i); parts.push('<em>', inline(s.slice(i + 1, j), env), '</em>'); i = j + 1; plain = i; }
      else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        parts.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, k), env), '</a>');
        i = m + 1; plain = i; continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flush(s.length);
  return parts.join('');
}

export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      i++;
      const body = [];
      while (i < lines.length && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let inner = '';
      for (const l of body) inner += `${escapeHtml(l)}\n`;
      blocks.push(lang === '' ? `<pre><code>${inner}</code></pre>` : `<pre><code class="language-${escapeHtml(lang)}">${inner}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        body.push(trimLine(l));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const b0 = bulletOf(line);
    const o0 = b0 === null ? orderedOf(line) : null;
    if (b0 !== null || o0 !== null) {
      const isOrdered = o0 !== null;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = isOrdered ? orderedOf(l) : (bulletOf(l) === null ? null : { rest: bulletOf(l) });
        if (m !== null) { items.push([trimLine(m.rest)]); i++; }
        else if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; }
        else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(o0.num) !== 1 ? `<ol start="${Number(o0.num)}">` : `<${tag}>`;
      let inner = '';
      for (const parts of items) inner += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlankLine(l) || fenceOpen(l) !== null || headingOf(l) !== null || isHr(l)) break;
      body.push(trimLine(l));
      i++;
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

export class TemplateError extends Error {}
const INCLUDE_DEPTH = 8;

function isPathText(text) {
  // /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/
  if (text.length === 0) return false;
  let segStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 46) { if (segStart) return false; segStart = true; continue; }
    const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    const digit = c >= 48 && c <= 57;
    if (segStart) { if (!letter) return false; segStart = false; }
    else if (!letter && !digit) return false;
  }
  return !segStart;
}

function pathOf(name, text) {
  if (!isPathText(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let j = lineStart; j < open; j++) { const c = src.charCodeAt(j); if (c !== 32 && c !== 9) { standalone = false; break; } }
    if (standalone) for (let j = end; j < lineEnd; j++) { const c = src.charCodeAt(j); if (c !== 32 && c !== 9) { standalone = false; break; } }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node); stack.push(node); body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node); stack.push(node); body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = []; body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Scope-stack lookup: S is an array of vars objects, innermost last.
function lookupS(S, path) {
  for (let i = S.length - 1; i >= 0; i--) {
    if (Object.hasOwn(S[i], path[0])) {
      let v = S[i][path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const HELP = { lookup: lookupS, text: textOf, truthy, esc: escapeHtml };

// Compile a node tree into a function (S, C, D) -> string, where C holds the
// compiled templates map. Falls back to null when codegen is unavailable.
function compileNodes(nodes) {
  let uid = 0;
  const gen = (list) => {
    let code = '';
    for (const n of list) {
      if (n.kind === 'text') code += `o+=${JSON.stringify(n.text)};`;
      else if (n.kind === 'var') code += `o+=H.esc(H.text(H.lookup(S,${JSON.stringify(n.path)})));`;
      else if (n.kind === 'raw') code += `o+=H.text(H.lookup(S,${JSON.stringify(n.path)}));`;
      else if (n.kind === 'if') {
        const v = `v${uid++}`;
        code += `{const ${v}=H.truthy(H.lookup(S,${JSON.stringify(n.path)}));if(${v}!==${n.not}){${gen(n.then)}}${n.else !== null ? `else{${gen(n.else)}}` : ''}}`;
      } else if (n.kind === 'for') {
        const v = `v${uid++}`, k = `k${uid++}`;
        code += `{const ${v}=H.lookup(S,${JSON.stringify(n.path)});if(Array.isArray(${v})){for(let ${k}=0;${k}<${v}.length;${k}++){S.push({${JSON.stringify(n.name)}:${v}[${k}],loop:{index:${k}+1,first:${k}===0,last:${k}===${v}.length-1,length:${v}.length}});${gen(n.body)}S.pop();}}}`;
      } else if (n.kind === 'include') {
        code += `{const f=C.get(${JSON.stringify(n.name)});if(f!==undefined&&D<${INCLUDE_DEPTH})o+=f(S,C,D+1);}`;
      }
    }
    return code;
  };
  try {
    return new Function('S', 'C', 'D', 'H', `"use strict";let o='';${gen(nodes)}return o;`);
  } catch {
    return null;
  }
}

// Interpreter fallback with identical semantics (used only if codegen fails).
function renderNodes(nodes, S, C, D) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text': out += n.text; break;
      case 'var': out += escapeHtml(textOf(lookupS(S, n.path))); break;
      case 'raw': out += textOf(lookupS(S, n.path)); break;
      case 'if': {
        const branch = truthy(lookupS(S, n.path)) !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, S, C, D);
        break;
      }
      case 'for': {
        const xs = lookupS(S, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          S.push({ [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } });
          out += renderNodes(n.body, S, C, D);
          S.pop();
        }
        break;
      }
      case 'include': {
        const f = C.get(n.name);
        if (f !== undefined && D < INCLUDE_DEPTH) out += f(S, C, D + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the build

export const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

function isWsCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

function wordsOf(text) {
  let count = 0, inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWsCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function run(input) {
  slugCache = new Map();
  dateCache = new Map();
  const report = [];
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Compile every parsed template once for this case.
  const compiled = new Map();
  for (const [name, nodes] of parsed) {
    const fn = compileNodes(nodes);
    compiled.set(name, fn !== null ? (S, C, D) => fn(S, C, D, HELP) : (S, C, D) => renderNodes(nodes, S, C, D));
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter stage.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  const schemeRe = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (schemeRe.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugify(name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) {
    s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of kept) cards.set(s, cardOf(s));
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const pageOf = (s) => ({
    ...cards.get(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = compiled.get(name);
    return fn === undefined ? null : fn([{ site, tags: allTags, recent, ...vars }], compiled, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
