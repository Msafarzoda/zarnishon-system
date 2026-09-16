import { DomainError } from "./units";

/**
 * Рақами давлатӣ — Tajik vehicle plates.
 *
 * Two shapes are in use at the gate:
 *     0000 AA 00     four digits, two letters, region code
 *     000AA00        three digits, no spacing
 *
 * Both are normalised to a single spaced form so the same truck is the same record.
 *
 * The important part is the letters. Tajik plates use **Latin** letters, but an operator
 * typing on a Cyrillic keyboard produces А В Е К М Н О Р С Т У Х — characters that look
 * identical on screen and are completely different bytes. Without folding them, "1234 АВ
 * 01" and "1234 AB 01" are two different trucks in the database, the duplicate check
 * never fires, and the same vehicle accumulates two sets of tickets.
 */

/** Cyrillic letters that are visually identical to a Latin one, and their Latin twin. */
const HOMOGLYPHS: Record<string, string> = {
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H",
  О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X",
  а: "A", в: "B", е: "E", к: "K", м: "M", н: "H",
  о: "O", р: "P", с: "C", т: "T", у: "Y", х: "X",
};

/** 3–4 digits, two letters, two-digit region. Separators and case are ignored. */
const PLATE = /^(\d{3,4})([A-Z]{2})(\d{2})$/;

export interface NormalisedPlate {
  /** Canonical form, e.g. "1234 AB 01". Store and compare this. */
  plate: string;
  /** False when the input did not match a known Tajik pattern but was kept anyway. */
  standard: boolean;
}

/**
 * Fold a typed plate to its canonical form.
 *
 * An unrecognised plate is **not rejected** — a trailer, a foreign truck or an old
 * format must never stop the weighbridge. It is returned tidied up and flagged
 * `standard: false` so the owner's review list can show it.
 */
export function normalisePlate(input: string): NormalisedPlate {
  const raw = input.trim();
  if (!raw) throw new DomainError("Рақами давлатӣ ҳатмист. / A plate number is required.");

  const folded = raw
    .toUpperCase()
    .split("")
    .map((ch) => HOMOGLYPHS[ch] ?? ch)
    .join("");

  // Strip everything that is not a digit or a Latin letter, so "1234-AB-01",
  // "1234 ab 01" and "1234AB01" all collapse to the same key.
  const compact = folded.replace(/[^0-9A-Z]/g, "");

  const match = PLATE.exec(compact);
  if (!match) {
    return { plate: folded.replace(/\s+/g, " "), standard: false };
  }

  const [, digits, letters, region] = match;
  return { plate: `${digits} ${letters} ${region}`, standard: true };
}

/** Ташкилоти автомобилӣ — who the truck belongs to. */
export const TRANSPORT_ORGS = ["Хусусӣ", "Ширкатӣ"] as const;
export type TransportOrg = (typeof TRANSPORT_ORGS)[number];

export function isTransportOrg(value: string): value is TransportOrg {
  return (TRANSPORT_ORGS as readonly string[]).includes(value);
}

/**
 * РМА / РЯМ / ИНН — a farm's tax number, which is how a хоҷагӣ is identified.
 *
 * Normalised before it is stored or compared, because the same number is written with
 * spaces, dashes or a leading letter depending on who is filling in the waybill, and two
 * spellings of one number would create two farms. docs/domain.md §6.
 */
export function normaliseTin(raw: string): string {
  return raw.replace(/\D/g, "");
}

/** Whether this looks like a usable tax number. Length is not fixed by law we can rely on. */
export function isPlausibleTin(raw: string): boolean {
  const digits = normaliseTin(raw);
  return digits.length >= 8 && digits.length <= 14 && !/^0+$/.test(digits);
}
