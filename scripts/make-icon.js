// Renders build/icon.svg to build/icon.png (512x512) and build/icon.ico
// (16-256 px, PNG-compressed entries) using Electron. Run: npm run icon
// (add --ozone-platform=headless on a machine without a display).
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const BUILD = path.join(__dirname, '..', 'build');
const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// Draw the SVG on a canvas inside a page and read the PNG back: keeps the
// transparency and works without a display (capturePage of a transparent,
// off-screen window comes back empty there).
let page = null;
async function render(size) {
  if (!page) {
    page = new BrowserWindow({ width: 300, height: 300, show: false });
    await page.loadURL('data:text/html,<html><body></body></html>');
  }
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const dataUrl = await page.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = ${size};
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, ${size}, ${size});
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('SVG did not load'));
    img.src = ${JSON.stringify(src)};
  })`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

// ICO container with PNG payloads (supported since Windows Vista).
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(([size, png], i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...pngs.map(([, png]) => png)]);
}

app.whenReady().then(async () => {
  fs.writeFileSync(path.join(BUILD, 'icon.png'), await render(512));
  const pngs = [];
  for (const s of ICO_SIZES) pngs.push([s, await render(s)]);
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico(pngs));
  console.log('build/icon.png and build/icon.ico written');
  app.quit();
});
