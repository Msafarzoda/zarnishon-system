import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
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
    /**
     * РЯМ / РМА / ИНН, e.g. "5830076707" — **the farm's identity**.
     *
     * Names are written differently on different waybills, so a farm keyed by name
     * appears twice under two spellings and has its cotton, its advances and its balance
     * split across two records nobody notices. The number does not vary, so it is unique
     * and it is what search matches first. Digits only, no spaces. docs/domain.md §6.
     */
    tin: text("tin"),
    /** Маҳалли бор кардан — usual loading place, e.g. "ч.Бустон". */
    defaultLocation: text("default_location"),
    /** бригада / звено code from the waybill. */
    brigadeCode: text("brigade_code"),
    phone: text("phone"),
    note: text("note"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Who entered this record. A farm created at the weighbridge is reviewable. */
    createdBy: uuid("created_by"),
    /** Idempotency key, so a record added offline is not created twice on sync. */
    clientUuid: uuid("client_uuid"),
  },
  (t) => [
    index("counterparties_name_idx").on(t.name),
    /* Unique rather than merely indexed. Postgres allows any number of NULLs in a unique
       index, which is what lets a non-farm counterparty carry no number at all. */
    uniqueIndex("counterparties_tin_idx").on(t.tin),
    uniqueIndex("counterparties_client_uuid_idx").on(t.clientUuid),
  ],
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
    createdBy: uuid("created_by"),
    clientUuid: uuid("client_uuid"),
  },
  (t) => [
    index("vehicles_plate_idx").on(t.plate),
    uniqueIndex("vehicles_client_uuid_idx").on(t.clientUuid),
  ],
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
    createdBy: uuid("created_by"),
    clientUuid: uuid("client_uuid"),
  },
  (t) => [
    index("drivers_name_idx").on(t.fullName),
    uniqueIndex("drivers_client_uuid_idx").on(t.clientUuid),
  ],
);
