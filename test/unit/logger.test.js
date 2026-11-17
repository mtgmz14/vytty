'use strict';
const { dataDir } = require('./_setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const logger = require('../../src/main/logger');

const day = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

test('one log file per device and day, named after the prompt; escapes cleaned', () => {
  const dir = path.join(dataDir, 'logs-test');
  logger.configure({ enabled: true, dir, timestamps: false, sessionTag: true });
  const log = new logger.SessionLog('core', 'ssh admin@10.0.0.1:22', true, '10.0.0.1');
  log.write('Banner line\r\n\x1b[1mSW-CORE-01#\x1b[0mshow ver\r\nCisco IOS\r\nSW-CORE-01#');
  log.write('ab\bc\r\n');
  log.close('Closed by user');
  const file = path.join(dir, `SW-CORE-01#${day()}.log`);
  assert.ok(fs.existsSync(file), fs.readdirSync(dir).join(','));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /OPEN {2}"core" \(ssh admin@10\.0\.0\.1:22\)/);
  assert.match(text, /\[core\] Banner line/);
  assert.match(text, /\[core\] SW-CORE-01#show ver/);
  assert.match(text, /\[core\] SW-CORE-01#ac\n/);
  assert.match(text, /CLOSE "core" \(Closed by user\)/);
  assert.ok(!/\x1b/.test(text), 'no escape codes in the log');
});

test('fallback to the session host when no prompt shows up; hostile names are sanitised', () => {
  const dir = path.join(dataDir, 'logs-test2');
  logger.configure({ enabled: true, dir, timestamps: true, sessionTag: false });
  const log = new logger.SessionLog('x', 'telnet', true, '../../etc/passwd');
  log.write('no prompt here\r\n');
  log.close();
  const files = fs.readdirSync(dir);
  assert.strictEqual(files.length, 1);
  assert.ok(!files[0].includes('/') && !files[0].includes('\\'));
  assert.match(fs.readFileSync(path.join(dir, files[0]), 'utf8'), /\[\d\d:\d\d:\d\d\] no prompt here/);
});
