import { icon } from './icons.ts';

// Kleine DOM-Hilfen für die Editor-Oberfläche (ohne Framework).

type Attrs = Record<string, string | number | boolean | ((e: never) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function iconEl(name: string, cls = 'icon'): HTMLSpanElement {
  return h('span', { class: cls, html: icon(name) });
}

export function fmt(v: number): string {
  if (!isFinite(v)) return '0';
  return String(Math.round(v * 1000) / 1000);
}

export interface NumberFieldOpts {
  value: number;
  step?: number;
  min?: number;
  max?: number;
  axis?: 'x' | 'y' | 'z';
  /** live = während des Ziehens (noch nicht in die Historie) */
  onChange(v: number, live: boolean): void;
}

/** Zahlenfeld wie in UE5: Ziehen (links/rechts) ändert den Wert, Klick zum Tippen */
export function numberField(o: NumberFieldOpts): HTMLDivElement {
  const step = o.step ?? 0.1;
  const clamp = (v: number) => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v));
  const input = h('input', { type: 'text', value: fmt(o.value), spellcheck: 'false' });
  const wrap = h('div', { class: 'num' });
  if (o.axis) wrap.append(h('div', { class: `axis ${o.axis}` }));
  wrap.append(input);
  let value = o.value;
  let dragging = false;
  let moved = 0;
  let startX = 0;
  let startVal = 0;

  const commit = () => {
    const parsed = evalNumber(input.value);
    if (parsed === null) {
      input.value = fmt(value);
      return;
    }
    value = clamp(parsed);
    input.value = fmt(value);
    o.onChange(value, false);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      commit();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = fmt(value);
      input.blur();
    }
  });
  input.addEventListener('blur', () => {
    if (evalNumber(input.value) !== value) commit();
  });
  input.addEventListener('pointerdown', (e) => {
    if (document.activeElement === input) return;
    e.preventDefault();
    dragging = true;
    moved = 0;
    startX = e.clientX;
    startVal = value;
    input.setPointerCapture(e.pointerId);
  });
  input.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    if (moved < 3) return;
    const mul = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    value = clamp(Math.round((startVal + dx * step * 0.5 * mul) / (step * 0.01)) * (step * 0.01));
    input.value = fmt(value);
    o.onChange(value, true);
  });
  input.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    if (moved < 3) {
      input.focus();
      input.select();
    } else {
      o.onChange(value, false);
    }
  });
  return wrap;
}

/** Erlaubt einfache Rechnungen wie "2*1.5" oder "3+0.25" im Zahlenfeld */
function evalNumber(s: string): number | null {
  const t = s.replace(',', '.').trim();
  if (!/^[-+*/().\d\s]+$/.test(t)) return null;
  try {
    const v = Function(`"use strict";return (${t});`)() as unknown;
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export interface MenuItem {
  label?: string;
  key?: string;
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  heading?: string;
  action?: () => void;
}

let openMenu: { el: HTMLElement; close: () => void } | null = null;

export function closeMenus(): void {
  openMenu?.close();
  openMenu = null;
}

/** Dropdown-Menü an einem Element oder einer Position */
export function showMenu(items: MenuItem[], anchor: HTMLElement | { x: number; y: number }, onClose?: () => void): void {
  closeMenus();
  const el = h('div', { class: 'dropdown' });
  for (const it of items) {
    if (it.separator) el.append(h('div', { class: 'sep' }));
    else if (it.heading) el.append(h('div', { class: 'heading' }, it.heading));
    else {
      const row = h(
        'div',
        { class: `item${it.disabled ? ' disabled' : ''}` },
        h('span', { class: 'check' }, it.checked ? '✓' : ''),
        it.icon ? h('span', { html: icon(it.icon), style: 'display:flex;width:14px;height:14px' }) : '',
        it.label ?? '',
        it.key ? h('span', { class: 'key' }, it.key) : '',
      );
      row.addEventListener('click', () => {
        closeMenus();
        it.action?.();
      });
      el.append(row);
    }
  }
  document.body.append(el);
  let x: number;
  let y: number;
  if (anchor instanceof HTMLElement) {
    const r = anchor.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 1;
  } else {
    x = anchor.x;
    y = anchor.y;
  }
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  el.style.left = `${Math.min(x, window.innerWidth - w - 4)}px`;
  el.style.top = `${Math.min(y, window.innerHeight - ht - 4)}px`;
  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !(anchor instanceof HTMLElement && anchor.contains(e.target as Node))) closeMenus();
  };
  setTimeout(() => window.addEventListener('pointerdown', onDown, true));
  openMenu = {
    el,
    close: () => {
      el.remove();
      window.removeEventListener('pointerdown', onDown, true);
      onClose?.();
    },
  };
}

