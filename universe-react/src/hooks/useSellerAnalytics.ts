/**
 * Seller sales analytics — every figure on the Sales Analytics page is
 * computed here from the seller's REAL orders (GET /seller/orders).
 *
 * There is no mock layer in this file: when there are no orders the page
 * shows its empty state, and when the backend is unreachable it shows the
 * error — never invented numbers.
 *
 * Orders awaiting the seller's confirmation are deliberately EXCLUDED from
 * revenue and products sold (they still appear in the orders count and recent
 * list with an "Awaiting confirmation" badge). Confirming them from the
 * dashboard notification bell invalidates the `seller-orders` queries, so the
 * figures update immediately.
 *
 * Windows: the selected range (7d/30d/90d) is aggregated for the CURRENT
 * period and again for the immediately PREVIOUS period of the same length,
 * which is what the "vs last period" trends compare against. Orders are
 * fetched window-by-window (server-side since/until filtering) and paged
 * through completely so the totals cover every order, not just page 1.
 */
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ordersApi } from '../api/services/orders';
import { ApiError } from '../api/errors';
import type { Order } from '../api/types';
import { useCurrentUser } from './useAuth';

export type SalesRange = '7d' | '30d' | '90d';

/** Length of each range in days. */
const RANGE_DAYS: Record<SalesRange, number> = { '7d': 7, '30d': 30, '90d': 90 };

/** Human label per range, shown in the chart subtitle. */
export const RANGE_LABELS: Record<SalesRange, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

/** Page size for the order page walk — one page usually covers every order. */
const PAGE_SIZE = 100;
/** Safety cap: 50 pages x 100 orders is far beyond any realistic window. */
const MAX_PAGES = 50;

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export interface AnalyticsWindows {
  /** Current period: [since, until]. */
  since: string;
  until: string;
  /** Previous period of the same length, immediately before `since`. */
  prevSince: string;
  prevUntil: string;
}

/** Calendar windows (local time) for a range: current + previous period. */
export function analyticsWindows(range: SalesRange, now = new Date()): AnalyticsWindows {
  const days = RANGE_DAYS[range];
  const since = startOfDay(addDays(now, -(days - 1)));
  const prevSince = startOfDay(addDays(since, -days));
  return {
    since: since.toISOString(),
    until: now.toISOString(),
    prevSince: prevSince.toISOString(),
    prevUntil: since.toISOString(),
  };
}

/** Walk every page of the seller's orders inside a window. */
async function fetchOrdersInRange(since: string, until: string): Promise<Order[]> {
  const all: Order[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await ordersApi.getSellerOrders({ since, until, page, pageSize: PAGE_SIZE });
    all.push(...res.items);
    const loaded = (page - 1) * PAGE_SIZE + res.items.length;
    if (res.items.length === 0 || loaded >= res.total) break;
  }
  return all;
}

