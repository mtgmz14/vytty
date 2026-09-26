// Renders build/icon.svg to build/icon.png (512x512) using Electron. Run: npm run icon
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const SIZE = 512;
const svg = fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.svg'), 'utf8');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg', `<svg width="${SIZE}" height="${SIZE}"`)}</body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), img.resize({ width: SIZE, height: SIZE }).toPNG());
  console.log('build/icon.png written');
  app.quit();
});
