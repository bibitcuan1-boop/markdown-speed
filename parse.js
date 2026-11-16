// parse.js — fast CommonMark 0.31.2 + GFM parser, byte-identical to marked 18.1.3
// (default options: gfm true, breaks false, pedantic false, async false).
//
// Strategy: a clean-room single-pass parser that mirrors marked's tokeniser
// algorithms (same regexes, same block/inline precedence, same merge rules),
// but with hot paths kept allocation-light: a manual inline text scanner
// instead of the giant text regex, direct string building in the renderers,
// and no deferred token-queue overhead. Anything the fast path cannot handle
// (or any bug) falls back to the vendored marked 18.1.3, so output is always
// correct.
//
// Dependency-free ES module. `parse(markdown)` is stateless per call.

import { marked } from './vendor/marked/marked.esm.js';

export function parse(md) {
  try {
    const out = fastParse(md);
    if (out !== null) return out;
  } catch (_) { /* fall through to marked */ }
  return marked.parse(md);
}

// ---------------------------------------------------------------------------
// Small helpers (transcribed from marked 18.1.3)
// ---------------------------------------------------------------------------

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_WS = /[\s\p{P}\p{S}]/u;
const NON_PUNCT_WS = /[^\s\p{P}\p{S}]/u; // "notPunctSpace"
const NON_PUNCT_WS_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u; // for del: '~' counts as non-punct
const PUNCT_WS_TILDE = /(?!~)[\s\p{P}\p{S}]/u; // punctSpace for del (excludes ~)
const PUNCT_TILDE = /(?!~)[\p{P}\p{S}]/u; // punct for del (excludes ~)
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;
const ALPHA_NUM = /[\p{L}\p{N}]/u; // unicodeAlphaNumeric approximation

// escape: P(a, e) — e=true encodes everything; e=false uses the no-encode
// rule (escapes <>"' always, and & only when not starting a valid reference).
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;
const ESC_NO_ENCODE_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_NO_ENCODE_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s, encodeAll) {
  if (encodeAll) {
    return ESC_TEST.test(s) ? s.replace(ESC_REPLACE, (c) => ENTITIES[c]) : s;
  }
  return ESC_NO_ENCODE_TEST.test(s) ? s.replace(ESC_NO_ENCODE_RE, (c) => ENTITIES[c]) : s;
}

// Ie(a) — decode numeric character references in text. Only valid numeric
// refs are touched (the & escaping is esc()'s job at render time).
// &#169; -> © ; &#xA9; -> © ; 0 / >0x10FFFF / surrogate -> U+FFFD ; &#38; -> &amp;
// Invalid refs (e.g. &#99999999;) are left alone here; esc() escapes the &.
function decodeNumeric(s) {
  if (!s.includes('&#')) return s;
  let out = '', i = 0, n = s.length;
  while (i < n) {
    const amp = s.indexOf('&#', i);
    if (amp < 0) { out += s.slice(i); break; }
    out += s.slice(i, amp);
    let j = amp + 2, hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    let k = j;
    while (k < n && (hex ? (s[k] >= '0' && s[k] <= '9') || (s[k] >= 'a' && s[k] <= 'f') || (s[k] >= 'A' && s[k] <= 'F') : (s[k] >= '0' && s[k] <= '9'))) k++;
    const digits = k - j;
    if (digits >= 1 && digits <= (hex ? 6 : 7) && s[k] === ';') {
      const cp = hex ? parseInt(s.slice(j, k), 16) : parseInt(s.slice(j, k), 10);
      if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) out += '\uFFFD';
      else if (cp === 38) out += '&amp;';
      else out += String.fromCodePoint(cp);
      i = k + 1;
    } else {
      out += '&#';
      i = amp + 2;
    }
  }
  return out;
}

// he(a) — cleanUrl: encodeURI then restore %25 -> %
function cleanUrl(href) {
  try { return encodeURI(href).replace(/%25/g, '%'); } catch { return null; }
}

// J(a, e=0) — expand tabs to next multiple of 4 columns, starting at column e.
function expandTabs(a, e = 0) {
  let t = e, out = '';
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    if (c === '\t') { const r = 4 - (t % 4); out += ' '.repeat(r); t += r; }
    else { out += c; t++; }
  }
  return out;
}

// F(a) — normalize a link label: trim, collapse internal whitespace, lowercase.
function normalizeLabel(a) {
  return a.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// L(a, e, t) — strip trailing run of char e from a (t=true: strip non-e too? see marked).
// marked: function L(a,e,t){let n=a.length;if(n===0)return"";let s=0;for(;s<n;){let r=a.charAt(n-s-1);if(r===e&&!t)s++;else if(r!==e&&t)s++;else break}return a.slice(0,n-s)}
// Used as L(s, "\\") (strip trailing backslashes) and L(t[0], "\n") (strip trailing newlines).
function stripTrailing(a, ch) {
  let n = a.length, s = 0;
  while (s < n && a.charAt(n - s - 1) === ch) s++;
  return a.slice(0, n - s);
}

// ke(a, e) — find the index of the unmatched closing paren in a, or -1/-2.
function parenIndex(a, pair) {
  if (a.indexOf(pair[0]) === -1 && a.indexOf(pair[1]) === -1) return -1;
  let t = 0;
  for (let n = 0; n < a.length; n++) {
    if (a[n] === '\\') n++;
    else if (a[n] === pair[0]) t++;
    else if (a[n] === pair[1] && (t--, t < 0)) return n;
  }
  return t > 0 ? -2 : -1;
}

// de(a, e) — split a table row/header line into cells.
const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
const SLASH_PIPE = /\\\|/g;
function splitCells(a, count) {
  const t = a.replace(FIND_PIPE, (r, o, i) => {
    let l = false, p = o;
    for (; --p >= 0 && i[p] === '\\';) l = !l;
    return l ? '|' : ' |';
  });
  const n = t.split(SPLIT_PIPE);
  let s = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), count) {
    if (n.length > count) n.splice(count);
    else for (; n.length < count;) n.push('');
  }
  for (; s < n.length; s++) n[s] = n[s].trim().replace(SLASH_PIPE, '|');
  return n;
}

// ge(a) — trim trailing blank lines (keep at most 1 trailing blank line worth).
function trimTrailingBlanks(a) {
  const e = a.split('\n'), t = e.length - 1;
  let i = t;
  for (; i >= 0 && /^[ \t]*$/.test(e[i]);) i--;
  return e.length - i <= 2 ? a : e.slice(0, i + 1).join('\n');
}

// Dt(a, e, t) — fenced-code indent compensation: if any fence line inside
// Dt(raw, content) — if the opening fence (backtick only) is indented, strip
// up to that many leading spaces from every line of the content.
function dtCompensate(raw, content) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (m === null) return content;
  const s = m[1];
  return content.split('\n').map((r) => {
    const o = r.match(/^\s+/);
    if (o === null) return r;
    const [i] = o;
    return r.slice(Math.min(i.length, s.length));
  }).join('\n');
}

