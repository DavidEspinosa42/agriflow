import { z } from "zod";
import { SessionRecord } from "./ledger.ts";

/**
 * Response shapes of the manager read API. The server tests check its responses against these
 * and the dashboard validates what it receives with them.
 */

export const StoredTransactionSchema = SessionRecord.extend({
  receivedAtMs: z.number().int().nonnegative(),
});
export type StoredTransactionDto = z.infer<typeof StoredTransactionSchema>;

export const TransactionPageSchema = z.strictObject({
  items: z.array(StoredTransactionSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type TransactionPage = z.infer<typeof TransactionPageSchema>;

export const GroupBySchema = z.enum(["machine", "operator", "device", "day"]);
export type GroupByDto = z.infer<typeof GroupBySchema>;

export const ConsumptionRowSchema = z.strictObject({
  /** Machine, operator or device id, or a YYYY-MM-DD date for day grouping. */
  key: z.string(),
  /** Display name for the key when it differs from it, e.g. the equipment number of a machine. */
  label: z.string().optional(),
  liters: z.number().nonnegative(),
  sessions: z.number().int().nonnegative(),
});
export type ConsumptionRowDto = z.infer<typeof ConsumptionRowSchema>;

export const ConsumptionReportSchema = z.strictObject({
  groupBy: GroupBySchema,
  rows: z.array(ConsumptionRowSchema),
});
export type ConsumptionReport = z.infer<typeof ConsumptionReportSchema>;

/** `/v1/machines` and `/v1/operators`: totals per id. */
export const TotalsListSchema = z.strictObject({ items: z.array(ConsumptionRowSchema) });
export type TotalsList = z.infer<typeof TotalsListSchema>;

export const DeviceStatusSchema = z.strictObject({
  deviceId: z.string(),
  tankId: z.string(),
  sessions: z.number().int().nonnegative(),
  /** When the server last stored a session from this device, or null if none yet. */
  lastReceivedAtMs: z.number().int().nonnegative().nullable(),
});
export type DeviceStatusDto = z.infer<typeof DeviceStatusSchema>;

export const DeviceListSchema = z.strictObject({ items: z.array(DeviceStatusSchema) });
export type DeviceList = z.infer<typeof DeviceListSchema>;
