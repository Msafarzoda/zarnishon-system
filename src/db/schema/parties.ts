import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { counterpartyKind } from "./enums";

/**
 * Everyone we transact with: farms delivering cotton (Борфиристонанда),
 * individuals, and companies buying cottonseed.
 */
export const counterparties = pgTable(
  "counterparties",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    kind: counterpartyKind("kind").notNull(),
    /** Name as written on the waybill, e.g. "х-д Билол-Б". */
    name: text("name").notNull(),
    /** РЯМ / РМА / ИНН, e.g. "5830076707". */
    tin: text("tin"),
    /** Маҳалли бор кардан — usual loading place, e.g. "ч.Бустон". */
    defaultLocation: text("default_location"),
    /** бригада / звено code from the waybill. */
    brigadeCode: text("brigade_code"),
    phone: text("phone"),
    note: text("note"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("counterparties_name_idx").on(t.name), index("counterparties_tin_idx").on(t.tin)],
);

/** Автомошин — vehicle, identified by its state plate. */
export const vehicles = pgTable(
  "vehicles",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** рақами давлатӣ — state registration number. */
    plate: text("plate").notNull().unique(),
    /** навъ — model, e.g. "Газел 22-60". */
    model: text("model"),
    /** Ташкилоти автомобилӣ, e.g. "Хусусӣ" (private). */
    transportOrg: text("transport_org"),
    trailerPlate: text("trailer_plate"),
    garageNo: text("garage_no"),
    /** Typical empty weight, grams — a sanity check against the measured tare, never a substitute. */
    referenceTareG: text("reference_tare_g"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("vehicles_plate_idx").on(t.plate)],
);

/** Ронанда — driver. */
export const drivers = pgTable(
  "drivers",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    fullName: text("full_name").notNull(),
    phone: text("phone"),
    licenseNo: text("license_no"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("drivers_name_idx").on(t.fullName)],
);
