"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { tg } from "@/lib/i18n/tg";

/**
 * A type-to-filter dropdown, standing in for a plain `<select>`.
 *
 * A native select with a few hundred хоҷагиҳо in it is a scroll, not a search — finding
 * one by name means reading past the ones before it. This filters the list as the
 * operator types, on the whole label (so a TIN like "5830021267" and a name like
 * "Саидмир" both find the same farm), and keeps the keyboard usable: arrows to move,
 * Enter to pick, Escape to back out without changing anything already chosen.
 */
export function SearchableSelect({
  id, value, onChange, options, placeholder, required,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [query, options]);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  function pick(v: string) {
    onChange(v);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        id={id}
        className="input"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-required={required}
        autoComplete="off"
        placeholder={placeholder ?? tg.common.search}
        value={open ? query : (selected?.label ?? "")}
        onFocus={() => { setOpen(true); setQuery(""); setHighlight(0); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setHighlight(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(h + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const hit = filtered[highlight];
            if (hit) pick(hit.value);
          } else if (e.key === "Escape") {
            setOpen(false);
            setQuery("");
          }
        }}
      />
      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-paper-line bg-paper shadow-lg"
        >
          {filtered.length === 0 && (
            <li className="px-3 py-2 text-sm text-ink-faint">{tg.common.noResults}</li>
          )}
          {filtered.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`cursor-pointer px-3 py-2 text-sm ${
                i === highlight ? "bg-brand-light" : ""
              } ${o.value === value ? "font-semibold" : ""}`}
              onMouseEnter={() => setHighlight(i)}
              // mousedown, not click: it must fire before the input's blur closes the list.
              onMouseDown={(e) => { e.preventDefault(); pick(o.value); }}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
