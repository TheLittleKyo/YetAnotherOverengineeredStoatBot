/**
 * Interaction primitives shared by the feature editors, so every page answers
 * the same questions the same way:
 *
 * - Is my change live yet? A feature's on/off switch (`FeatureSwitch`) and list
 *   add/remove act at once; everything else is a draft until the floating
 *   `SaveBar` (Save / Discard) saves it. The bar only shows when there is
 *   something to save, reports that to the dashboard shell (which marks the
 *   tab and asks before throwing drafts away), and guards page unload.
 * - Is this on? `Switch` is a labelled role=switch, never a bare icon.
 * - Are you sure? `confirmDialog` / `promptDialog` replace the browser's
 *   native confirm() and prompt().
 * - `NumberInput` can be cleared while typing instead of snapping to 0.
 *
 * Styles live in `shared/tokens.css` (`.savebar`, `.dialog`, `.ui-switch`,
 * `.feature-*`).
 */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FiAlertTriangle, FiPower, FiRotateCcw, FiSave } from 'react-icons/fi';

const h = React.createElement;

// ---- Dashboard shell bridge ---------------------------------------------

/** Message the dashboard shell this editor is framed in (no-op standalone). */
export function postToShell(message: Record<string, unknown>) {
  try {
    if (window.parent !== window) window.parent.postMessage(message, location.origin);
  } catch { /* not embedded */ }
}

// Set when the shell has already asked the operator and is about to reload
// this frame, so the unload guard does not ask a second time.
let unloadConfirmed = false;
window.addEventListener('message', (e) => {
  if (e.origin === location.origin && e.data?.type === 'yaosb-discard') unloadConfirmed = true;
});

/**
 * Report unsaved changes to the shell and ask before the page unloads with
 * them. Several sections of one page may each call this; the shell is told
 * the page is dirty while any of them is.
 */
const dirtySources = new Set<symbol>();
export function useUnsavedChanges(dirty: boolean) {
  const key = useRef(Symbol('dirty'));
  useEffect(() => {
    if (dirty) dirtySources.add(key.current); else dirtySources.delete(key.current);
    postToShell({ type: 'yaosb-dirty', dirty: dirtySources.size > 0 });
    if (!dirty) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (unloadConfirmed) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  useEffect(() => () => {
    dirtySources.delete(key.current);
    postToShell({ type: 'yaosb-dirty', dirty: dirtySources.size > 0 });
  }, []);
}

// ---- Save bar --------------------------------------------------------------

type SaveBarProps = {
  dirty: boolean;
  busy?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  /** Overrides "You have unsaved changes". */
  message?: string;
};

/**
 * Floating bar pinned to the bottom of the page while there are unsaved
 * changes. Ctrl/Cmd+S saves. Renders a spacer so it never covers the last
 * field on the page.
 */
export function SaveBar({ dirty, busy, onSave, onDiscard, message }: SaveBarProps) {
  useUnsavedChanges(dirty);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  useEffect(() => {
    if (!dirty) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!busy) saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, busy]);

  return h(React.Fragment, null,
    h('div', { className: 'savebar-spacer', 'aria-hidden': true }),
    h('div', {
      className: `savebar${dirty ? ' is-visible' : ''}`,
      role: 'region',
      'aria-label': 'Unsaved changes',
      'aria-hidden': !dirty,
      // Keep the hidden bar out of the tab order.
      inert: !dirty,
    },
      h('span', { className: 'savebar-text' },
        h('span', { className: 'savebar-dot', 'aria-hidden': true }),
        message || 'You have unsaved changes'),
      h('div', { className: 'savebar-actions' },
        h('button', { type: 'button', className: 'btn btn-quiet', disabled: busy, onClick: onDiscard }, h(FiRotateCcw), 'Discard'),
        h('button', { type: 'button', className: 'btn btn-accent', disabled: busy, onClick: onSave }, h(FiSave), busy ? 'Saving…' : 'Save changes'))));
}

// ---- Switches ----------------------------------------------------------------

type SwitchProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name; required because the control has no visible text. */
  label: string;
  disabled?: boolean;
  id?: string;
};

export function Switch({ checked, onChange, label, disabled, id }: SwitchProps) {
  return h('button', {
    type: 'button',
    id,
    role: 'switch',
    'aria-checked': checked,
    'aria-label': label,
    title: label,
    disabled,
    className: `ui-switch${checked ? ' is-on' : ''}`,
    onClick: () => onChange(!checked),
  }, h('span', { className: 'ui-switch-knob', 'aria-hidden': true }));
}

type FeatureSwitchProps = {
  /** Feature name as shown in the page title, e.g. "Captcha". */
  feature: string;
  enabled: boolean;
  onChange: (next: boolean) => void;
  busy?: boolean;
};

/**
 * The page-level on/off control. Always takes effect immediately (unlike the
 * settings below it), and says so.
 */
export function FeatureSwitch({ feature, enabled, onChange, busy }: FeatureSwitchProps) {
  return h('div', { className: `feature-switch${enabled ? ' is-on' : ''}` },
    h('span', { className: 'feature-state' },
      h('span', { className: 'feature-dot', 'aria-hidden': true }),
      enabled ? 'On' : 'Off'),
    h(Switch, { checked: enabled, disabled: busy, onChange, label: `${enabled ? 'Turn off' : 'Turn on'} ${feature}` }));
}

/** Shown under the header while a feature is switched off. */
export function FeatureOffNotice({ feature, what, onEnable, busy }: { feature: string; what: string; onEnable: () => void; busy?: boolean }) {
  return h('div', { className: 'feature-off', role: 'status' },
    h(FiPower, { 'aria-hidden': true }),
    h('span', null, h('strong', null, `${feature} is off. `), `${what} Settings below are kept and apply as soon as you turn it on.`),
    h('button', { type: 'button', className: 'btn', disabled: busy, onClick: onEnable }, `Turn on`));
}

