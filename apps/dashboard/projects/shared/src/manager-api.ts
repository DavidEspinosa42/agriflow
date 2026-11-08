import {
  type ConsumptionReport,
  ConsumptionReportSchema,
  type DeviceList,
  DeviceListSchema,
  type GroupByDto,
  type TotalsList,
  TotalsListSchema,
  type TransactionPage,
  TransactionPageSchema,
} from "@agriflow/core";
import type { ZodType } from "zod";

export type ApiErrorKind =
  | "unauthorized"
  | "invalid_query"
  | "server"
  | "network"
  | "invalid_response";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  constructor(kind: ApiErrorKind) {
    super(kind);
    this.name = "ApiError";
    this.kind = kind;
  }
}

export interface TransactionQuery {
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly machineId?: string | undefined;
  readonly operatorId?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface ConsumptionQuery extends Omit<TransactionQuery, "limit" | "offset"> {
  readonly groupBy?: GroupByDto | undefined;
  readonly utcOffsetMinutes?: number | undefined;
}

type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface ManagerApiOptions {
  /** Empty for the same origin, otherwise for example https://farm.example.com */
  readonly baseUrl: string;
  /** Manager bearer token. Kept in memory by the caller; never logged. */
  readonly token: string;
  readonly fetch?: FetchLike | undefined;
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

/** Typed, validated client for the manager read API. */
export class ManagerApi {
  readonly #o: ManagerApiOptions;

  constructor(options: ManagerApiOptions) {
    this.#o = options;
  }

  transactions(query: TransactionQuery = {}): Promise<TransactionPage> {
    return this.#get(`/v1/transactions${queryString({ ...query })}`, TransactionPageSchema);
  }

  consumption(query: ConsumptionQuery = {}): Promise<ConsumptionReport> {
    return this.#get(
      `/v1/reports/consumption${queryString({ ...query })}`,
      ConsumptionReportSchema,
    );
  }

  machines(
    range: { from?: number | undefined; to?: number | undefined } = {},
  ): Promise<TotalsList> {
    return this.#get(`/v1/machines${queryString({ ...range })}`, TotalsListSchema);
  }

  operators(
    range: { from?: number | undefined; to?: number | undefined } = {},
  ): Promise<TotalsList> {
    return this.#get(`/v1/operators${queryString({ ...range })}`, TotalsListSchema);
  }

  devices(): Promise<DeviceList> {
    return this.#get("/v1/devices", DeviceListSchema);
  }

  async #get<T>(path: string, schema: ZodType<T>): Promise<T> {
    const doFetch: FetchLike = this.#o.fetch ?? ((url, init) => fetch(url, init));
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await doFetch(`${this.#o.baseUrl.replace(/\/+$/, "")}${path}`, {
        headers: { authorization: `Bearer ${this.#o.token}` },
      });
    } catch {
      throw new ApiError("network");
    }
    if (response.status === 401) throw new ApiError("unauthorized");
    if (response.status === 400) throw new ApiError("invalid_query");
    if (!response.ok) throw new ApiError("server");
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError("invalid_response");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError("invalid_response");
    return parsed.data;
  }
}
