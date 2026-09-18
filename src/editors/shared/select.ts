/**
 * Custom dropdown used by every editor in place of the native <select>, so the
 * menu matches the dashboard instead of the OS.
 *
 * Follows the ARIA "select-only combobox" pattern: the trigger is a button with
 * role=combobox, the menu a listbox, and the highlighted option is tracked with
 * aria-activedescendant so focus never leaves the trigger (or the search box,
 * for long lists). The menu is portaled to <body> with fixed positioning, so
 * cards with `overflow: hidden` do not clip it, and it opens upward when there
 * is no room below.
 *
 * Styles live in `shared/tokens.css` (`.select-*`).
 */
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FiCheck, FiChevronDown, FiSearch } from 'react-icons/fi';

const h = React.createElement;

export type SelectOption = {
  value: string;
  label: string;
  /** Second line under the label, also matched by the search box. */
  hint?: string;
  /** A command rather than a value (e.g. "Enter ID manually…"): listed last
   *  under a divider, never shown as the selection, kept visible while searching. */
  action?: boolean;
  /** A "nothing chosen" entry (e.g. "No role"): drawn in the placeholder color. */
  muted?: boolean;
  disabled?: boolean;
  /** Inline style for the label, e.g. a font picker showing each font. */
  style?: React.CSSProperties;
};

export type SelectProps = {
  value: string | number | null | undefined;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Shown when the value matches no option. */
  placeholder?: string;
  disabled?: boolean;
  /** Extra classes for the trigger (layout only: width, flex). */
  className?: string;
  /** Defaults to on for lists longer than SEARCH_THRESHOLD. */
  searchable?: boolean;
  /** Accessible name when the select is not wrapped in a <label>. */
  label?: string;
  id?: string;
};

const SEARCH_THRESHOLD = 8;
const MENU_MAX_HEIGHT = 320;
const MENU_MIN_WIDTH = 200;
const OPTION_HEIGHT = 34;
const GAP = 4;
const EDGE = 8;

type MenuPos = { left: number; width: number; maxHeight: number; top?: number; bottom?: number; above: boolean };