/** All of the seller's orders inside one window, refreshed about every minute. */
export function useSellerOrders(span: { since: string; until: string }) {
  return useQuery<Order[], ApiError>({
    queryKey: ['seller-orders', span.since, span.until],
    queryFn: () => fetchOrdersInRange(span.since, span.until),
    // Realtime-enough for a dashboard: fresh data on window focus and a
    // background refresh every minute. Same-key refreshes keep the previous
    // rows visible (no flicker back to "loading").
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** Page walk used by the notification bell (pending orders are always recent). */
const PENDING_PAGE_SIZE = 100;
const PENDING_MAX_PAGES = 5;

/**
 * Orders the signed-in seller still has to confirm. Drives the dashboard
 * notification bell/dropdown; refreshes every 30s so a buyer's fresh order
 * appears without a reload. Client-side filtering is a safety net for
 * backends that don't yet support the `confirmation` query parameter.
 */
export function useSellerPendingOrders() {
  const { data: user } = useCurrentUser();
  return useQuery<Order[], ApiError>({
    queryKey: ['seller-orders', 'pending-confirmation', user?.id ?? null],
    enabled: user?.accountType === 'seller',
    queryFn: async () => {
      const all: Order[] = [];
      for (let page = 1; page <= PENDING_MAX_PAGES; page += 1) {
        const res = await ordersApi.getSellerOrders({
          confirmation: 'pending',
          page,
          pageSize: PENDING_PAGE_SIZE,
        });
        all.push(...res.items);
        if (res.items.length === 0) break;
        const loaded = (page - 1) * PENDING_PAGE_SIZE + res.items.length;
        if (loaded >= res.total) break;
      }
      return all.filter((order) => orderAwaitingConfirmation(order));
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** Page size for the full notifications feed on the "view all" page. */
const FEED_PAGE_SIZE = 50;

/**
 * Recent order notifications for the "View all notifications" page.
 *
 * The bell only needs the orders still awaiting confirmation, but the full
 * page also previews orders the seller has already handled (confirmed or
 * cancelled). It loads the newest seller orders without a date window so the
 * history is not tied to the Sales Analytics range. It shares the
 * `seller-orders` query prefix, so confirming an order refreshes the feed and
 * the dashboard figures together.
 */
export function useSellerNotificationFeed(pageSize = FEED_PAGE_SIZE) {
  const { data: user } = useCurrentUser();
  return useQuery<Order[], ApiError>({
    queryKey: ['seller-orders', 'notification-feed', user?.id ?? null, pageSize],
    enabled: user?.accountType === 'seller',
    queryFn: async () => {
      const res = await ordersApi.getSellerOrders({ page: 1, pageSize });
      return res.items;
    },
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Seller confirms a pending order. Invalidating the `seller-orders` prefix
 * refreshes BOTH the pending notification list and the analytics windows, so
 * revenue / products sold update the moment the seller confirms.
 */
export function useConfirmSellerOrder() {
  const queryClient = useQueryClient();
  return useMutation<Order, ApiError, string>({
    mutationFn: (id) => ordersApi.confirmOrder(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['seller-orders'] });
    },
  });
}

/* ----------------------------- Metric math ------------------------------ */

/** True when the seller still has to confirm that the order was made. */
export function orderAwaitingConfirmation(order: Order): boolean {
  return order.status !== 'cancelled' && order.confirmation === 'pending';
}

/**
 * Revenue one order contributes to THIS seller: the sum of the seller's own
 * line totals, excluding cancelled orders AND orders the seller has not yet
 * confirmed. Falls back to the backend-computed order total only when the
 * backend omitted line items (optional outside /seller/orders) — never a
 * locally recomputed guess.
 */
export function orderSellerAmount(order: Order, sellerId?: string | null): number {
  if (order.status === 'cancelled' || orderAwaitingConfirmation(order)) return 0;
  if (Array.isArray(order.items) && order.items.length > 0) {
    return order.items.reduce((sum, item) => {
      if (sellerId && item.sellerId && item.sellerId !== sellerId) return sum;
      const line = item.lineTotal ?? (item.unitPrice != null ? item.unitPrice * item.quantity : 0);
      return sum + (Number.isFinite(line) ? line : 0);
    }, 0);
  }
  return order.amount ?? 0;
}

/**
 * Units of THIS seller's products inside one order. Cancelled orders and
 * orders still awaiting the seller's confirmation contribute 0.
 */
export function orderSellerUnits(order: Order, sellerId?: string | null): number {
  if (order.status === 'cancelled' || orderAwaitingConfirmation(order)) return 0;
  if (!Array.isArray(order.items)) return 0;
  return order.items.reduce((sum, item) => {
    if (sellerId && item.sellerId && item.sellerId !== sellerId) return sum;
    return sum + item.quantity;
  }, 0);
}

/** One revenue bucket for the chart. */
export interface RevenueBucket {
  /** Short axis label ("Mon", "12", "25"). */
  label: string;
  /** Full label for tooltips ("Mon, Sep 15"). */
  fullLabel: string;
  /** Seller revenue inside the bucket. */
  value: number;
  /** Bar height as a percentage of the tallest bucket. */
  height: number;
}

export interface SellerSalesSummary {
  /** Revenue from non-cancelled orders in the window. */
  revenue: number;
  /** Every order placed in the window (any status). */
  orders: number;
  /** Units sold from non-cancelled orders. */
  productsSold: number;
  /** Cancelled orders in the window (the contract's refund stand-in). */
  refunds: number;
  /** Orders still waiting for the seller's confirmation (excluded above). */
  pending: number;
  /** Newest-first orders (the view caps how many it displays). */
  recent: Order[];
  /** Revenue chart buckets, oldest → newest. */
  series: RevenueBucket[];
  /** How many orders the figures are based on (shown under the chart). */
  basis: number;
}

/** Build the chart buckets for a range and drop the orders into them. */
function buildSeries(
  orders: Order[],
  range: SalesRange,
  sellerId: string | null,
  now: Date,
): RevenueBucket[] {
  const windows: { start: Date; end: Date; label: string; fullLabel: string }[] = [];

  if (range === '90d') {
    // 13 rolling 7-day buckets ending today — months are too coarse for a
    // 90-day window and daily bars far too dense.
    const buckets = 13;
    for (let i = 0; i < buckets; i += 1) {
      const start = startOfDay(addDays(now, -((buckets - i) * 7 - 1)));
      const end = i === buckets - 1 ? now : startOfDay(addDays(now, -((buckets - i - 1) * 7 - 1)));
      windows.push({
        start,
        end,
        label: String(start.getDate()),
        fullLabel: start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
      });
    }
  } else {
    const days = RANGE_DAYS[range];
    for (let i = 0; i < days; i += 1) {
      const start = startOfDay(addDays(now, -(days - 1 - i)));
      const end = i === days - 1 ? now : startOfDay(addDays(start, 1));
      windows.push({
        start,
        end,
        label: range === '7d'
          ? start.toLocaleDateString(undefined, { weekday: 'short' })
          : String(start.getDate()),
        fullLabel: start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
      });
    }
  }

  const sums = windows.map(() => 0);
  for (const order of orders) {
    const created = new Date(order.createdAt).getTime();
    if (Number.isNaN(created)) continue;
    const bucket = windows.findIndex((w) => created >= w.start.getTime() && created < w.end.getTime());
    if (bucket !== -1) sums[bucket] += orderSellerAmount(order, sellerId);
  }

  const max = sums.reduce((m, value) => Math.max(m, value), 0);
  return windows.map((w, index) => ({
    label: w.label,
    fullLabel: w.fullLabel,
    value: sums[index],
    height: max > 0 ? Math.max(2, Math.round((sums[index] / max) * 100)) : 0,
  }));
}

/** Compute the whole summary for one window from its orders. */
export function computeSellerSales(
  orders: Order[],
  options: { range: SalesRange; sellerId?: string | null; now?: Date },
): SellerSalesSummary {
  const now = options.now ?? new Date();
  const sellerId = options.sellerId ?? null;
  const sorted = [...orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    revenue: sorted.reduce((sum, order) => sum + orderSellerAmount(order, sellerId), 0),
    orders: sorted.length,
    productsSold: sorted.reduce((sum, order) => sum + orderSellerUnits(order, sellerId), 0),
    refunds: sorted.filter((order) => order.status === 'cancelled').length,
    pending: sorted.filter((order) => orderAwaitingConfirmation(order)).length,
    recent: sorted.slice(0, 5),
    series: buildSeries(sorted, options.range, sellerId, now),
    basis: sorted.length,
  };
}

/** Percentage change vs the previous period; null when there is no baseline. */
export function trendPercent(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

export interface SellerSales {
  /** Current-window summary (zeros while loading). */
  summary: SellerSalesSummary;
  /** Previous-window summary for the trends; null until it has loaded. */
  previous: SellerSalesSummary | null;
  /** True until BOTH windows have loaded at least once. */
  isLoading: boolean;
  /** True while a refresh (background or manual) is in flight. */
  isFetching: boolean;
  isError: boolean;
  error: ApiError | null;
  refetch: () => void;
  /** True when the current window genuinely has no orders. */
  isEmpty: boolean;
}

/**
 * Everything the Sales Analytics page renders, computed from real orders.
 * Current and previous windows load independently; the previous window only
 * feeds the trends, so a missing previous period degrades to "no previous
 * data" instead of a fake percentage.
 */
export function useSellerSales(range: SalesRange): SellerSales {
  const { data: user } = useCurrentUser();
  const sellerId = user?.id ?? null;
  const windows = useMemo(() => analyticsWindows(range), [range]);

  const currentQuery = useSellerOrders({ since: windows.since, until: windows.until });
  const previousQuery = useSellerOrders({ since: windows.prevSince, until: windows.prevUntil });

  const summary = useMemo(
    () => computeSellerSales(currentQuery.data ?? [], { range, sellerId }),
    [currentQuery.data, range, sellerId],
  );
  const previous = useMemo(
    () => (previousQuery.data ? computeSellerSales(previousQuery.data, { range, sellerId }) : null),
    [previousQuery.data, range, sellerId],
  );

  const isError = currentQuery.isError;
  const error = currentQuery.error ?? null;

  return {
    summary,
    previous,
    isLoading: currentQuery.isLoading || previousQuery.isLoading,
    isFetching: currentQuery.isFetching || previousQuery.isFetching,
    isError,
    error,
    refetch: () => {
      void currentQuery.refetch();
      void previousQuery.refetch();
    },
    isEmpty: !currentQuery.isLoading && !isError && summary.orders === 0,
  };
}