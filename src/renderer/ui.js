'use strict';
// Small DOM toolkit: element builder, icons, modals, context menus, toasts.
(() => {
  const P = (d) => `<path d="${d}"/>`;
  const ICONS = {
    plus: P('M12 5v14M5 12h14'),
    folder: P('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'),
    folderOpen: P('M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1H7.5a2 2 0 0 0-1.9 1.4L3 19zM3 19l2.6-7.6A2 2 0 0 1 7.5 10H21l-2.7 7.6a2 2 0 0 1-1.9 1.4H3z'),
    folderPlus: P('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6'),
    terminal: P('M4 17l6-5-6-5M12 19h8'),
    server: P('M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01'),
    plug: P('M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5'),
    cable: P('M4 9h4v6H4zM16 9h4v6h-4zM8 12h8M6 9V5M18 15v4'),
    settings: P('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z') + P('M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'),
    palette: P('M12 3a9 9 0 1 0 0 18c1 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-7.9-9-7.9z') + P('M7.5 10.5h.01M10.5 7h.01M15 7.5h.01M17 11h.01'),
    broadcast: P('M4.9 19.1a10 10 0 0 1 0-14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M19.1 4.9a10 10 0 0 1 0 14.2') + '<circle cx="12" cy="12" r="2"/>',
    file: P('M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6'),
    fileText: P('M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5'),
    link: P('M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'),
    upload: P('M12 16V4M6 10l6-6 6 6M4 20h16'),
    download: P('M12 4v12M6 10l6 6 6-6M4 20h16'),
    refresh: P('M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7'),
    up: P('M12 19V5M5 12l7-7 7 7'),
    home: P('M3 11l9-8 9 8M5 9.5V21h14V9.5'),
    x: P('M18 6L6 18M6 6l12 12'),
    min: P('M5 12h14'),
    max: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
    restore: '<rect x="8" y="8" width="12" height="12" rx="1"/>' + P('M4 16V5a1 1 0 0 1 1-1h11'),
    search: '<circle cx="11" cy="11" r="7"/>' + P('M20 20l-3.5-3.5'),
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/>' + P('M8 11V7a4 4 0 0 1 8 0v4'),
    unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/>' + P('M8 11V7a4 4 0 0 1 7.5-2'),
    zap: P('M13 2L4 14h7l-1 8 9-12h-7z'),
    code: P('M8 6l-6 6 6 6M16 6l6 6-6 6'),
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/>' + P('M9 4v16'),
    edit: P('M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z'),
    trash: P('M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14'),
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/>' + P('M5 15V5a2 2 0 0 1 2-2h10'),
    chevron: P('M9 6l6 6-6 6'),
    chevronDown: P('M6 9l6 6 6-6'),
    dot: '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
    key: '<circle cx="8" cy="15" r="4"/>' + P('M10.8 12.2L20 3M16 7l3 3M14 9l2 2'),
    play: P('M6 4l14 8-14 8z'),
    logs: P('M4 4h16v16H4zM8 8h8M8 12h8M8 16h5'),
    more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
    info: '<circle cx="12" cy="12" r="9"/>' + P('M12 8h.01M11 12h1v5h1'),
  };

  const icon = (name, size = 16) => {
    const span = document.createElement('span');
    span.className = 'icon';
    span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
    return span;
  };

  // el('div.cls#id', {attrs, on: {click}}, ...children)
  function el(tag, props, ...children) {
    const [, name = 'div', rest = ''] = /^([a-z0-9-]*)(.*)$/i.exec(tag);
    const node = document.createElement(name || 'div');
    for (const part of rest.match(/[.#][^.#]+/g) || []) {
      if (part[0] === '.') node.classList.add(part.slice(1)); else node.id = part.slice(1);
    }
    if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
      children.unshift(props);
      props = null;
    }
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k in node && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    const add = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    children.forEach(add);
    return node;
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ------------------------------------------------------------- modals
  const modalStack = [];

  function modal({ title, body, buttons = [], width = 460, onClose, className = '' }) {
    const overlay = document.getElementById('overlay');
    closeMenu();
    return new Promise((resolve) => {
      let done = false;
      const close = (value) => {
        if (done) return;
        done = true;
        box.remove();
        modalStack.splice(modalStack.indexOf(box), 1);
        overlay.classList.toggle('show', modalStack.length > 0);
        if (onClose) onClose(value);
        resolve(value);
        const top = modalStack[modalStack.length - 1];
        if (!top) window.dispatchEvent(new Event('vytty:modal-closed'));
      };
      const footer = el('div.modal-footer');
      for (const b of buttons) {
        const btn = el(`button.btn${b.primary ? '.primary' : ''}${b.danger ? '.danger' : ''}`, { type: 'button', text: b.label });
        if (b.left) btn.classList.add('left');
        btn.addEventListener('click', async () => {
          const v = b.value !== undefined ? b.value : b.label;
          if (b.validate) {
            const ok = await b.validate();
            if (!ok) return;
          }
          close(typeof b.result === 'function' ? b.result() : v);
        });
        footer.append(btn);
      }
      const box = el(`div.modal${className ? `.${className}` : ''}`, { style: { width: typeof width === 'number' ? `${width}px` : width } },
        el('div.modal-head', el('h2', { text: title }), el('button.icon-btn', { type: 'button', title: 'Close', on: { click: () => close(null) } }, icon('x'))),
        el('div.modal-body', body),
        buttons.length ? footer : null);
      box._close = close;
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
          const primary = footer.querySelector('.btn.primary');
          if (primary) { e.preventDefault(); primary.click(); }
        }
      });
      modalStack.push(box);
      overlay.append(box);
      overlay.classList.add('show');
      requestAnimationFrame(() => {
        const f = box.querySelector('[autofocus]') || box.querySelector('input:not([type=checkbox]):not([disabled]), select, textarea') || footer.querySelector('.btn.primary');
        if (f) f.focus();
      });
    });
  }

  const hasModal = () => modalStack.length > 0;
  // Escape closes the top-most dialog wherever the focus is.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !modalStack.length || menuEl) return;
    e.preventDefault();
    e.stopPropagation();
    modalStack[modalStack.length - 1]._close(null);
  });

  function confirmBox(title, message, { okLabel = 'OK', danger = false, cancelLabel = 'Cancel' } = {}) {
    return modal({
      title,
      body: el('p.pre', { text: message }),
      buttons: [{ label: cancelLabel, value: false }, { label: okLabel, value: true, primary: !danger, danger }],
    }).then((v) => v === true);
  }

  function inputBox(title, label, { value = '', password = false, placeholder = '', okLabel = 'OK', checkbox } = {}) {
    const input = el('input.input', { type: password ? 'password' : 'text', value, placeholder, autofocus: true, spellcheck: false });
    const cb = checkbox ? el('input', { type: 'checkbox', checked: !!checkbox.checked }) : null;
    return modal({
      title,
      body: [el('label.field', el('span', { text: label }), input), cb ? el('label.check', cb, el('span', { text: checkbox.label })) : null],
      buttons: [{ label: 'Cancel', value: null }, { label: okLabel, primary: true, result: () => ({ value: input.value, checked: cb ? cb.checked : false }) }],
    });
  }

  // ------------------------------------------------------- context menu
  let menuEl = null;
  function closeMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
  }
  function contextMenu(x, y, items) {
    closeMenu();
    const build = (list) => {
      const m = el('div.menu');
      for (const it of list) {
        if (!it) continue;
        if (it === '-') { m.append(el('div.menu-sep')); continue; }
        if (it.header) { m.append(el('div.menu-header', { text: it.header })); continue; }
        const row = el(`div.menu-item${it.disabled ? '.disabled' : ''}${it.danger ? '.danger' : ''}`,
          it.icon ? icon(it.icon, 14) : el('span.icon-spacer'),
          el('span.menu-label', { text: it.label }),
          it.checked ? el('span.menu-check', { text: '✓' }) : null,
          it.shortcut ? el('span.menu-shortcut', { text: it.shortcut }) : null,
          it.submenu ? icon('chevron', 12) : null);
        if (it.submenu) {
          const sub = build(it.submenu);
          sub.classList.add('submenu');
          row.append(sub);
          row.addEventListener('mouseenter', () => {
            const r = row.getBoundingClientRect();
            sub.style.left = `${r.width - 4}px`;
            sub.style.top = '-5px';
            requestAnimationFrame(() => {
              const sr = sub.getBoundingClientRect();
              if (sr.right > window.innerWidth) sub.style.left = `${-sr.width + 4}px`;
              if (sr.bottom > window.innerHeight) sub.style.top = `${window.innerHeight - sr.bottom - 8}px`;
            });
          });
        } else if (!it.disabled) {
          row.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.action && it.action(); });
        }
        m.append(row);
      }
      return m;
    };
    menuEl = build(items);
    menuEl.classList.add('root-menu');
    document.body.append(menuEl);
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
    menuEl.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
  }
  window.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); }, true);

  // --------------------------------------------------------------- toast
  function toast(message, kind = 'info', ms = 3200) {
    const t = el(`div.toast.${kind}`, { text: message });
    document.getElementById('toasts').append(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
  }

  // --------------------------------------------------------------- misc
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);
  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  const fmtSize = (n) => {
    if (n === undefined || n === null) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${i ? v.toFixed(v < 10 ? 1 : 0) : v} ${u[i]}`;
  };
  const fmtDate = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  window.UI = { el, $, $$, icon, modal, hasModal, confirmBox, inputBox, contextMenu, closeMenu, toast, uid, debounce, fmtSize, fmtDate };
})();