// ---- Number input ------------------------------------------------------------

type NumberInputProps = {
  value: number | null | undefined;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
};

/**
 * A number field that keeps what you type (including an empty box) until you
 * leave it, then settles on a valid number within min/max.
 */
export function NumberInput({ value, onChange, min, max, step, className = 'input', ...rest }: NumberInputProps) {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(value == null ? '' : String(value));
  }, [value]);

  function clamp(n: number) {
    let out = n;
    if (min != null && out < min) out = min;
    if (max != null && out > max) out = max;
    return out;
  }

  return h('input', {
    ...rest,
    type: 'number',
    inputMode: step && step % 1 !== 0 ? 'decimal' : 'numeric',
    className,
    min,
    max,
    step,
    value: draft,
    onFocus: () => { editing.current = true; },
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const text = e.target.value;
      setDraft(text);
      const n = Number(text);
      if (text.trim() !== '' && Number.isFinite(n)) onChange(n);
    },
    onBlur: () => {
      editing.current = false;
      const typed = Number(draft);
      const fallback = Number(value ?? min ?? 0);
      const settled = clamp(draft.trim() !== '' && Number.isFinite(typed) ? typed : fallback);
      if (settled !== value) onChange(settled);
      setDraft(String(settled));
    },
  });
}

// ---- Dialogs -----------------------------------------------------------------

type DialogOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: red confirm button, and Cancel gets the initial focus. */
  danger?: boolean;
  input?: { label: string; defaultValue?: string; type?: 'text' | 'number'; min?: number; max?: number; placeholder?: string };
};

type DialogResult = { ok: boolean; value: string };

let dialogRoot: Root | null = null;
let closeOpenDialog: ((result: DialogResult) => void) | null = null;

function showDialog(options: DialogOptions): Promise<DialogResult> {
  // A second dialog replaces the first, which counts as cancelled.
  closeOpenDialog?.({ ok: false, value: '' });
  return new Promise((resolve) => {
    if (!dialogRoot) {
      const host = document.createElement('div');
      document.body.appendChild(host);
      dialogRoot = createRoot(host);
    }
    const opener = document.activeElement as HTMLElement | null;
    const close = (result: DialogResult) => {
      if (closeOpenDialog !== close) return;
      closeOpenDialog = null;
      dialogRoot?.render(null);
      postToShell({ type: 'yaosb-modal', open: false });
      window.removeEventListener('message', onShellMessage);
      opener?.focus?.();
      resolve(result);
    };
    const onShellMessage = (e: MessageEvent) => {
      if (e.origin === location.origin && e.data?.type === 'yaosb-modal-dismiss') close({ ok: false, value: '' });
    };
    closeOpenDialog = close;
    window.addEventListener('message', onShellMessage);
    postToShell({ type: 'yaosb-modal', open: true });
    dialogRoot!.render(h(Dialog, { key: Date.now(), options, onClose: close }));
  });
}

/** Styled replacement for window.confirm(). Resolves true on confirm. */
export async function confirmDialog(options: DialogOptions): Promise<boolean> {
  return (await showDialog(options)).ok;
}

/** Styled replacement for window.prompt(). Resolves null on cancel. */
export async function promptDialog(options: DialogOptions & { input: NonNullable<DialogOptions['input']> }): Promise<string | null> {
  const result = await showDialog(options);
  return result.ok ? result.value : null;
}

function Dialog({ options, onClose }: { options: DialogOptions; onClose: (result: DialogResult) => void }) {
  const { title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, input } = options;
  const [value, setValue] = useState(input?.defaultValue ?? '');
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useRef(`dialog-${Math.random().toString(36).slice(2)}`).current;

  useEffect(() => {
    if (input) { inputRef.current?.focus(); inputRef.current?.select(); }
    else if (danger) cancelRef.current?.focus();
    else confirmRef.current?.focus();
  }, []);

  const confirm = () => onClose({ ok: true, value });
  const cancel = () => onClose({ ok: false, value: '' });

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === 'Enter' && e.target === inputRef.current) {
      e.preventDefault();
      confirm();
    } else if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const items = panelRef.current?.querySelectorAll<HTMLElement>('button, input');
      if (!items || !items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  return h('div', { className: 'dialog-scrim', onMouseDown: (e: React.MouseEvent) => { if (e.target === e.currentTarget) cancel(); } },
    h('div', {
      ref: panelRef,
      className: 'dialog',
      role: input ? 'dialog' : 'alertdialog',
      'aria-modal': true,
      'aria-labelledby': titleId,
      onKeyDown,
    },
      h('div', { className: 'dialog-body' },
        danger ? h('span', { className: 'dialog-icon', 'aria-hidden': true }, h(FiAlertTriangle)) : null,
        h('div', { className: 'dialog-text' },
          h('h2', { id: titleId }, title),
          message ? h('p', null, message) : null,
          input ? h('label', { className: 'dialog-field' },
            h('span', null, input.label),
            h('input', {
              ref: inputRef,
              className: 'input',
              type: input.type || 'text',
              min: input.min,
              max: input.max,
              placeholder: input.placeholder,
              value,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value),
            })) : null)),
      h('div', { className: 'dialog-actions' },
        h('button', { type: 'button', ref: cancelRef, className: 'btn btn-quiet', onClick: cancel }, cancelLabel),
        h('button', { type: 'button', ref: confirmRef, className: `btn ${danger ? 'btn-danger-solid' : 'btn-accent'}`, onClick: confirm }, confirmLabel))));
}
