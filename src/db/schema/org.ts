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
import { userRole } from "./enums";

/** A physical workplace: the gate, the weighbridge, the lab bench, the cash desk. */
export const stations = pgTable("stations", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  /** Short code that prefixes ticket serials, e.g. "T1" for тарозу 1. */
  code: text("code").notNull().unique(),
  nameTg: text("name_tg").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    username: text("username").notNull().unique(),
    fullName: text("full_name").notNull(),
    role: userRole("role").notNull(),
    /** scrypt: <salt-hex>:<hash-hex> */
    passwordHash: text("password_hash").notNull(),
    /** 4–6 digit PIN hash for fast station login; optional. */
    pinHash: text("pin_hash"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (t) => [index("users_role_idx").on(t.role)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // opaque random token
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    stationId: uuid("station_id").references(() => stations.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Contiguous ranges of ticket serial numbers handed out to a station in advance, so a
 * station that is offline can still print a valid unique ticket. Because the ranges are
 * contiguous, a serial that is never used is visible as a gap and must be voided with a
 * reason. docs/domain.md §2.
 */
export const serialBlocks = pgTable(
  "serial_blocks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    stationId: uuid("station_id")
      .notNull()
      .references(() => stations.id),
    season: integer("season").notNull(), // Хосил-2026
    rangeStart: integer("range_start").notNull(),
    rangeEnd: integer("range_end").notNull(),
    nextSerial: integer("next_serial").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    issuedBy: uuid("issued_by").references(() => users.id),
  },
  (t) => [
    uniqueIndex("serial_blocks_station_season_start_idx").on(t.stationId, t.season, t.rangeStart),
  ],
);
