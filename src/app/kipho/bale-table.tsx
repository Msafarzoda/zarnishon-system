"use client";

import { useMemo, useState } from "react";
import { gramsToKgString } from "@/domain/units";
import { parseBaleSerial } from "@/domain/product";
import { tg } from "@/lib/i18n/tg";
import { Section, TBody, Td, Th } from "@/components/ui";

export interface BaleRow {
  id: string;
  serial: string;
  weightG: number;
  grade: string | null;
  state: string;
  stateLabel: string;
  pressedAt: string;
  batchNumber: number | null;
  store: string | null;
}

const STATE_STYLE: Record<string, string> = {
  IN_STOCK: "bg-brand-light text-brand-dark",
  SHIPPED: "bg-amber-100 text-warn",
  SOLD: "bg-paper text-ink-soft",
  REPRESSED: "bg-sky-100 text-sky-900",
  VOID: "bg-red-100 text-alarm line-through",
};

/**
 * The bale list, searchable by the thing a person has in front of them.
 *
 * A scanner types the serial and presses Enter, so the search box has to accept a full
 * serial as readily as "101" typed by hand — both narrow the same list, and a scan that
 * matches exactly one bale selects it. There is no separate "scan" mode to be in the
 * wrong one of.
 */
export function BaleTable({ bales }: { bales: BaleRow[] }) {
  const [query, setQuery] = useState("");
  const [onlyStock, setOnlyStock] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const scanned = parseBaleSerial(query);
    return bales.filter((b) => {
      if (onlyStock && b.state !== "IN_STOCK") return false;
      if (!q) return true;
      if (scanned) return b.serial.toUpperCase() === query.trim().toUpperCase();
      return (
        b.serial.toLowerCase().includes(q) ||
        String(b.batchNumber ?? "").includes(q) ||
        (b.store ?? "").toLowerCase().includes(q)
      );
    });
  }, [bales, query, onlyStock]);

  const allShownSelected = shown.length > 0 && shown.every((b) => selected.includes(b.id));
  const selectedWeightG = bales
    .filter((b) => selected.includes(b.id))
    .reduce((sum, b) => sum + b.weightG, 0);

  return (
    <Section
      title={tg.bales.title}
      subtitle={`${shown.length} × ${tg.bales.serial}`}
      scroll
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input w-56"
            placeholder={tg.bales.scanHere}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="flex items-center gap-1.5 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={onlyStock}
              onChange={(e) => setOnlyStock(e.target.checked)}
            />
            {tg.bales.inStock}
          </label>
          {selected.length > 0 && (
            <a
              className="btn-primary"
              href={`/kipho/tamgha?ids=${selected.join(",")}`}
              target="_blank"
              rel="noreferrer"
            >
              {tg.bales.printLabel} ({selected.length})
            </a>
          )}
        </div>
      }
    >
      {selected.length > 0 && (
        <p className="mb-2 text-sm text-ink-soft">
          {tg.bales.scanned}: <strong className="tabular">{selected.length}</strong>
          {" · "}
          <strong className="tabular">{gramsToKgString(selectedWeightG, 1)}</strong> {tg.common.kg}
        </p>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr>
            <Th>
              <input
                type="checkbox"
                checked={allShownSelected}
                onChange={(e) =>
                  setSelected(e.target.checked ? shown.map((b) => b.id) : [])
                }
              />
            </Th>
            <Th>{tg.bales.serial}</Th>
            <Th>{tg.ticket.batch}</Th>
            <Th align="end">{tg.common.weight}</Th>
            <Th>{tg.ticket.grade}</Th>
            <Th>{tg.common.store}</Th>
            <Th>{tg.bales.state}</Th>
            <Th align="end">{tg.common.date}</Th>
          </tr>
        </thead>
        <TBody>
          {shown.map((b) => (
            <tr key={b.id}>
              <Td>
                <input
                  type="checkbox"
                  checked={selected.includes(b.id)}
                  onChange={(e) =>
                    setSelected((s) =>
                      e.target.checked ? [...s, b.id] : s.filter((x) => x !== b.id),
                    )
                  }
                />
              </Td>
              <Td className="font-mono text-brand">{b.serial}</Td>
              <Td numeric>{b.batchNumber ?? "—"}</Td>
              <Td align="end" numeric className="font-semibold">
                {gramsToKgString(b.weightG, 1)}
              </Td>
              <Td>{b.grade ?? "—"}</Td>
              <Td className="text-ink-soft">{b.store ?? "—"}</Td>
              <Td>
                <span className={`badge ${STATE_STYLE[b.state] ?? "bg-paper text-ink-soft"}`}>
                  {b.stateLabel}
                </span>
              </Td>
              <Td align="end" numeric className="text-ink-faint">
                {new Date(b.pressedAt).toLocaleDateString("ru-RU", {
                  day: "2-digit", month: "2-digit",
                })}
              </Td>
            </tr>
          ))}
        </TBody>
      </table>
    </Section>
  );
}
