'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = { window: {}, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'highlight.js'), 'utf8'), ctx);
const H = ctx.window.VyttyHighlight;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('Cisco output is coloured without changing the text', () => {
  const line = 'GigabitEthernet1/0/2   unassigned      YES unset  administratively down down\r\n%LINK-3-UPDOWN: Interface Gi1/0/7, changed state to up';
  const out = H.colorize(line, 'cisco-ios', []);
  assert.strictEqual(strip(out), line);
  assert.match(out, /\x1b\[34mGigabitEthernet1\/0\/2\x1b\[0m/);
  assert.match(out, /\x1b\[31madministratively down\x1b\[0m/);
  assert.match(out, /\x1b\[1;31m%LINK-3-UPDOWN\x1b\[0m/);
  assert.match(out, /\x1b\[32mup\x1b\[0m/);
});

test('remote colours, full-screen apps and split packets are respected', async () => {
  const hl = new H.Highlighter('auto', []);
  const got = [];
  hl.process('\x1b[31malready red down\x1b[0m plain down\r\n', (t) => got.push(t));
  const joined = got.join('');
  assert.ok(joined.startsWith('\x1b[31malready red down\x1b[0m'), 'remote SGR untouched');
  assert.match(joined, /plain \x1b\[31mdown/);
  got.length = 0;
  hl.process('\x1b[?1049hvim down\x1b[?1049l', (t) => got.push(t));
  assert.ok(got.join('').includes('vim down'), 'alternate screen is not painted');
  got.length = 0;
  const long = `${'x '.repeat(40)}Gigabit`;
  hl.process(long, (t) => got.push(t));
  hl.process('Ethernet1/0/1 up\r\n', (t) => got.push(t));
  await new Promise((r) => setTimeout(r, 50));
  assert.match(got.join(''), /\x1b\[34mGigabitEthernet1\/0\/1\x1b\[0m/, 'a word split across packets is still matched');
});

test('custom rules run first and bad regexes are ignored', () => {
  const out = H.colorize('VLAN100 is up', 'none', [{ pattern: 'VLAN\\d+', style: 'bold magenta' }, { pattern: '(', style: 'red' }]);
  assert.match(out, /\x1b\[1;35mVLAN100\x1b\[0m/);
});