export function isMenuOpen(): boolean {
  return openMenu !== null;
}

// ---------- Dialoge ----------

export function dialog(title: string, body: HTMLElement | string, actions: { label: string; primary?: boolean; danger?: boolean; action?: () => boolean | void }[]): () => void {
  const back = h('div', { class: 'modal-back' });
  const close = () => {
    back.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      const primary = actions.find((a) => a.primary);
      if (primary) {
        e.preventDefault();
        e.stopPropagation();
        // Zahlenfelder übernehmen ihren Wert beim Verlassen — vor der Aktion, sonst gilt der alte Wert
        (document.activeElement as HTMLElement | null)?.blur?.();
        if (primary.action?.() !== false) close();
      }
    }
    e.stopPropagation();
  };
  const bodyEl = typeof body === 'string' ? h('div', { html: body }) : body;
  back.append(
    h(
      'div',
      { class: 'dialog' },
      h('div', { class: 'dialog-title' }, title),
      h('div', { class: 'dialog-body' }, bodyEl),
      h(
        'div',
        { class: 'dialog-actions' },
        ...actions.map((a) => {
          const b = h('button', { class: `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}` }, a.label);
          b.addEventListener('click', () => {
            if (a.action?.() !== false) close();
          });
          return b;
        }),
      ),
    ),
  );
  back.addEventListener('pointerdown', (e) => {
    if (e.target === back) close();
  });
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  (back.querySelector('input') as HTMLInputElement | null)?.focus();
  return close;
}

export function promptText(title: string, label: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, spellcheck: 'false' });
    let result: string | null = null;
    const body = h('div', {}, h('div', { style: 'margin-bottom:6px' }, label), input);
    const close = dialog(title, body, [
      { label: 'Abbrechen' },
      {
        label: 'OK',
        primary: true,
        action: () => {
          const v = input.value.trim();
          if (!v) return false;
          result = v;
        },
      },
    ]);
    setTimeout(() => input.select());
    const obs = new MutationObserver(() => {
      if (!input.isConnected) {
        obs.disconnect();
        resolve(result);
      }
    });
    obs.observe(document.body, { childList: true });
    void close;
  });
}

export function confirmDialog(title: string, text: string, ok = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const body = h('div', {}, text);
    dialog(title, body, [{ label: 'Abbrechen' }, { label: ok, primary: !danger, danger, action: () => void (result = true) }]);
    const obs = new MutationObserver(() => {
      if (!body.isConnected) {
        obs.disconnect();
        resolve(result);
      }
    });
    obs.observe(document.body, { childList: true });
  });
}

const toastBox = h('div', { class: 'toasts' });
export function toast(text: string, kind: 'info' | 'ok' | 'error' = 'info', ms = 2600): void {
  if (!toastBox.isConnected) document.body.append(toastBox);
  const t = h('div', { class: `toast ${kind === 'info' ? '' : kind}` }, text);
  toastBox.append(t);
  setTimeout(() => t.remove(), ms);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.click();
  });
}

/** mehrere Dateien wählen (leer = abgebrochen) */
export function pickFiles(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple: '' });
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.click();
  });
}

/** Ziehbare Trennlinien zwischen Panels */
export function initSplitters(): void {
  for (const s of document.querySelectorAll<HTMLElement>('.splitter')) {
    const vertical = s.classList.contains('vertical');
    s.addEventListener('pointerdown', (e) => {
      const target = s.dataset.split === 'right' ? s.nextElementSibling : s.dataset.split === 'content' ? s.nextElementSibling : s.previousElementSibling;
      if (!(target instanceof HTMLElement)) return;
      e.preventDefault();
      s.setPointerCapture(e.pointerId);
      s.classList.add('dragging');
      const start = vertical ? e.clientX : e.clientY;
      const size = vertical ? target.offsetWidth : target.offsetHeight;
      // Panels rechts/unten wachsen beim Ziehen in Richtung Mitte
      const sign = s.dataset.split === 'details' ? 1 : -1;
      const move = (ev: PointerEvent) => {
        const d = (vertical ? ev.clientX : ev.clientY) - start;
        const v = Math.max(100, size + d * sign);
        if (vertical) target.style.width = `${v}px`;
        else target.style.height = `${v}px`;
        window.dispatchEvent(new Event('resize'));
      };
      const up = () => {
        s.classList.remove('dragging');
        s.removeEventListener('pointermove', move);
        s.removeEventListener('pointerup', up);
      };
      s.addEventListener('pointermove', move);
      s.addEventListener('pointerup', up);
    });
  }
}
