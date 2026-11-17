'use strict';
// NetBox (source of truth for network devices) -> Vytty sessions.
// Reads devices (dcim) and optionally virtual machines through the REST API
// with a read-only API token and turns them into sessions grouped by site /
// role / tenant. Re-syncing updates the sessions created earlier (matched by
// NetBox object id) instead of duplicating them.

const ipOnly = (addr) => String(addr || '').replace(/\/\d+$/, '').trim();

function authHeader(token) {
  const t = String(token || '').trim();
  if (!t) throw new Error('No NetBox API token');
  if (/\s/.test(t)) return t; // "Token abc" / "Bearer nbt_..." typed in full
  return t.startsWith('nbt_') ? `Bearer ${t}` : `Token ${t}`;
}

function apiUrl(base, path, query) {
  const root = String(base || '').trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  if (!/^https?:\/\//i.test(root)) throw new Error('The NetBox URL must start with https:// (or http://)');
  const u = new URL(`${root}${path}`);
  for (const [k, v] of new URLSearchParams(String(query || '').replace(/^\?/, ''))) u.searchParams.append(k, v);
  return u;
}

// Follow NetBox pagination ("next"), keeping requests on the configured host
// (NetBox behind a proxy sometimes reports its internal address in "next").
async function fetchAll(fetchFn, base, path, query, token, { limit = 500, max = 20000 } = {}) {
  const first = apiUrl(base, path, query);
  if (!first.searchParams.has('limit')) first.searchParams.set('limit', String(limit));
  const results = [];
  let url = first.toString();
  while (url && results.length < max) {
    const res = await fetchFn(url, { headers: { Authorization: authHeader(token), Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) throw new Error(`NetBox rejected the API token (${res.status})`);
    if (res.status === 404) throw new Error(`NetBox API not found at ${first.origin}${path} - check the URL`);
    if (!res.ok) throw new Error(`NetBox returned ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.results)) throw new Error('Unexpected answer from NetBox (is this the API URL?)');
    results.push(...data.results);
    if (!data.next) break;
    const next = new URL(data.next);
    url = `${first.origin}${next.pathname}${next.search}`;
  }
  return results;
}

function highlightFor(platform) {
  const t = String(platform || '').toLowerCase();
  if (/nx-?os|nexus/.test(t)) return 'cisco-nxos';
  if (/ios|catalyst|cisco/.test(t)) return 'cisco-ios';
  if (/linux|ubuntu|debian|centos|rhel|rocky|alma|suse|fedora/.test(t)) return 'linux';
  return 'auto';
}

const nameOf = (x) => (x && (x.name || x.display || x.slug)) || '';

// One NetBox object -> a session description (no ids yet).
function mapObject(obj, kind, opts = {}) {
  const ip = obj.primary_ip || obj.primary_ip4 || obj.primary_ip6;
  const name = obj.name || (ip && ipOnly(ip.address)) || `${kind} ${obj.id}`;
  let host = '';
  if (opts.hostFrom === 'name') host = obj.name ? `${obj.name}${opts.domain ? `.${String(opts.domain).replace(/^\./, '')}` : ''}` : '';
  else if (opts.hostFrom === 'dns' && ip && ip.dns_name) host = ip.dns_name;
  if (!host && ip) host = ipOnly(ip.address);
  if (!host && obj.name && opts.hostFrom !== 'ip') host = obj.name;
  if (!host) return null;
  const site = nameOf(obj.site) || (kind === 'vm' ? nameOf(obj.cluster) : '');
  const role = nameOf(obj.role || obj.device_role);
  const tenant = nameOf(obj.tenant);
  const group = String(opts.groupBy || 'site/role');
  const folder = ['NetBox', ...group.split('/').map((g) => ({ site, role, tenant })[g] || (g === 'none' ? null : 'Unassigned')).filter((x) => x !== null)];
  const platform = nameOf(obj.platform);
  const notes = [obj.description, platform && `Platform: ${platform}`, obj.serial && `Serial: ${obj.serial}`, obj.display_url && `NetBox: ${obj.display_url}`].filter(Boolean).join('\n');
  return {
    sourceId: `${kind === 'vm' ? 'virtualization.vm' : 'dcim.device'}:${obj.id}`,
    name,
    host,
    folder,
    highlight: highlightFor(`${platform} ${obj.platform && obj.platform.slug ? obj.platform.slug : ''}`),
    notes,
    url: obj.display_url || '',
  };
}

async function fetchSessions(fetchFn, opts) {
  const devices = await fetchAll(fetchFn, opts.url, '/api/dcim/devices/', opts.deviceFilter, opts.token);
  const vms = opts.includeVMs ? await fetchAll(fetchFn, opts.url, '/api/virtualization/virtual-machines/', opts.vmFilter, opts.token) : [];
  const out = [];
  let skipped = 0;
  for (const d of devices) { const m = mapObject(d, 'device', opts); if (m) out.push(m); else skipped++; }
  for (const v of vms) { const m = mapObject(v, 'vm', opts); if (m) out.push(m); else skipped++; }
  return { items: out, devices: devices.length, vms: vms.length, skipped };
}

// Quick connectivity check for the settings dialog.
async function testConnection(fetchFn, opts) {
  const res = await fetchFn(apiUrl(opts.url, '/api/status/').toString(), { headers: { Authorization: authHeader(opts.token), Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) throw new Error('NetBox rejected the API token');
  if (!res.ok) throw new Error(`NetBox returned ${res.status}`);
  const st = await res.json();
  return { version: st['netbox-version'] || st.netbox_version || '?' };
}

module.exports = { fetchSessions, testConnection, mapObject, fetchAll, authHeader, apiUrl, highlightFor };
