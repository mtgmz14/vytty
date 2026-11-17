'use strict';
// OpenSSH client configuration (~/.ssh/config).
// Every "Host" entry with a concrete name becomes an SSH session; "Host *"
// blocks supply defaults (User, Port, IdentityFile) like ssh does. ProxyJump to
// another imported host becomes Vytty's jump host; LocalForward and
// DynamicForward become port forwards. Match blocks and Include are skipped.
const os = require('os');
const path = require('path');
const { decodeText, TreeBuilder } = require('./common');

function tokens(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

const expandHome = (p) => String(p).replace(/^~(?=$|[\\/])/, os.homedir()).replace(/%d/g, os.homedir());

function parseBlocks(text) {
  const blocks = [];
  let cur = null;
  const skipped = { match: 0, include: 0 };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const args = tokens(m[2]);
    if (key === 'host') { cur = { patterns: args, opts: {} }; blocks.push(cur); continue; }
    if (key === 'match') { cur = null; skipped.match++; continue; }
    if (key === 'include') { skipped.include++; continue; }
    if (!cur) continue;
    if (key === 'localforward' || key === 'dynamicforward') (cur.opts[key] = cur.opts[key] || []).push(args);
    else if (key === 'identityfile') { if (!cur.opts.identityfile) cur.opts.identityfile = args[0]; }
    else if (!(key in cur.opts)) cur.opts[key] = args.join(' '); // first value wins, like ssh
  }
  return { blocks, skipped };
}

const isPattern = (p) => /[*?!]/.test(p);

function forwardsOf(opts) {
  const out = [];
  for (const a of opts.localforward || []) {
    const listen = String(a[0] || '');
    const dest = String(a[1] || '');
    const lm = /^(?:(.*):)?(\d+)$/.exec(listen);
    const dm = /^\[?([^\]]+?)\]?:(\d+)$/.exec(dest);
    if (lm && dm) out.push({ type: 'L', listenHost: lm[1] || '127.0.0.1', listenPort: Number(lm[2]), destHost: dm[1], destPort: Number(dm[2]) });
  }
  for (const a of opts.dynamicforward || []) {
    const lm = /^(?:(.*):)?(\d+)$/.exec(String(a[0] || ''));
    if (lm) out.push({ type: 'D', listenHost: lm[1] || '127.0.0.1', listenPort: Number(lm[2]) });
  }
  return out;
}

function parse(input) {
  const { blocks, skipped } = parseBlocks(decodeText(input));
  const tree = new TreeBuilder('SSH config');
  const defaults = {};
  for (const b of blocks) {
    if (b.patterns.every(isPattern) && b.patterns.includes('*')) {
      for (const [k, v] of Object.entries(b.opts)) if (!(k in defaults)) defaults[k] = v;
    }
  }
  const byAlias = new Map();
  const pending = [];
  for (const b of blocks) {
    const alias = b.patterns.find((p) => !isPattern(p));
    if (!alias) continue;
    const o = { ...defaults, ...b.opts };
    const host = String(o.hostname || alias).replace(/%h/g, alias);
    const s = tree.add({
      name: alias,
      protocol: 'ssh',
      host,
      port: Number(o.port) || 22,
      username: o.user || '',
      ...(o.identityfile ? { keyPath: expandHome(o.identityfile) } : {}),
      ...(forwardsOf(b.opts).length ? { forwards: forwardsOf(b.opts) } : {}),
      ...(/^yes$/i.test(o.forwardagent || '') || o.identityagent ? { useAgent: true } : {}),
    }, 'SSH');
    for (const p of b.patterns) if (!isPattern(p)) byAlias.set(p.toLowerCase(), s);
    if (o.proxyjump && !/^none$/i.test(o.proxyjump)) pending.push([s, o.proxyjump]);
  }
  // ProxyJump: first hop only; an alias of another imported host becomes its jump host.
  for (const [s, pj] of pending) {
    const first = pj.split(',')[0].trim();
    const alias = first.replace(/^[^@]*@/, '').replace(/:\d+$/, '').toLowerCase();
    const jump = byAlias.get(alias);
    if (jump && jump !== s) s.jumpId = jump.id;
    else s.notes = `ProxyJump ${pj} (not an imported host - set the jump host in the session)`;
    if (pj.includes(',')) s.notes = `${s.notes ? `${s.notes}\n` : ''}Multi-hop ProxyJump ${pj}: only the first hop is used`;
  }
  const res = tree.result();
  res.stats.skippedBlocks = skipped;
  return res;
}

const defaultPath = () => path.join(os.homedir(), '.ssh', 'config');

module.exports = { parse, parseBlocks, defaultPath };
