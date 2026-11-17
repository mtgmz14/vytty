'use strict';
// ssh:// and telnet:// links (NetBox, Zabbix, LibreNMS, wikis...) opened in
// Vytty. Registration is opt-in (Settings -> Integrations) and per user
// (HKCU on Windows). A link only ever opens a connection tab - it cannot run
// commands - and host / user names are validated.

const URL_RE = /^(ssh|telnet):\/\//i;

function parseConnectUrl(raw) {
  if (typeof raw !== 'string' || !URL_RE.test(raw.trim())) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  const protocol = u.protocol.replace(/:$/, '').toLowerCase();
  const host = decodeURIComponent(u.hostname || '').replace(/^\[|\]$/g, '');
  if (!host || !/^[A-Za-z0-9._:-]+$/.test(host) || host.length > 253) return null;
  let username = '';
  try { username = decodeURIComponent(u.username || ''); } catch { username = ''; }
  username = username.split(';')[0]; // ssh://user;fingerprint=...@host (RFC draft)
  if (username && !/^[A-Za-z0-9._@\\-]{1,64}$/.test(username)) username = '';
  const port = Number(u.port) || (protocol === 'ssh' ? 22 : 23);
  if (port < 1 || port > 65535) return null;
  return { protocol, host, port, username, name: `${username ? `${username}@` : ''}${host}${u.port ? `:${port}` : ''}` };
}

// Links passed on the command line (first start or a second instance).
function urlsFromArgv(argv) {
  return (argv || []).filter((a) => typeof a === 'string' && URL_RE.test(a)).map(parseConnectUrl).filter(Boolean);
}

module.exports = { parseConnectUrl, urlsFromArgv, PROTOCOLS: ['ssh', 'telnet'] };