// expandLeading(line) — expand tabs in the leading whitespace run to spaces
// (same as line.replace(/^[ \t]+/, ws => expandTabs(ws, 0))), but returns
// the original string when there is no leading tab (no allocation).
function expandLeading(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9) return line;
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  const ws = line.slice(0, i);
  if (ws.indexOf('\t') === -1) return line;
  return expandTabs(ws, 0) + line.slice(i);
}

// stripCols(line, cols) — consume `cols` columns of leading whitespace
// (a tab counts to the next multiple of 4); a partial tab leaves spaces.
function stripCols(line, cols) {
  let c = 0, i = 0;
  while (c < cols && i < line.length) {
    const ch = line[i];
    if (ch === ' ') { c++; i++; }
    else if (ch === '\t') { const w = 4 - (c % 4); if (c + w > cols) { return ' '.repeat(c + w - cols) + line.slice(i + 1); } c += w; i++; }
    else break;
  }
  return line.slice(i);
}

// leading whitespace width of a line, in columns (tabs expanded from col 0).
function leadingWidth(line) {
  let c = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') c++;
    else if (line[i] === '\t') c += 4 - (c % 4);
    else break;
  }
  return c;
}
function firstNonSpace(line) {
  for (let i = 0; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return i;
  return line.length;
}

// ---------------------------------------------------------------------------
// Regex tables (transcribed from marked 18.1.3; built with its `c()` helper)
// ---------------------------------------------------------------------------

const CARET_RE = /(^|[^\\[])\^/g;
function c(tpl, flags = '') {
  let t = typeof tpl === 'string' ? tpl : tpl.source;
  const n = {
    replace(s, r) {
      let o = typeof r === 'string' ? r : r.source;
      o = o.replace(CARET_RE, '$1');
      t = t.replace(s, o);
      return n;
    },
    getRegex() { return new RegExp(t, flags); },
  };
  return n;
}

// --- shared pieces ---
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const COMMENT_RE = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_ATTR = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;
const INLINE_ATTR = /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/;

const HR_RE = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HEADING_RE = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULL_RE = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const LHEADING_TPL = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const LHEADING = c(LHEADING_TPL)
  .replace(/bull/g, BULL_RE)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[:\- ]*\n/)
  .getRegex();
const PARA_TPL = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const TEXT_RE = /^[^\n]+/;
const DEF_LABEL_RE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]|\n(?![ \t]*\n))+/;
const DEF_RE = c(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', DEF_LABEL_RE)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();
const LIST_RE = c(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BULL_RE).getRegex();
const HTML_RE = c('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))', 'i')
  .replace('comment', COMMENT_RE)
  .replace('tag', BLOCK_TAGS)
  .replace('attribute', HTML_ATTR)
  .getRegex();
const CODE_RE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCES_RE = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const NEWLINE_RE = /^(?:[ \t]*(?:\n|$))+/;
const TABLE_RE = c('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', HR_RE)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', BLOCK_TAGS)
  .getRegex();

function pe(listPattern) {
  return c(PARA_TPL)
    .replace('hr', HR_RE)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listPattern)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', BLOCK_TAGS)
    .getRegex();
}
const PARA_GFM = c(PARA_TPL)
  .replace('hr', HR_RE)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', TABLE_RE)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', BLOCK_TAGS)
  .getRegex();
