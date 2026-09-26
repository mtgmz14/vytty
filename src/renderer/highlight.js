'use strict';
// Syntax highlighting for terminal output (Cisco IOS/IOS-XE, Cisco NX-OS, Linux).
// Works on the raw stream before it reaches xterm.js: escape sequences are
// passed through untouched and SGR colour codes are injected around matches
// in plain text. Output the remote side already coloured, and full-screen
// apps (alternate screen: vim, htop, less...), are left alone.
(() => {
  const SGR = {
    bold: '1', dim: '2', italic: '3', underline: '4', inverse: '7',
    black: '30', red: '31', green: '32', yellow: '33', blue: '34', magenta: '35', cyan: '36', white: '37', gray: '90',
    brightRed: '91', brightGreen: '92', brightYellow: '93', brightBlue: '94', brightMagenta: '95', brightCyan: '96', brightWhite: '97',
  };
  const codes = (style) => style.split(/[\s+]+/).filter(Boolean).map((s) => SGR[s] || (/^\d+(;\d+)*$/.test(s) ? s : '')).filter(Boolean).join(';');
  const words = (list, flags = 'gi') => new RegExp(`\\b(?:${list.join('|')})\\b`, flags);
  const rule = (name, re, style, filter) => ({ name, re, style, filter });

  // ---------------------------------------------------------------- shared
  const ipv4 = rule('IPv4', /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?:\/\d{1,2})?\b/g, 'cyan');
  const ipv6 = rule('IPv6', /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:\/\d{1,3})?(?![\w:])/gi, 'cyan',
    (m) => /[0-9a-f]/i.test(m) && (/::/.test(m) || /[a-f]/i.test(m)));
  const mac = rule('MAC', /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b|\b[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}\b/gi, 'magenta');
  const isoDate = rule('Date', /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, 'gray');
  const sysDate = rule('Syslog time', /\*?\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d{4}\s+)?\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, 'gray');

  // ----------------------------------------------------------------- Cisco
  const syslog = {
    name: 'Syslog mnemonic',
    re: /%[A-Z][A-Z0-9_]*(?:-[A-Z0-9_]+)?-[0-7]-[A-Z0-9_]+/g,
    style: (m) => {
      const sev = Number((m.match(/-([0-7])-[A-Z0-9_]+$/) || [])[1]);
      if (sev <= 3) return 'bold red';
      if (sev === 4) return 'bold yellow';
      return 'bold cyan';
    },
  };
  const ciscoErrors = rule('CLI error', /^\s*%\s?(?:Invalid input|Incomplete command|Ambiguous command|Unknown command|Unrecognized command|Bad (?:mask|IP address)|Cannot|Error|Unable|Permission denied|Authorization failed)[^\r\n]*/gim, 'bold red');
  const caret = rule('Error caret', /^\s+\^\s*$/gm, 'bold red');
  const more = rule('More prompt', /\s?--More--\s?|<--- More --->|-- ?More ?--/g, 'inverse');
  const description = rule('Description', /(?<=(?:^|[#>])\s*(?:description|alias|remark)\s).*$/gm, 'italic gray');
  const comment = rule('Config comment', /^!.*$/gm, 'gray');
  const zeroCounters = rule('Zero counters', /\b0 (?:input |output )?(?:errors|CRC|frame|overrun|ignored|collisions|runts|giants|throttles|underruns|drops|interface resets|late collision|deferred|lost carrier|no carrier|output buffer failures|babbles|watchdog)\b/gi, 'gray');
  const prompt = rule('Prompt', /^[A-Za-z0-9][\w.\-]*(?:\([\w\-\/.:]+\))?[#>](?=\s|$)/gm, 'bold');
  const noKeyword = rule('"no" command', /(?<=(?:^|[#>])\s*)no(?= \w)/gm, 'bold red');
  const section = rule('Config section', /(?<=(?:^|[#>]) ?)(?:interface|router|vlan|line|hostname|ip vrf|vrf definition|vrf context|vrf|policy-map|class-map|route-map|ip access-list|ipv6 access-list|access-list|object-group|crypto|aaa|spanning-tree|username|banner|control-plane|track|key chain|monitor session|snmp-server|ntp|logging|feature|port-profile|vpc domain|role|zone|boot|license|version|end|address-family|ip prefix-list|ip route|ipv6 route|evpn|nv overlay|system|service|archive|redundancy)(?= |$)/gm, 'bold magenta');
  const routeCodes = rule('Route code', /^(?:L|C|S\*?|O(?: IA| E[12]| N[12])?|B|D(?: EX)?|R|i(?: L[12]| su| ia)?|\*>|\* ?i|r>|s>)(?=\s+\d)/gm, 'bold yellow');
  const ifaceLong = rule('Interface', /\b(?:GigabitEthernet|FastEthernet|TenGigabitEthernet|TwentyFiveGigE|TwentyFiveGigabitEthernet|FortyGigabitEthernet|HundredGigE|HundredGigabitEthernet|FourHundredGigE|AppGigabitEthernet|Ethernet|Port-channel|port-channel|Vlan|vlan|Loopback|loopback|Tunnel|tunnel|Serial|Dialer|Virtual-Access|Virtual-Template|BDI|nve|NVE|mgmt|Management|BVI|Null|Async|Multilink|Cellular|Embedded-Service-Engine|Wlan-GigabitEthernet)\s?\d+(?:\/\d+){0,3}(?:[.:]\d+)?\b/g, 'blue');
  const ifaceShort = rule('Interface (short)', /\b(?:Gi|Fa|Te|Tw|Twe|Fo|Hu|Eth|Et|Po|Lo|Vl|Tu|Se|Mg|Nv|BD|mgmt)\d+(?:\/\d+){0,3}(?:[.:]\d+)?\b/g, 'blue');
  const protocols = rule('Protocol', words(['vPC', 'peer-link', 'peer-keepalive', 'peer-gateway', 'HSRP', 'VRRP', 'GLBP', 'OSPF', 'OSPFv3', 'EIGRP', 'BGP', 'ISIS', 'IS-IS', 'LACP', 'PAgP', 'LLDP', 'CDP', 'STP', 'RSTP', 'MST', 'PVST', 'Rapid-PVST', 'UDLD', 'VXLAN', 'EVPN', 'VNI', 'MPLS', 'LDP', 'BFD', 'NAT', 'VRF', 'DHCP', 'SNMP', 'NTP', 'TACACS\\+?', 'RADIUS', 'SSH', 'IPsec', 'GRE', 'PIM', 'IGMP', 'FEX', 'VDC']), 'brightCyan');
  const netBad = rule('Bad state', words(['administratively down', 'err-disabled', 'errdisable', 'notconnect', 'notconnec', 'disabled', 'down', 'failed', 'failure', 'fail', 'error', 'errors', 'denied', 'deny', 'drops', 'dropped', 'rejected', 'reject', 'unreachable', 'timed out', 'timeout', 'shutdown', 'suspended', 'inactive', 'invalid', 'mismatch', 'blocking', 'BLK', 'BKN', 'loop-inconsistent', 'type-inconsistent', 'flapping', 'CRC', 'giants', 'runts', 'collisions', 'inconsistent']), 'red');
  const bgpBad = rule('BGP state', /\b(?:Idle(?: \(Admin\)| \(PfxCt\))?|Active|Connect|OpenSent|OpenConfirm)\s*$/gm, 'red');
  const netWarn = rule('Warn state', words(['warning', 'warn', 'standby', 'init', 'initializing', 'learning', 'LRN', 'LIS', 'listening', 'half', 'auto', 'backup', 'secondary', 'monitoring', 'pending', 'degraded', 'dormant', 'testing', 'unknown', 'notice', 'alternate', 'altn', 'speak', 'listen']), 'yellow');
  const netGood = rule('Good state', words(['up', 'connected', 'established', 'estab', 'full', 'forwarding', 'FWD', 'permit', 'permitted', 'enabled', 'active', 'running', 'ok', 'success', 'successful', 'reachable', 'master', 'primary', 'designated', 'desg', 'root', 'valid', 'synchronized', 'in sync', 'peer-adjacency formed ok', 'consistent', 'operational', 'online']), 'green');

  // NX-OS specific interface states (show interface status / brief)
  const nxBad = rule('NX-OS bad state', /\b(?:sfpAbsent|xcvrAbsen|xcvrAbsent|noOperMem|noOperMembers|linkFlapE|linkFlapErrDisabled|suspnd|suspended|sfpInvali|sfpInvalid|udldErrDis|errDisabled|channelErrDisabled|adminDown|linkNotConnected|Link not connected|Administratively down|XCVR not inserted|SFP not inserted|vPC peer-link is down|peer is not reachable|not reachable)\b/g, 'red');
  const nxGood = rule('NX-OS good state', /\b(?:peer adjacency formed ok|peer is alive|success|primary, operational secondary|operational)\b/gi, 'green');

  // ----------------------------------------------------------------- Linux
  const systemdOk = rule('[ OK ]', /\[\s*OK\s*\]/g, 'bold green');
  const systemdFail = rule('[FAILED]', /\[\s*(?:FAILED|FAIL|ERROR|DEPEND)\s*\]/gi, 'bold red');
  const systemdWarn = rule('[WARN]', /\[\s*(?:WARN|WARNING|\*\*\*|TIME)\s*\]/gi, 'bold yellow');
  const percent = {
    name: 'Usage %',
    re: /\b\d{1,3}(?:\.\d+)?%/g,
    style: (m) => {
      const v = parseFloat(m);
      if (v >= 90) return 'bold red';
      if (v >= 75) return 'yellow';
      return '';
    },
  };
  const userHost = rule('user@host', /\b[a-z_][\w-]*@[\w][\w.-]*(?=[:\s]|$)/gim, 'bold green');
  const linuxBad = rule('Linux error', words(['error', 'errors', 'err', 'failed', 'failure', 'fail', 'fatal', 'critical', 'crit', 'emerg', 'alert', 'panic', 'denied', 'refused', 'killed', 'segfault', 'segmentation fault', 'core dumped', 'timeout', 'timed out', 'unreachable', 'not found', 'no such file or directory', 'command not found', 'cannot', "can't", 'unable', 'invalid', 'corrupted', 'corrupt', 'dead', 'inactive', 'masked', 'oom', 'out of memory', 'exception', 'traceback', 'down', 'offline', 'unhealthy', 'rejected', 'forbidden', 'unauthorized']), 'red');
  const linuxWarn = rule('Linux warning', words(['warn', 'warning', 'deprecated', 'degraded', 'notice', 'retry', 'retrying', 'pending', 'activating', 'deactivating', 'reloading', 'skipped', 'skipping', 'unknown', 'waiting', 'restarting']), 'yellow');
  const linuxGood = rule('Linux ok', words(['ok', 'success', 'successful', 'successfully', 'done', 'passed', 'pass', 'active', 'running', 'started', 'enabled', 'loaded', 'listening', 'listen', 'connected', 'established', 'up', 'online', 'healthy', 'ready', 'completed', 'complete', 'accepted', 'installed', 'exited']), 'green');

  const ciscoCommon = [syslog, ciscoErrors, caret, more, description, comment, zeroCounters, sysDate, isoDate, prompt, noKeyword, section, routeCodes, mac, ipv4, ipv6, ifaceLong, ifaceShort, protocols];
  const PROFILES = {
    'cisco-ios': { name: 'Cisco IOS / IOS-XE (Catalyst)', rules: [...ciscoCommon, bgpBad, netBad, netWarn, netGood] },
    'cisco-nxos': { name: 'Cisco NX-OS (Nexus)', rules: [...ciscoCommon, nxBad, nxGood, bgpBad, netBad, netWarn, netGood] },
    linux: { name: 'Linux', rules: [systemdOk, systemdFail, systemdWarn, sysDate, isoDate, percent, mac, ipv4, ipv6, userHost, linuxBad, linuxWarn, linuxGood] },
    auto: { name: 'Auto (Cisco + Linux)', rules: [systemdOk, systemdFail, systemdWarn, ...ciscoCommon, percent, nxBad, nxGood, bgpBad, netBad, linuxBad, netWarn, linuxWarn, netGood, linuxGood] },
    none: { name: 'None', rules: [] },
  };

  function compileCustom(list) {
    const out = [];
    for (const r of list || []) {
      if (!r || !r.pattern || r.enabled === false) continue;
      try {
        const flags = `${(r.flags || 'i').replace(/[^imsu]/g, '')}g`;
        out.push(rule(r.name || 'Custom', new RegExp(r.pattern, flags.includes('m') ? flags : `${flags}m`), r.style || 'yellow'));
      } catch { /* invalid regex - skip */ }
    }
    return out;
  }

  // Paint spans on a plain text run.
  function colorize(text, rules) {
    if (!text || !rules.length || !/[\w%\[*<-]/.test(text)) return text;
    const taken = new Uint8Array(text.length);
    const spans = [];
    for (const r of rules) {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(text))) {
        const s = m[0];
        if (!s) { r.re.lastIndex++; continue; }
        const start = m.index;
        const end = start + s.length;
        if (r.filter && !r.filter(s)) continue;
        let free = true;
        for (let i = start; i < end; i++) if (taken[i]) { free = false; break; }
        if (!free) continue;
        const style = typeof r.style === 'function' ? r.style(s) : r.style;
        const c = style ? codes(style) : '';
        for (let i = start; i < end; i++) taken[i] = 1;
        if (c) spans.push([start, end, c]);
      }
    }
    if (!spans.length) return text;
    spans.sort((a, b) => a[0] - b[0]);
    let out = '';
    let pos = 0;
    for (const [s, e, c] of spans) {
      out += text.slice(pos, s) + `\x1b[${c}m` + text.slice(s, e) + '\x1b[0m';
      pos = e;
    }
    return out + text.slice(pos);
  }

  // Matches complete escape sequences (CSI, OSC, DCS/APC/PM, charset, single-char).
  const ESC_RE = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[()*+\-.\/][ -~]|[ -~])/g;

  class Highlighter {
    constructor(profile, customRules) {
      this.sgrActive = false;
      this.altScreen = false;
      this.pending = '';
      this.timer = null;
      this.setProfile(profile, customRules);
    }

    setProfile(profile, customRules) {
      this.profile = PROFILES[profile] ? profile : 'auto';
      this.rules = [...compileCustom(customRules), ...PROFILES[this.profile].rules];
    }

    trackEscape(seq) {
      if (seq.endsWith('m') && seq[1] === '[') {
        const p = seq.slice(2, -1);
        this.sgrActive = !/^(?:0|00|39|49|22|23|24|27|;)*$/.test(p);
      } else if (/^\x1b\[\?(?:1049|1047|47)[hl]$/.test(seq)) {
        this.altScreen = seq.endsWith('h');
        this.sgrActive = false;
      }
    }

    // Process one chunk. `flush(text)` receives output that is ready; a
    // trailing partial word/escape may be held back briefly.
    process(data, flush) {
      clearTimeout(this.timer);
      let input = this.pending + data;
      this.pending = '';

      // Hold back an unterminated escape sequence at the end.
      const lastEsc = input.lastIndexOf('\x1b');
      if (lastEsc !== -1 && input.length - lastEsc < 256) {
        ESC_RE.lastIndex = lastEsc;
        const m = ESC_RE.exec(input);
        if (!m || m.index !== lastEsc) {
          this.pending = input.slice(lastEsc);
          input = input.slice(0, lastEsc);
        }
      }
      // Bulk output: hold back a trailing partial token so words split across
      // packets still get matched. Small chunks (typing echo) are never delayed.
      if (!this.pending && data.length > 64 && !this.altScreen) {
        const m = /[\w.:%\/-]{1,64}$/.exec(input);
        if (m && m.index > 0) {
          this.pending = input.slice(m.index);
          input = input.slice(0, m.index);
        }
      }

      let out = '';
      let pos = 0;
      ESC_RE.lastIndex = 0;
      let m;
      while ((m = ESC_RE.exec(input))) {
        out += this.paint(input.slice(pos, m.index));
        out += m[0];
        this.trackEscape(m[0]);
        pos = m.index + m[0].length;
      }
      out += this.paint(input.slice(pos));
      if (out) flush(out);
      if (this.pending) {
        this.timer = setTimeout(() => {
          const p = this.pending;
          this.pending = '';
          flush(p.startsWith('\x1b') ? p : this.paint(p));
        }, 30);
      }
    }

    paint(text) {
      if (!text || this.sgrActive || this.altScreen) return text;
      return colorize(text, this.rules);
    }
  }

  window.VyttyHighlight = {
    Highlighter,
    PROFILES: Object.fromEntries(Object.entries(PROFILES).map(([k, v]) => [k, v.name])),
    STYLES: Object.keys(SGR),
    colorize: (text, profile, custom) => colorize(text, [...compileCustom(custom), ...(PROFILES[profile] || PROFILES.auto).rules]),
  };
})();
