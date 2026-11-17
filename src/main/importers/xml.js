'use strict';
// A small, forgiving XML parser for configuration exports (SecureCRT,
// mRemoteNG). Builds { name, attrs, children, text } nodes. No DTDs, no
// external entities (nothing is ever fetched or expanded beyond the five
// predefined entities and numeric character references).

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENTITIES[e];
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  return attrs;
}

function parseXml(text) {
  const src = String(text).replace(/^﻿/, '');
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { stack[stack.length - 1].text += decodeEntities(src.slice(i)); break; }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      stack[stack.length - 1].text += src.slice(lt + 9, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end + 3;
    } else if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end === -1 ? src.length : end + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt + 2);
      const name = src.slice(lt + 2, end === -1 ? src.length : end).trim();
      // Close up to the matching element (tolerates a missing end tag).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      i = end === -1 ? src.length : end + 1;
    } else {
      // Find the end of the tag, skipping '>' inside quoted attribute values.
      let j = lt + 1;
      let quote = null;
      for (; j < src.length; j++) {
        const c = src[j];
        if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break;
      }
      const body = src.slice(lt + 1, j);
      const selfClosing = body.endsWith('/');
      const inner = selfClosing ? body.slice(0, -1) : body;
      const m = /^([^\s/>]+)([\s\S]*)$/.exec(inner.trim());
      if (m) {
        const node = { name: m[1], attrs: parseAttrs(m[2] || ''), children: [], text: '' };
        stack[stack.length - 1].children.push(node);
        if (!selfClosing) stack.push(node);
      }
      i = j + 1;
    }
  }
  return root;
}

// Local name without a namespace prefix ("mrng:Connections" -> "Connections").
const localName = (n) => String(n || '').replace(/^.*:/, '');

module.exports = { parseXml, decodeEntities, localName };