const PARA_BQ = pe(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
const BLOCKQUOTE_RE = c(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', PARA_BQ).getRegex();

// --- "other" rules ---
const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const INDENT_CODE_COMP = /^(\s+)(?:```)/;
const BEGINNING_SPACE = /^\s+/;
const ENDING_HASH = /#$/;
const STARTING_SPACE = /^ /;
const ENDING_SPACE = / $/;
const ENDING_SPACE_TAB = /[ \t]$/;
const NON_SPACE = /[^ ]/;
const NEWLINE_GLOBAL = /\n/g;
const TAB_GLOBAL = /\t/g;
const LEADING_SPACE_TAB = /^[ \t]+/;
const MULTIPLE_SPACE_GLOBAL = /\s+/g;
const BLANK_LINE = /^[ \t]*$/;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const BQ_START = /^ {0,3}>/;
const BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BQ_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const HREF_BRACKETS = /^<(.*)>$/;
const TABLE_DELIM = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ROW_BLANK = /\n[ \t]*$/;
const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const START_A_TAG = /^<a /;
const END_A_TAG = /^<\/a\s*>/;
const START_PRE_SCRIPT = /^<(?:pre|script|style|textarea)/i;
const END_PRE_SCRIPT = /^<\/(?:pre|script|style|textarea)\s*>/i;
const SPACE_LINE = /^ +$/gm;
const NOT_SPACE_START = /^\S*/;
const ENDING_NEWLINE = /\n$/;

function D(builder) {
  const cache = [];
  return (t) => {
    const n = Math.max(0, Math.min(3, t - 1));
    let s = cache[n];
    return s || (s = builder(n), cache[n] = s);
  };
}
const listItemRegexCache = new Map();
const listItemRegex = (a) => {
  let r = listItemRegexCache.get(a);
  if (!r) { r = new RegExp(`^( {0,3}${a})((?:[\\t ][^\\n]*)?(?:\\n|$))`); listItemRegexCache.set(a, r); }
  return r;
};
const nextBulletRegex = D((a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrRegex = D((a) => new RegExp(`^ {0,${a}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = D((a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`));
const headingBeginRegex = D((a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = D((a) => new RegExp(`^ {0,${a}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = D((a) => new RegExp(`^ {0,${a}}>`));

// --- inline regexes ---
const ESCAPE_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const CODE_SPAN_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const BR_RE = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const ANY_PUNCT_RE = c(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const ANY_PUNCT_OUTSIDE_CODE_RE = c(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTO_RE = c(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, EMAIL_RE).getRegex();
const AUTOLINK_RE = c(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();
const COMMENT_PT_RE = c(COMMENT_RE).replace('(?:-->|$)', '-->').getRegex();
const TAG_RE = c('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', COMMENT_PT_RE)
  .replace('attribute', INLINE_ATTR)
  .getRegex();
const BRACKETS_RE = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_RE = c(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace('brackets', BRACKETS_RE).getRegex();
const LINK_RE = c(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', LABEL_RE)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
const REFLINK_RE = c(/^!?\[(label)\]\[(ref)\]/).replace('label', LABEL_RE).replace('ref', DEF_LABEL_RE).getRegex();
const NOLINK_RE = c(/^!?\[(ref)\](?:\[\])?/).replace('ref', DEF_LABEL_RE).getRegex();
const LABEL_LT_RE = c(/(?:[^[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^[\]\\`]*?/).replace('brackets', BRACKETS_RE).getRegex();
const REFLINK_LT_RE = c(/^!?\[(label)\]\[(ref)\]/).replace('label', LABEL_LT_RE).replace('ref', DEF_LABEL_RE).getRegex();
const REFLINK_SEARCH_RE = c('reflink|nolink(?!\\()', 'g').replace('reflink', REFLINK_LT_RE).replace('nolink', NOLINK_RE).getRegex();
const BLOCK_SKIP_RE = c(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\(...\)/.source.replace('...', '(?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*'))
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();
const URL_PROTO_RE = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const URL_RE = c(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', EMAIL_PROTO_RE)
  .replace('protocol', URL_PROTO_RE)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
// GFM inline text regex (marked's `ie.text`): stops at code/emphasis/del
// delimiters, hard breaks, and at URL / email starts (protocol://, www.,
// local@domain). Built with the c() helper exactly as marked builds it.
const SIMPLE_TEXT_RE = /^[^\\<!\[`*_~]+/;
const HARD_BR_RE = / {2,}\n/;
const GFM_TEXT_RE = c(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/)
  .replace('protocol', URL_PROTO_RE)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const DEL_RE = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

// marked's inline `punctuation` (nt): whitespace OR punctuation, but not * or _
// (used for the flanking `u`/`h` checks in emStrong/del)
const INLINE_PUNCT = /^((?![*_])[\s\p{P}\p{S}])/u;
const EM_L_DELIM_TPL = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_L_DELIM = c(EM_L_DELIM_TPL, 'u').replace(/punct/g, PUNCT_TILDE).getRegex();
const EM_R_AST_TPL = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const EM_R_AST = c(EM_R_AST_TPL, 'gu').replace(/notPunctSpace/g, NON_PUNCT_WS_TILDE).replace(/punctSpace/g, PUNCT_WS_TILDE).replace(/punct/g, PUNCT_TILDE).getRegex();
const EM_R_UND_TPL = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const EM_R_UND = c(EM_R_UND_TPL, 'gu').replace(/notPunctSpace/g, NON_PUNCT_WS).replace(/punctSpace/g, PUNCT_WS).replace(/punct/g, PUNCT).getRegex();
const DEL_L_DELIM = c(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, PUNCT).getRegex();
const DEL_R_TPL = '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
const DEL_R_DELIM = c(DEL_R_TPL, 'gu').replace(/notPunctSpace/g, NON_PUNCT_WS).replace(/punctSpace/g, PUNCT_WS).replace(/punct/g, PUNCT).getRegex();

// ---------------------------------------------------------------------------
// Inline lexer (mirrors marked's Lexer#t / Tokenizer, with a manual text scan)
// ---------------------------------------------------------------------------

const EMAIL_LOCAL_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?_`{|}~-";

function isEmailLocalChar(ch) {
  return EMAIL_LOCAL_CHARS.includes(ch);
}
// Does a GFM email (url tokenizer pattern) start at src[j]?
function emailMatchAt(src, j) {
  const n = src.length;
  let k = j;
  // local part: [A-Za-z0-9._+-]+
  while (k < n && ((src[k] >= 'a' && src[k] <= 'z') || (src[k] >= 'A' && src[k] <= 'Z') || (src[k] >= '0' && src[k] <= '9') || src[k] === '.' || src[k] === '_' || src[k] === '+' || src[k] === '-')) k++;
  if (k === j || src[k] !== '@') return false;
  k++;
  // domain: [a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+  with (?![\w-]) after
  let m = k;
  while (m < n && ((src[m] >= 'a' && src[m] <= 'z') || (src[m] >= 'A' && src[m] <= 'Z') || (src[m] >= '0' && src[m] <= '9') || src[m] === '-' || src[m] === '_')) m++;
  if (m === k) return false;
  let hasDot = false;
  while (m < n && src[m] === '.') {
    let p = m + 1;
    while (p < n && ((src[p] >= 'a' && src[p] <= 'z') || (src[p] >= 'A' && src[p] <= 'Z') || (src[p] >= '0' && src[p] <= '9') || src[p] === '-' || src[p] === '_')) p++;
    if (p === m + 1) break;
    // the segment must end with an alnum (not - or _)
    const last = src[p - 1];
    if (!((last >= 'a' && last <= 'z') || (last >= 'A' && last <= 'Z') || (last >= '0' && last <= '9'))) break;
    hasDot = true;
    m = p;
  }
  if (!hasDot) return false;
  // (?![\w-]) — next char must not be a word char or '-'
  if (m < n) {
    const c = src[m];
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '-') return false;
  }
  return true;
}
// Does a scheme URL (http/https/ftp) start at src[j]? (case-insensitive)
function schemeUrlAt(src, j) {
  const rest = src.slice(j, j + 8).toLowerCase();
  if (rest.startsWith('https://') || rest.startsWith('http://')) return true;
  if (src.slice(j, j + 6).toLowerCase() === 'ftp://') return true;
  return false;
}
// Does "www." start at src[j] with a valid preceding char (lookbehind rule)?
function wwwAt(src, j) {
  if (src[j] !== 'w' || src[j + 1] !== 'w' || src[j + 2] !== 'w' || src[j + 3] !== '.') return false;
  if (j === 0) return true;
  const p = src[j - 1];
  return p === ' ' || p === '\t' || p === '\n' || p === '\r' || p === '\f' || p === '*' || p === '_' || p === '~' || p === '(';
}

// fe(a) — last possible closer indices in a masked source.
function feInfo(masked) {
  const e = { '*': -1, '_': -1 };
  let t = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    for (; i < n && masked[i] === r;) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') t = s; else e[r] = s;
    }
    s = i - 1;
  }
  return { maskedSrc: masked, em: e, del: t };
}

// linkInText(e) — does e contain a link (not an image) per marked's rules?
function linkInText(e, links) {
  if (!e.includes('[')) return false;
  const linkRe = LINK_RE;
  for (const n of e.matchAll(BLOCK_SKIP_RE)) {
    if (linkRe.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of e.matchAll(REFLINK_SEARCH_RE)) {
    const s = n[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

// Be(a, e, t, n) — does the link label e contain a raw <...> tag that would
// extend past the label's end? (a = full source, t = offset of the label)
function beCheck(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const i = CODE_SPAN_RE.exec(label.slice(s));
      if (i) { s += i[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = src.slice(offset + s);
    const o = TAG_RE.exec(r) || AUTOLINK_RE.exec(r);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// #n(e) — mask a source for the emStrong/del closer search.
function maskSrc(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const n = REFLINK_SEARCH_RE;
    const s = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const i = r.slice(1, o - 1);
        if (linkInText(i, links)) return '[' + i.replace(n, s) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(n, s);
  }
  // The two remaining masks only matter when the source can contain a code
  // span (backtick), an escape (backslash), or a link / code span / tag.
  if (t.includes('`') || t.includes('\\')) {
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE_RE, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  }
  if (t.includes('[') || t.includes('`') || t.includes('<')) {
    t = t.replace(BLOCK_SKIP_RE, (n, s, r) => {
      const o = r ? r.length : 0;
      return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
    });
  }
  return t;
}

// De(a, e, t, lexer) — build a link/image token from a regex match.
// Returns the token, or undefined if the label contains a link (outer link).
function buildLink(match, hrefTitle, raw, lx) {
  const href = hrefTitle.href;
  const title = hrefTitle.title || null;
  const text = match[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const isImage = raw.charAt(0) === '!';
  const prevInLink = lx.state.inLink;
  const prevEmitted = lx.state.linkEmitted;
  const prevRaw = lx.state.inRawBlock;
  lx.state.inLink = true;
  lx.state.linkEmitted = false;
  const tokens = lx.inlineTokens(text);
  const emitted = lx.state.linkEmitted;
  lx.state.linkEmitted = prevEmitted;
  lx.state.inLink = prevInLink;
  if (!isImage) {
    if (emitted) { lx.state.inRawBlock = prevRaw; return undefined; }
    lx.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

class InlineLexer {
  constructor(links) {
    this.links = links;
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.maskStack = [];
  }

  // Main inline loop — returns a token array for src.
  inlineTokens(src) {
    const prevParen = this.state.linkParenPossible;
    this.state.linkParenPossible = prevParen && src.includes(')');
    const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = hasDelim ? maskSrc(src, this.links) : src;
    this.maskStack.push(hasDelim ? feInfo(masked) : { maskedSrc: masked, em: { '*': -1, '_': -1 }, del: -1 });
    let tokens;
    try {
      tokens = this.scan(src, masked);
    } finally {
      this.maskStack.pop();
    }
    this.state.linkParenPossible = prevParen;
    return tokens;
  }

  scan(src, masked) {
    const tokens = [];
    let e = src;
    let r = ''; // last char of the previous text token (for emStrong/del)
    let s = false; // previous token was text
    let guard = 1 / 0;
    while (e.length > 0) {
      if (e.length < guard) guard = e.length; else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
      if (!s) r = '';
      s = false;
      let tok = null;
      // Dispatch on the first char: only the tokenizers that can start with
      // it are tried, in marked's order among them.
      const ch = e.charCodeAt(0);
      if (ch === 92) { // backslash: escape, then hard break
        tok = this.tokEscape(e) || this.tokBr(e);
      } else if (ch === 60) { // <: tag, then autolink
        tok = this.tokTag(e) || this.tokAutolink(e);
      } else if (ch === 91 || ch === 33) { // [ or !: link, then reflink
        tok = this.tokLink(e) || this.tokReflink(e);
      } else if (ch === 42 || ch === 95) { // * or _: emStrong
        tok = this.tokEmStrong(e, masked, r);
      } else if (ch === 96) { // `: codespan
        tok = this.tokCodespan(e);
      } else if (ch === 126) { // ~: del
        tok = this.tokDel(e, masked, r);
      } else if (ch === 32) { // space: hard break, then text
        tok = this.tokBr(e);
      } else if ((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122)) {
        // alphanumeric: possible url/email autolink (only outside links)
        if (!this.state.inLink) tok = this.tokUrl(e);
      }
      if (tok) {
        e = e.slice(tok.raw.length);
        const p = tokens.at(-1);
        if (tok.type === 'text' && p?.type === 'text') { p.raw += tok.raw; p.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      // inline text: fast path is a plain run of non-special chars;
      // fall back to the full GFM text regex only when the run might
      // contain a URL/email start or a hard break (the only stops the
      // simple run misses), so behaviour is identical to marked's
      // ie.text in every case.
      let raw;
      const sm = SIMPLE_TEXT_RE.exec(e);
      if (sm && sm[0].indexOf('://') === -1 && sm[0].indexOf('www.') === -1 && sm[0].indexOf('@') === -1 && sm[0].indexOf('mailto:') === -1 && sm[0].indexOf('xmpp:') === -1 && (sm[0].indexOf('\n') === -1 || !HARD_BR_RE.test(sm[0]))) {
        raw = sm[0];
      } else {
        const tm = GFM_TEXT_RE.exec(e);
        if (!tm) throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
        raw = tm[0];
      }
      const inRaw = this.state.inRawBlock;
      tok = { type: 'text', raw, text: inRaw ? raw : decodeNumeric(raw), escaped: inRaw };
      e = e.slice(raw.length);
      if (raw.slice(-1) !== '_') r = raw.slice(-1);
      s = true;
      const p = tokens.at(-1);
      if (p?.type === 'text') { p.raw += tok.raw; p.text += tok.text; }
      else tokens.push(tok);
    }
    return tokens;
  }

  // Manual text scanner: end index of the text run starting at e[0].
  // Mirrors the GFM inline text regex's stop conditions.
  scanTextEnd(e) {
    const n = e.length;
    let j;
    // first unit: a backtick run, a tilde run, or a single char
    if (e[0] === '`') { j = 1; while (j < n && e[j] === '`') j++; }
    else if (e[0] === '~') { j = 1; while (j < n && e[j] === '~') j++; }
    else j = 1;
    for (; j < n; j++) {
      const ch = e[j];
      if (ch === '\\' || ch === '<' || ch === '[' || ch === '!' || ch === '`' || ch === '*' || ch === '~' || ch === '_') return j;
      // hard break: non-space char followed by 2+ spaces and a newline (char included)
      if (ch !== ' ' && ch !== '\t' && ch !== '\n') {
        let k = j + 1, spaces = 0;
        while (k < n && (e[k] === ' ' || e[k] === '\t')) { spaces++; k++; }
        if (spaces >= 2 && k < n && e[k] === '\n') return j + 1;
      }
      // email / protocol lookaheads: a non-email-local char followed by an
      // email start, or a non-alnum char followed by mailto:/xmpp:
      if (!isEmailLocalChar(ch)) {
        if (emailMatchAt(e, j + 1)) return j + 1;
        if (ch !== ' ' && ch !== '\t' && ch !== '\n') {
          const rest = e.slice(j + 1, j + 8).toLowerCase();
          if (rest.startsWith('mailto:') || rest.startsWith('xmpp:')) return j + 1;
        }
      }
      // URL starts at j
      if (schemeUrlAt(e, j)) return j;
      if (wwwAt(e, j)) return j;
      if (emailMatchAt(e, j)) return j;
    }
    return n;
  }

  tokEscape(e) {
    const t = ESCAPE_RE.exec(e);
    if (t) return { type: 'escape', raw: t[0], text: t[1] };
    return null;
  }

  tokTag(e) {
    const t = TAG_RE.exec(e);
    if (!t) return null;
    if (!this.state.inLink && START_A_TAG.test(t[0])) this.state.inLink = true;
    else if (this.state.inLink && END_A_TAG.test(t[0])) this.state.inLink = false;
    if (!this.state.inRawBlock && START_PRE_SCRIPT.test(t[0])) this.state.inRawBlock = true;
    else if (this.state.inRawBlock && END_PRE_SCRIPT.test(t[0])) this.state.inRawBlock = false;
    return { type: 'html', raw: t[0], inLink: this.state.inLink, inRawBlock: this.state.inRawBlock, block: false, text: t[0] };
  }

  tokLink(e) {
    if (this.state.linkParenPossible === false) return null;
    const t = LINK_RE.exec(e);
    if (!t) return null;
    const n = t[0].charAt(0) === '!' ? 2 : 1;
    if (beCheck(e, t[1], n)) return null;
    const s = t[2].trim();
    if (/^</.test(s)) {
      if (!/>$/.test(s)) return null;
      const l = stripTrailing(s.slice(0, -1), '\\');
      if ((s.length - l.length) % 2 === 0) return null;
    } else {
      const l = parenIndex(t[2], '()');
      if (l === -2) return null;
      if (l > -1) {
        const h = (t[0].indexOf('!') === 0 ? 5 : 4) + t[1].length + l;
        t[2] = t[2].substring(0, l);
        t[0] = t[0].substring(0, h).trim();
        t[3] = '';
      }
    }
    const r = stripTrailing(t[0].slice(0, -1), '\\');
    if ((t[0].length - r.length) % 2 === 0) return null;
    let o = t[2], i = '';
    i = t[3] ? t[3].slice(1, -1) : '';
    o = o.trim();
    if (/^</.test(o)) o = o.slice(1, -1);
    return buildLink(t, { href: o && o.replace(ANY_PUNCT_RE, '$1'), title: i && i.replace(ANY_PUNCT_RE, '$1') }, t[0], this);
  }

  tokReflink(e) {
    let n = REFLINK_RE.exec(e) || NOLINK_RE.exec(e);
    if (!n) return null;
    const s = n[0].charAt(0) === '!' ? 2 : 1;
    if (beCheck(e, n[1], s)) return null;
    const r = this.links[normalizeLabel(n[2] || n[1])];
    if (!r) {
      const o = n[0].charAt(0);
      return { type: 'text', raw: o, text: o };
    }
    return buildLink(n, r, n[0], this);
  }

  tokEmStrong(e, masked, n = '') {
    const s = EM_L_DELIM.exec(e);
    if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
    const r = s[0][0];
    const o = n === r;
    const i = masked.length - e.length;
    let l = i;
    for (; l > 0 && masked[l - 1] === r;) l--;
    const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
    const h = p === '*' || p === '_' || !!INLINE_PUNCT.test(p);
    if (l < i) n = p;
    const u = l < i ? h : !!INLINE_PUNCT.test(n);
    if (s[4] && n.match(ALPHA_NUM)) return null;
    const d = s[1] || s[3] || '';
    if (!d || !n || u) {
      const k = [...s[0]].length - 1;
      let g, b, m = k, f = 0;
      const y = i - l + k;
      const R = !!p.trim() && (!!d || (r === '*' && !h));
      if (r !== '*' && r !== '_') return null;
      const A = r === '*' ? EM_R_AST : EM_R_UND;
      const fe = this.maskStack.at(-1);
      const v = fe.em[r];
      const Q = masked.length - e.length + k;
      if (v < Q) return null;
      const t = masked.slice(-1 * e.length + k);
      const ee = v - Q;
      A.lastIndex = 0;
      let m2;
      while ((m2 = A.exec(t)) !== null && !(m2.index > ee)) {
        if (g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6], !g) continue;
        if (b = [...g].length, m2[3] || m2[4]) { m += b; continue; }
        else if (m2[5] || m2[6] || R) {
          if (o && (m2[5] || m2[6])) break;
          if (y % 3 && !((y + b) % 3)) { f += b; continue; }
        }
        if (m -= b, m > 0) continue;
        b = Math.min(b, b + m + f);
        const te = [...m2[0]][0].length;
        const M = e.slice(0, k + m2.index + te + b);
        if (Math.min(k, b) % 2) {
          const U = M.slice(1, -1);
          return { type: 'em', raw: M, text: U, tokens: this.inlineTokens(U) };
        }
        const ne = M.slice(2, -2);
        return { type: 'strong', raw: M, text: ne, tokens: this.inlineTokens(ne) };
      }
    }
    return null;
  }

  tokCodespan(e) {
    const t = CODE_SPAN_RE.exec(e);
    if (!t) return null;
    let n = t[2].replace(NEWLINE_GLOBAL, ' ');
    const s = NON_SPACE.test(n);
    const r = n.startsWith(' ') && n.endsWith(' ');
    if (s && r) n = n.substring(1, n.length - 1);
    return { type: 'codespan', raw: t[0], text: n };
  }

  tokBr(e) {
    const t = BR_RE.exec(e);
    if (t) return { type: 'br', raw: t[0] };
    return null;
  }

  tokDel(e, masked, n = '') {
    const s = DEL_L_DELIM.exec(e);
    if (!s) return null;
    if (!(s[1] || '') || !n || INLINE_PUNCT.test(n)) {
      const o = [...s[0]].length - 1;
      let i, l, p = o;
      const h = DEL_R_DELIM;
      const fe = this.maskStack.at(-1);
      const u = fe.del;
      const d = masked.length - e.length + o;
      if (u < d) return null;
      const t = masked.slice(-1 * e.length + o);
      const k = u - d;
      h.lastIndex = 0;
      let m2;
      while ((m2 = h.exec(t)) !== null && !(m2.index > k)) {
        if (i = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6], !i || (l = [...i].length, l !== o)) continue;
        if (m2[3] || m2[4]) { p += l; continue; }
        if (p -= l, p > 0) continue;
        l = Math.min(l, l + p);
        const g = [...m2[0]][0].length;
        const b = e.slice(0, o + m2.index + g + l);
        const m = b.slice(o, -o);
        return { type: 'del', raw: b, text: m, tokens: this.inlineTokens(m) };
      }
    }
    return null;
  }

  tokAutolink(e) {
    const t = AUTOLINK_RE.exec(e);
    if (!t) return null;
    let n, s;
    if (t[2] === '@') { n = t[1]; s = 'mailto:' + n; }
    else { n = t[1]; s = n; }
    return { type: 'link', raw: t[0], text: n, href: s, autolink: true, tokens: [{ type: 'text', raw: n, text: n }] };
  }

  tokUrl(e) {
    const t = URL_RE.exec(e);
    if (!t) return null;
    let n, s;
    if (t[2] === '@') { n = t[0]; s = 'mailto:' + n; }
    else {
      let r;
      let u = t[0];
      do { r = u; u = BACKPEDAL_RE.exec(u)?.[0] ?? ''; } while (r !== u);
      n = u;
      s = t[1] === 'www.' ? 'http://' + u : u;
    }
    return { type: 'link', raw: n, text: n, href: s, autolink: true, tokens: [{ type: 'text', raw: n, text: n }] };
  }
}

// ---------------------------------------------------------------------------
// Renderers (mirror marked's Parser + textRenderer, direct string building)
// ---------------------------------------------------------------------------

function renderInlineText(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong': case 'em': case 'del': case 'link': case 'image':
        out += tok.tokens ? renderInlineText(tok.tokens) : tok.text;
        break;
      case 'codespan': case 'html': case 'text': case 'escape':
        out += tok.text;
        break;
      case 'br': break;
      case 'checkbox': out += tok.raw; break;
      default: out += tok.text ?? '';
    }
  }
  return out;
}

function renderInlineToken(tok) {
  switch (tok.type) {
    case 'text':
      return tok.escaped ? tok.text : esc(tok.text, false);
    case 'escape':
      return esc(tok.text, false);
    case 'html':
      return tok.text;
    case 'codespan':
      return '<code>' + esc(tok.text, true) + '</code>';
    case 'br':
      return '<br>';
    case 'em':
      return '<em>' + renderInline(tok.tokens) + '</em>';
    case 'strong':
      return '<strong>' + renderInline(tok.tokens) + '</strong>';
    case 'del':
      return '<del>' + renderInline(tok.tokens) + '</del>';
    case 'link': {
      const o = tok.autolink ? esc(tok.text, true) : renderInline(tok.tokens);
      const href = cleanUrl(tok.href);
      if (href === null) return o;
      let l = '<a href="' + esc(href, tok.autolink) + '"';
      if (tok.title) l += ' title="' + esc(tok.title, false) + '"';
      return l + '>' + o + '</a>';
    }
    case 'image': {
      const alt = tok.tokens ? renderInlineText(tok.tokens) : tok.text;
      const href = cleanUrl(tok.href);
      if (href === null) return esc(alt, false);
      let o = '<img src="' + esc(href, false) + '" alt="' + esc(alt, false) + '"';
      if (tok.title) o += ' title="' + esc(tok.title, false) + '"';
      return o + '>';
    }
    case 'checkbox':
      return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    default:
      return '';
  }
}

function renderInline(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) out += renderInlineToken(tokens[i]);
  return out;
}

function renderBlocks(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) out += renderBlock(tokens[i]);
  return out;
}

function renderBlock(tok) {
  switch (tok.type) {
    case 'space': return '';
    case 'code': {
      const lang = (tok.lang || '').match(NOT_SPACE_START)?.[0] ?? '';
      const text = tok.text ? tok.text.replace(ENDING_NEWLINE, '') + '\n' : '';
      const body = tok.escaped ? text : esc(text, true);
      return lang ? '<pre><code class="language-' + esc(lang, false) + '">' + body + '</code></pre>\n'
                  : '<pre><code>' + body + '</code></pre>\n';
    }
    case 'heading': return '<h' + tok.depth + '>' + renderInline(tok.tokens) + '</h' + tok.depth + '>\n';
    case 'hr': return '<hr>\n';
    case 'blockquote': return '<blockquote>\n' + renderBlocks(tok.tokens) + '</blockquote>\n';
    case 'list': {
      let s = '';
      for (const item of tok.items) s += renderBlock(item);
      const tag = tok.ordered ? 'ol' : 'ul';
      const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
      return '<' + tag + start + '>\n' + s + '</' + tag + '>\n';
    }
    case 'list_item': return '<li>' + renderBlocks(tok.tokens) + '</li>\n';
    case 'html': return tok.text;
    case 'def': return '';
    case 'table': {
      let head = '';
      for (let r = 0; r < tok.header.length; r++) head += renderTableCell(tok.header[r]);
      let t = '<tr>\n' + head + '</tr>\n';
      let body = '';
      for (let r = 0; r < tok.rows.length; r++) {
        let row = '';
        for (let i = 0; i < tok.rows[r].length; i++) row += renderTableCell(tok.rows[r][i]);
        body += '<tr>\n' + row + '</tr>\n';
      }
      if (body) body = '<tbody>' + body + '</tbody>';
      return '<table>\n<thead>\n' + t + '</thead>\n' + body + '</table>\n';
    }
    case 'paragraph': return '<p>' + renderInline(tok.tokens) + '</p>\n';
    case 'text': return renderInline(tok.tokens);
    case 'checkbox': return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    default: return '';
  }
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  return (cell.align ? '<' + tag + ' align="' + cell.align + '">' : '<' + tag + '>') + renderInline(cell.tokens) + '</' + tag + '>\n';
}

// ---------------------------------------------------------------------------
// Block lexer (mirrors marked's Lexer.blockTokens + Tokenizer)
// ---------------------------------------------------------------------------

class BlockLexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.links = this.tokens.links;
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.ilx = new InlineLexer(this.links);
    this.ilx.state = this.state;
  }

  lex(src) {
    if (src.includes('\r')) src = src.replace(/\r\n|\r/g, '\n');
    this.blockTokens(src, this.tokens);
    for (let t = 0; t < this.inlineQueue.length; t++) {
      const n = this.inlineQueue[t];
      this.state.inRawBlock = false;
      n.tokens.push(...this.ilx.inlineTokens(n.src));
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  // Register an inline source for deferred parsing; returns the token array.
  inline(src) {
    const tokens = [];
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  blockTokens(e, t = [], n = false) {
    let guard = Infinity;
    while (e) {
      if (e.length < guard) guard = e.length;
      else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
      let r;
      if ((r = this.tokSpace(e))) { e = e.slice(r.raw.length); const i = t.at(-1); if (r.raw.length === 1 && i !== undefined) i.raw += '\n'; else t.push(r); continue; }
      if ((r = this.tokCode(e))) { e = e.slice(r.raw.length); const i = t.at(-1); if (i?.type === 'paragraph' || i?.type === 'text') { i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw; i.text += '\n' + r.text; this.inlineQueue.at(-1).src = i.text; } else t.push(r); continue; }
      if ((r = this.tokFences(e))) { e = e.slice(r.raw.length); t.push(r); continue; }
      if ((r = this.tokHeading(e))) { e = e.slice(r.raw.length); t.push(r); continue; }
      if ((r = this.tokHr(e))) { e = e.slice(r.raw.length); t.push(r); continue; }
      if ((r = this.tokBlockquote(e))) { e = e.slice(r.raw.length); t.push(r); continue; }
      if ((r = this.tokList(e))) { e = e.slice(r.raw.length); t.push(r); continue; }
      if ((r = this.tokHtml(e))) { e = e.slice(r.raw.length); t.push(r); continue; }
      if ((r = this.tokDef(e))) {
        e = e.slice(r.raw.length);
        const i = t.at(-1);
        if (i?.type === 'paragraph' || i?.type === 'text') { i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw; i.text += '\n' + r.raw; this.inlineQueue.at(-1).src = i.text; }
        else { if (!this.links[r.tag]) this.links[r.tag] = { href: r.href, title: r.title }; t.push(r); }
        continue;
      }
      if ((r = this.tokTable(e))) { e = e.slice(r.raw.length); t.push(r); continue; }
      if ((r = this.tokLheading(e))) { e = e.slice(r.raw.length); t.push(r); continue; }
      if (this.state.top && (r = this.tokParagraph(e))) {
        const i = t.at(-1);
        if (n && i?.type === 'paragraph') { i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw; i.text += '\n' + r.text; this.inlineQueue.pop(); this.inlineQueue.at(-1).src = i.text; }
        else t.push(r);
        e = e.slice(r.raw.length);
        continue;
      }
      if ((r = this.tokText(e))) {
        e = e.slice(r.raw.length);
        const i = t.at(-1);
        if (i?.type === 'text') { i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw; i.text += '\n' + r.text; this.inlineQueue.pop(); this.inlineQueue.at(-1).src = i.text; }
        else t.push(r);
        continue;
      }
      if (e) throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
    }
    this.state.top = true;
    return t;
  }

  tokSpace(e) {
    const t = NEWLINE_RE.exec(e);
    if (t && t[0].length > 0) return { type: 'space', raw: t[0] };
    return null;
  }

  tokCode(e) {
    const t = CODE_RE.exec(e);
    if (!t) return null;
    const n = trimTrailingBlanks(t[0]);
    const s = n.replace(CODE_REMOVE_INDENT, '');
    return { type: 'code', raw: n, codeBlockStyle: 'indented', text: s };
  }

  tokFences(e) {
    const t = FENCES_RE.exec(e);
    if (!t) return null;
    const n = t[0];
    const s = dtCompensate(n, t[3] || '');
    return { type: 'code', raw: n, lang: t[2] ? t[2].trim().replace(ANY_PUNCT_RE, '$1') : t[2], text: s };
  }

  tokHeading(e) {
    const t = HEADING_RE.exec(e);
    if (!t) return null;
    let n = t[2].trim();
    if (ENDING_HASH.test(n)) {
      const s = stripTrailing(n, '#');
      if (!s || ENDING_SPACE_TAB.test(s)) n = s.trim();
    }
    return { type: 'heading', raw: stripTrailing(t[0], '\n'), depth: t[1].length, text: n, tokens: this.inline(n) };
  }

  tokHr(e) {
    const t = HR_RE.exec(e);
    if (t) return { type: 'hr', raw: stripTrailing(t[0], '\n') };
    return null;
  }

  tokBlockquote(e) {
    const t = BLOCKQUOTE_RE.exec(e);
    if (!t) return null;
    const lines = stripTrailing(t[0], '\n').split('\n');
    let raw = '', text = '';
    const tokens = [];
    const n = lines;
    while (n.length > 0) {
      let hasMarker = false;
      const chunk = [];
      let p = 0;
      for (; p < n.length; p++) {
        if (BQ_START.test(n[p])) { chunk.push(n[p]); hasMarker = true; }
        else if (!hasMarker) chunk.push(n[p]);
        else break;
      }
      n.splice(0, p);
      const h = chunk.join('\n');
      const u = h
        .replace(BQ_MARKER_WS, (g, b, m) => b + expandTabs(m, b.length))
        .replace(BQ_SETEXT, '\n    $1')
        .replace(BQ_SETEXT2, '');
      raw = raw ? raw + '\n' + h : h;
      text = text ? text + '\n' + u : u;
      const savedTop = this.state.top;
      this.state.top = true;
      this.blockTokens(u, tokens, true);
      this.state.top = savedTop;
      if (n.length === 0) break;
      const k = tokens.at(-1);
      if (k?.type === 'code' || k?.type === 'heading' || k?.type === 'hr' || k?.type === 'html' || k?.type === 'table') break;
      if (k?.type === 'blockquote') {
        const g = k;
        const b = n.join('\n');
        const m = g.raw + '\n' + b.replace(BQ_SETEXT2, '');
        const f = this.tokBlockquote(m);
        tokens[tokens.length - 1] = f;
        const y = m.slice(f.raw.length).replace(/^\n/, '');
        const R = y ? y.split('\n').length : 0;
        const A = R ? n.slice(0, -R) : n;
        if (A.length > 0) raw = raw + '\n' + A.join('\n');
        text = text.slice(0, text.length - g.text.length) + f.text;
        n.splice(0, A.length);
        if (n.length > 0 && BQ_START.test(n[0])) continue;
        break;
      } else if (k?.type === 'list') {
        const g = k;
        const b = g.raw + '\n' + n.join('\n');
        const m = this.tokList(b);
        tokens[tokens.length - 1] = m;
        const f = m.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m.raw.length).split('\n').length : 0;
        if (f > 0) {
          const y = n.slice(0, f).join('\n');
          raw = raw + '\n' + y;
          text = text + '\n' + y;
        }
        n.splice(0, f);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  tokList(e) {
    const t = LIST_RE.exec(e);
    if (!t) return null;
    const src0 = e;
    const srcLen = () => src0.length - e.length;
    const r = t[1].trim();
    const ordered = r.length > 1;
    const list = { type: 'list', raw: '', ordered, start: ordered ? +r.slice(0, -1) : '', loose: false, items: [] };
    const markerPat = ordered ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
    const itemRe = listItemRegex(markerPat);
    let p = false;
    while (e) {
      let u = false, d = '';
      const m = itemRe.exec(e);
      if (!m || HR_RE.test(e)) break;
      const startPos = srcLen();
      e = e.slice(m[0].length);
      const g = m[2].split('\n', 1)[0];
      const b = m[1].length;
      let mm = g.replace(LEADING_SPACE_TAB, (v) => expandTabs(v, b));
      let f = e.split('\n', 1)[0];
      let y = !mm.trim();
      let R = 0;
      if (y) R = b + 1;
      else {
        R = mm.search(NON_SPACE);
        R = R > 4 ? 1 : R;
        d = mm.slice(R);
        R += b;
      }
      let entered = true;
      if (y && BLANK_LINE.test(f)) { e = e.slice(f.length + 1); u = true; entered = false; }
      if (entered && !u) {
        const v = nextBulletRegex(R);
        const Q = hrRegex(R);
        const ee = fencesBeginRegex(R);
        const te = headingBeginRegex(R);
        const M = htmlBeginRegex(R);
        const ne = blockquoteBeginRegex(R);
        const nClamp = Math.max(0, Math.min(3, R - 1));
        // First-char dispatch for the six begin-regexes (all are ^ {0,n}...).
        const beginsBlock = (line) => {
          let sp = 0;
          while (sp < line.length && line.charCodeAt(sp) === 32) sp++;
          if (sp > nClamp) return false;
          if (sp >= line.length) return false;
          const c = line.charCodeAt(sp);
          if (c === 9) return false; // tab after spaces: ^ {0,n} can't match
          if (c === 96 || c === 126) return ee.test(line);
          if (c === 35) return te.test(line);
          if (c === 60) return M.test(line);
          if (c === 62) return ne.test(line);
          if (c === 42 || c === 43 || c === 45) return v.test(line) || Q.test(line);
          if (c >= 48 && c <= 57) return v.test(line);
          if (c === 95) return Q.test(line);
          return false;
        };
        while (e) {
          const nl = e.indexOf('\n');
          const U = nl === -1 ? e : e.slice(0, nl);
          let Z;
          f = U;
          Z = expandLeading(f);
          if (beginsBlock(f)) break;
          if (Z.search(NON_SPACE) >= R || !f.trim()) d += '\n' + Z.slice(R);
          else {
            // marked tests only fences/heading/html/hr on m here (not
            // blockquote or next-bullet), so use a restricted dispatch.
            let mmBreak = false;
            if (y || mm.search(NON_SPACE) >= 4) mmBreak = true;
            else {
              let sp = 0;
              while (sp < mm.length && mm.charCodeAt(sp) === 32) sp++;
              if (sp <= nClamp && sp < mm.length) {
                const c = mm.charCodeAt(sp);
                if (c === 96 || c === 126) mmBreak = ee.test(mm);
                else if (c === 35) mmBreak = te.test(mm);
                else if (c === 60) mmBreak = M.test(mm);
                else if (c === 42 || c === 45 || c === 95) mmBreak = Q.test(mm);
              }
            }
            if (mmBreak) break;
            const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && LHEADING.test(mm + '\n' + f)
              ? '    ' + Z.replace(/^ {0,3}/, '')
              : f;
            d += '\n' + qe;
          }
          y = !f.trim();
          e = nl === -1 ? '' : e.slice(nl + 1);
          // m for the next iteration is Z.slice(R) — but `mm` is the var used
          // in the setext test; mirror marked: m = Z.slice(R)
          mm = Z.slice(R);
        }
      }
      const A = src0.slice(startPos, srcLen());
      if (!list.loose) {
        if (p) list.loose = true;
        else if (DOUBLE_BLANK.test(A)) p = true;
      }
      list.items.push({ type: 'list_item', raw: A, task: LIST_IS_TASK.test(d), loose: false, text: d, tokens: [] });
    }
    const h = list.items.at(-1);
    if (!h) return null;
    h.raw = h.raw.trimEnd();
    h.text = h.text.trimEnd();
    list.raw = src0.slice(0, srcLen()).trimEnd();
    for (const u of list.items) {
      this.state.top = false;
      u.tokens = this.blockTokens(u.text, []);
      if (!list.loose) {
        const sp = u.tokens.filter((g) => g.type === 'space');
        const k = sp.length > 0 && sp.some((g) => ANY_LINE.test(g.raw));
        list.loose = k;
      }
    }
    for (const u of list.items) {
      const d0 = u.tokens[0];
      if (u.task && (d0?.type === 'text' || d0?.type === 'paragraph')) {
        u.text = u.text.replace(LIST_REPLACE_TASK, '');
        d0.raw = d0.raw.replace(LIST_REPLACE_TASK, '');
        d0.text = d0.text.replace(LIST_REPLACE_TASK, '');
        for (let g = this.inlineQueue.length - 1; g >= 0; g--) {
          if (LIST_IS_TASK.test(this.inlineQueue[g].src)) {
            this.inlineQueue[g].src = this.inlineQueue[g].src.replace(LIST_REPLACE_TASK, '');
            break;
          }
        }
        const k = LIST_TASK_CHECKBOX.exec(u.raw);
        if (k) {
          const g = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
          u.checked = g.checked;
          if (list.loose) {
            if (u.tokens[0] && ['paragraph', 'text'].includes(u.tokens[0].type) && 'tokens' in u.tokens[0] && u.tokens[0].tokens) {
              u.tokens[0].raw = g.raw + u.tokens[0].raw;
              u.tokens[0].text = g.raw + u.tokens[0].text;
              u.tokens[0].tokens.unshift(g);
            } else {
              u.tokens.unshift({ type: 'paragraph', raw: g.raw, text: g.raw, tokens: [g] });
            }
          } else {
            u.tokens.unshift(g);
          }
        }
      } else if (u.task) u.task = false;
    }
    if (list.loose) {
      for (const u of list.items) {
        u.loose = true;
        for (const d of u.tokens) if (d.type === 'text') d.type = 'paragraph';
      }
    }
    return list;
  }

  tokHtml(e) {
    const t = HTML_RE.exec(e);
    if (t) {
      const n = trimTrailingBlanks(t[0]);
      return { type: 'html', raw: n, pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style', text: n };
    }
    return null;
  }

  tokDef(e) {
    const t = DEF_RE.exec(e);
    if (!t) return null;
    if (!/^</.test(t[2]) && parenIndex(t[2], '()') !== -1) return null;
    const tag = normalizeLabel(t[1]);
    const href = t[2] ? t[2].replace(HREF_BRACKETS, '$1').replace(ANY_PUNCT_RE, '$1') : '';
    const title = t[3] ? t[3].substring(1, t[3].length - 1).replace(ANY_PUNCT_RE, '$1') : t[3];
    return { type: 'def', tag, raw: stripTrailing(t[0], '\n'), href, title };
  }

  tokTable(e) {
    const t = TABLE_RE.exec(e);
    if (!t || !TABLE_DELIM.test(t[2])) return null;
    const n = splitCells(t[1]);
    const s = t[2].replace(TABLE_ALIGN_CHARS, '').split('|');
    const rows = t[3]?.trim() ? t[3].replace(TABLE_ROW_BLANK, '').split('\n') : [];
    const o = { type: 'table', raw: stripTrailing(t[0], '\n'), header: [], align: [], rows: [] };
    if (n.length === s.length) {
      for (const i of s) {
        if (TABLE_ALIGN_RIGHT.test(i)) o.align.push('right');
        else if (TABLE_ALIGN_CENTER.test(i)) o.align.push('center');
        else if (TABLE_ALIGN_LEFT.test(i)) o.align.push('left');
        else o.align.push(null);
      }
      for (let i = 0; i < n.length; i++) o.header.push({ text: n[i], tokens: this.inline(n[i]), header: true, align: o.align[i] });
      for (const i of rows) o.rows.push(splitCells(i, o.header.length).map((l, p) => ({ text: l, tokens: this.inline(l), header: false, align: o.align[p] })));
      return o;
    }
    return null;
  }

  tokLheading(e) {
    const t = LHEADING.exec(e);
    if (!t) return null;
    const n = t[1].trim();
    return { type: 'heading', raw: stripTrailing(t[0], '\n'), depth: t[2].charAt(0) === '=' ? 1 : 2, text: n, tokens: this.inline(n) };
  }

  tokParagraph(e) {
    const t = PARA_GFM.exec(e);
    if (!t) return null;
    const n = t[1].charAt(t[1].length - 1) === '\n' ? t[1].slice(0, -1) : t[1];
    return { type: 'paragraph', raw: t[0], text: n, tokens: this.inline(n) };
  }

  tokText(e) {
    const t = TEXT_RE.exec(e);
    if (t) return { type: 'text', raw: t[0], text: t[0], tokens: this.inline(t[0]) };
    return null;
  }
}

// ---------------------------------------------------------------------------
// fastParse: the clean-room fast path. Returns null to bail to marked.
// ---------------------------------------------------------------------------

function fastParse(md) {
  if (typeof md !== 'string') md = String(md);
  const lx = new BlockLexer();
  const tokens = lx.lex(md);
  return renderBlocks(tokens);
}