export function Select(props: SelectProps) {
  const { options, onChange, placeholder = 'Choose…', disabled, className, label, id } = props;
  const current = props.value == null ? '' : String(props.value);
  const searchable = props.searchable ?? options.filter((o) => !o.action).length > SEARCH_THRESHOLD;
  const selected = options.find((o) => !o.action && o.value === current);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const typeahead = useRef({ text: '', at: 0 });
  // Which side the menu opened on; kept while it stays open so filtering a
  // long list does not make it jump from above the trigger to below it.
  const side = useRef<'above' | 'below' | null>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  // Values first, actions last, whatever order the caller passed.
  const ordered = useMemo(
    () => [...options.filter((o) => !o.action), ...options.filter((o) => o.action)],
    [options],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((o) => o.action || `${o.label} ${o.hint || ''}`.toLowerCase().includes(q));
  }, [ordered, query]);

  function firstEnabled(list: SelectOption[], from: number, step: 1 | -1): number {
    for (let i = from; i >= 0 && i < list.length; i += step) if (!list[i].disabled) return i;
    return -1;
  }

  function openMenu(highlight?: number) {
    if (disabled || open) return;
    setQuery('');
    const selectedIndex = ordered.findIndex((o) => !o.action && o.value === current);
    setActive(highlight ?? (selectedIndex >= 0 ? selectedIndex : Math.max(0, firstEnabled(ordered, 0, 1))));
    setOpen(true);
  }

  function closeMenu(refocus = true) {
    side.current = null;
    setOpen(false);
    setPos(null);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  }

  function pick(option: SelectOption | undefined) {
    if (!option || option.disabled) return;
    closeMenu();
    if (option.value !== current) onChange(option.value);
  }

  function move(step: 1 | -1, from = active) {
    if (!visible.length) return;
    let i = from;
    for (let n = 0; n < visible.length; n += 1) {
      i = (i + step + visible.length) % visible.length;
      if (!visible[i].disabled) { setActive(i); return; }
    }
  }

  // Jump to the next option starting with the typed text (native behavior).
  function typeAhead(char: string) {
    const now = Date.now();
    const state = typeahead.current;
    state.text = now - state.at > 700 ? char : state.text + char;
    state.at = now;
    const needle = state.text.toLowerCase();
    const start = state.text.length === 1 ? active + 1 : active;
    for (let n = 0; n < visible.length; n += 1) {
      const i = (start + n) % visible.length;
      if (!visible[i].disabled && visible[i].label.replace(/^#/, '').toLowerCase().startsWith(needle)) {
        if (open) setActive(i); else openMenu(i);
        return;
      }
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const key = e.key;
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        e.preventDefault();
        openMenu();
      } else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (searchable) {
          e.preventDefault();
          openMenu();
          setQuery(key);
        } else {
          typeAhead(key);
        }
      }
      return;
    }
    switch (key) {
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'Home': e.preventDefault(); setActive(Math.max(0, firstEnabled(visible, 0, 1))); break;
      case 'End': e.preventDefault(); setActive(Math.max(0, firstEnabled(visible, visible.length - 1, -1))); break;
      case 'PageDown': e.preventDefault(); setActive(Math.min(visible.length - 1, active + 8)); break;
      case 'PageUp': e.preventDefault(); setActive(Math.max(0, active - 8)); break;
      case 'Enter': e.preventDefault(); pick(visible[active]); break;
      case 'Escape':
        // Keep the Escape from also closing a drawer or dialog around us.
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        break;
      case 'Tab':
        // The search box lives at the end of <body>; tabbing from it would jump
        // focus out of place, so hand focus back to the trigger instead.
        if (searchable) e.preventDefault();
        closeMenu(searchable);
        break;
      case ' ':
        if (!searchable) { e.preventDefault(); pick(visible[active]); }
        break;
      default:
        if (!searchable && key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) typeAhead(key);
    }
  }

  function place() {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Scrolled fully out of view: nothing sensible to anchor to.
    if (rect.bottom < 0 || rect.top > vh) { closeMenu(false); return; }
    const natural = menuRef.current
      ? menuRef.current.scrollHeight
      : ordered.length * OPTION_HEIGHT + (searchable ? 45 : 0) + 10;
    const wanted = Math.min(MENU_MAX_HEIGHT, natural);
    const spaceBelow = vh - rect.bottom - GAP - EDGE;
    const spaceAbove = rect.top - GAP - EDGE;
    if (!side.current) side.current = spaceBelow < wanted && spaceAbove > spaceBelow ? 'above' : 'below';
    const above = side.current === 'above';
    const maxHeight = Math.max(120, Math.min(MENU_MAX_HEIGHT, above ? spaceAbove : spaceBelow));
    const width = Math.min(vw - EDGE * 2, Math.max(rect.width, MENU_MIN_WIDTH));
    const left = Math.min(Math.max(EDGE, rect.left), vw - width - EDGE);
    setPos(above
      ? { left, width, maxHeight, bottom: vh - rect.top + GAP, above }
      : { left, width, maxHeight, top: rect.bottom + GAP, above });
  }

  // Position before paint, then follow scrolling and resizing.
  useLayoutEffect(() => {
    if (!open) return;
    place();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, [open, visible.length]);

  // Close on a press anywhere else, or when the window loses focus (a click
  // in the dashboard shell around this frame never reaches this document).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      // A press on the wrapping <label> becomes a click on the trigger, which
      // toggles the menu itself; closing here too would reopen it.
      if (triggerRef.current?.closest('label')?.contains(target)) return;
      closeMenu(false);
    };
    const onBlur = () => closeMenu(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);

  useEffect(() => {
    if (open && searchable && pos) searchRef.current?.focus();
  }, [open, searchable, pos !== null]);

  // Typing narrows the list: highlight the first match.
  useEffect(() => {
    if (open && query) setActive(Math.max(0, firstEnabled(visible, 0, 1)));
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, active, pos !== null]);

  // A trigger disabled while open closes its menu.
  useEffect(() => {
    if (disabled && open) closeMenu(false);
  }, [disabled]);

  const activeId = open && visible[active] ? optionId(active) : undefined;

  const trigger = h('button', {
    type: 'button',
    ref: triggerRef,
    id,
    className: `select-trigger${open ? ' is-open' : ''}${selected && !selected.muted ? '' : ' is-placeholder'}${className ? ` ${className}` : ''}`,
    disabled,
    role: 'combobox',
    'aria-haspopup': 'listbox',
    'aria-expanded': open,
    'aria-controls': open ? listId : undefined,
    'aria-activedescendant': searchable ? undefined : activeId,
    'aria-label': label,
    onClick: () => (open ? closeMenu() : openMenu()),
    onKeyDown,
  },
    h('span', { className: 'select-value', style: selected?.style },
      selected ? selected.label : placeholder,
      // The second line (e.g. which server a channel is in) stays visible once chosen.
      selected?.hint ? h('span', { className: 'select-value-hint' }, selected.hint) : null),
    h(FiChevronDown, { className: 'select-chevron', 'aria-hidden': true }));

  const firstAction = visible.findIndex((o) => o.action);
  const menu = open && pos ? createPortal(
    h('div', {
      ref: menuRef,
      className: `select-menu${pos.above ? ' is-above' : ''}`,
      style: { left: pos.left, width: pos.width, maxHeight: pos.maxHeight, top: pos.top, bottom: pos.bottom },
      // Keep focus where it is (trigger or search box) when clicking options.
      onMouseDown: (e: React.MouseEvent) => {
        if (e.target !== searchRef.current) e.preventDefault();
      },
    },
      searchable ? h('div', { className: 'select-search' },
        h(FiSearch, { 'aria-hidden': true }),
        h('input', {
          ref: searchRef,
          className: 'select-search-input',
          type: 'text',
          value: query,
          placeholder: 'Search…',
          autoComplete: 'off',
          spellCheck: false,
          role: 'combobox',
          'aria-expanded': true,
          'aria-controls': listId,
          'aria-autocomplete': 'list',
          'aria-activedescendant': activeId,
          'aria-label': label ? `Search ${label}` : 'Search options',
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value),
          onKeyDown,
        })) : null,
      h('div', { className: 'select-list', role: 'listbox', id: listId, ref: listRef, 'aria-label': label },
        visible.length === 0
          ? h('div', { className: 'select-empty' }, query ? 'No matches.' : 'Nothing to choose from.')
          : visible.map((option, i) => {
              const isSelected = !option.action && option.value === current;
              // "Nothing chosen" entries are not marked: a check on "Choose…" reads oddly.
              const showSelected = isSelected && !option.muted;
              const classes = ['select-option'];
              if (i === active) classes.push('is-active');
              if (showSelected) classes.push('is-selected');
              if (option.action) classes.push('is-action');
              if (option.muted) classes.push('is-muted');
              if (option.action && i === firstAction && i > 0) classes.push('has-divider');
              if (option.disabled) classes.push('is-disabled');
              return h('div', {
                key: `${option.action ? 'a' : 'v'}:${option.value}`,
                id: optionId(i),
                'data-index': i,
                role: 'option',
                'aria-selected': isSelected,
                'aria-disabled': option.disabled || undefined,
                className: classes.join(' '),
                onMouseMove: () => { if (i !== active && !option.disabled) setActive(i); },
                onClick: () => pick(option),
              },
                h('span', { className: 'select-option-text' },
                  h('span', { className: 'select-option-label', style: option.style }, option.label),
                  option.hint ? h('span', { className: 'select-option-hint' }, option.hint) : null),
                showSelected ? h(FiCheck, { className: 'select-check', 'aria-hidden': true }) : null);
            })),
    ),
    document.body,
  ) : null;

  return h(React.Fragment, null, trigger, menu);
}

/** Channel list → options, `#name` labels. */
export function channelOptions(channels: Array<{ id: string; name: string }> | null | undefined): SelectOption[] {
  return (channels || []).map((c) => ({ value: c.id, label: `#${c.name}` }));
}

/** Role (or any `{ id, name }`) list → options. */
export function namedOptions(items: Array<{ id: string; name: string }> | null | undefined): SelectOption[] {
  return (items || []).map((item) => ({ value: item.id, label: item.name }));
}

/** A clearable "nothing chosen" entry with the empty value. */
export function noneOption(label: string): SelectOption {
  return { value: '', label, muted: true };
}

/** The "type an ID instead" command offered by the channel/role pickers. */
export const MANUAL_ID_OPTION: SelectOption = { value: '__id__', label: 'Enter ID manually…', action: true };
