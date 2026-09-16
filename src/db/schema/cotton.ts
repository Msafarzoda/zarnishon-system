import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { storageKind } from "./enums";

/** Навъи пахта — selection variety, e.g. С-6530. */
export const varieties = pgTable("varieties", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),
  nameTg: text("name_tg"),
  isActive: boolean("is_active").notNull().default(true),
});

/** Анбор / бунт / навес — where a truck unloads. */
export const storageLocations = pgTable("storage_locations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),
  nameTg: text("name_tg").notNull(),
  kind: storageKind("kind").notNull(),
  capacityG: integer("capacity_g"),
  isActive: boolean("is_active").notNull().default(true),
});

/**
 * Партия — a lot of cotton of one variety/grade accumulated in one storage location.
 * The lab analyses a партия, not an individual truck, so the батч is the unit that
 * carries the moisture and trash figures used to pay every ticket in it.
 */
export const batches = pgTable(
  "batches",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** Партия number as written on the paperwork, e.g. 101. */
    number: integer("number").notNull(),
    season: integer("season").notNull(), // Хосил-2026
    varietyId: uuid("variety_id").references(() => varieties.id),
    /** Сорт — industrial grade, 1–5. */
    grade: integer("grade"),
    /** Синфи бор — class. */
    cottonClass: text("cotton_class"),
    storageLocationId: uuid("storage_location_id").references(() => storageLocations.id),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    /** Once closed, no new ticket may be assigned to this партия. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    note: text("note"),
  },
  (t) => [uniqueIndex("batches_season_number_idx").on(t.season, t.number)],
);

/**
 * Factory-wide settings the owner controls. Single row, versioned by insert:
 * the live settings are the most recent row. Nothing here is ever UPDATEd.
 */
export const factorySettings = pgTable(
  "factory_settings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** TOTAL | EXCESS_OVER_NORM — see docs/domain.md §3. An owner decision. */
    deductionMode: text("deduction_mode").notNull(),
    normMoistureBp: integer("norm_moisture_bp").notNull(),
    normTrashBp: integer("norm_trash_bp").notNull(),
    /** Mass-balance tolerance per batch, basis points. Drift beyond this alarms. */
    massBalanceToleranceBp: integer("mass_balance_tolerance_bp").notNull().default(50),
    /**
     * How much a farm may borrow per kilogram of its cotton sitting in our warehouse,
     * diram. The collateral rate, not a price: 100 = 1 сомонӣ per kg. docs/domain.md §4.
     */
    advanceRateDPerKg: integer("advance_rate_d_per_kg").notNull().default(100),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    setBy: uuid("set_by").notNull(),
    reason: text("reason"),
  },
  (t) => [index("factory_settings_effective_idx").on(t.effectiveFrom)],
);
