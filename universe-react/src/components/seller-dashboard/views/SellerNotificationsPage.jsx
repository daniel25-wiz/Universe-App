import { useMemo, useState } from 'react';
import Sidebar from '../Sidebar';
import SellerNotifications from '../ui/SellerNotifications';
import { useCurrentUser } from '../../../hooks/useAuth';
import {
  orderAwaitingConfirmation,
  useConfirmSellerOrder,
  useSellerNotificationFeed,
} from '../../../hooks/useSellerAnalytics';
import { formatMoney, timeAgo } from '../../../lib/user';
import MaterialIcon from '../../../components/ui/MaterialIcon';
import '../seller-dashboard.css';
import './seller-notifications-page.css';

/** Format the seller's product names for a notification preview. */
function formatProductNames(names) {
  if (names.length === 0) return 'your product';
  if (names.length === 1) return `"${names[0]}"`;
  if (names.length === 2) return `"${names[0]}" and "${names[1]}"`;
  return `"${names[0]}", "${names[1]}" and ${names.length - 2} more`;
}

/**
 * Full notification feed reached from the bell's "View all notifications"
 * link. New order requests stay at the top, followed by a preview of the
 * orders the seller has already handled (confirmed or cancelled).
 *
 * The feed shares the `seller-orders` query prefix, so confirming an order
 * here immediately moves it from "New" to "Previous" and refreshes the
 * dashboard figures as well.
 */
function SellerNotificationsPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');

  const { data: user } = useCurrentUser();
  const { data: orders, isLoading, isError, error } = useSellerNotificationFeed(50);
  const confirm = useConfirmSellerOrder();

  const notifications = useMemo(() => {
    const sellerId = user?.id ?? null;
    return (orders ?? []).map((order) => {
      const lines = Array.isArray(order.items) ? order.items : [];
      const own = sellerId
        ? lines.filter((line) => !line.sellerId || line.sellerId === sellerId)
        : lines;
      const names = own.map((line) => line.productName).filter(Boolean);
      const quantity = own.reduce((sum, line) => sum + (line.quantity ?? 0), 0);
      const value = own.reduce((sum, line) => {
        const lineTotal = line.lineTotal ?? (line.unitPrice != null ? line.unitPrice * line.quantity : 0);
        return sum + (Number.isFinite(lineTotal) ? lineTotal : 0);
      }, 0);
      return {
        order,
        names,
        quantity,
        value,
        pending: orderAwaitingConfirmation(order),
        cancelled: order.status === 'cancelled',
      };
    }).sort((a, b) => {
      // New requests first, then newest-first previous notifications.
      if (a.pending !== b.pending) return a.pending ? -1 : 1;
      return String(b.order.createdAt).localeCompare(String(a.order.createdAt));
    });
  }, [orders, user?.id]);

  const term = query.trim().toLowerCase();
  const visible = term
    ? notifications.filter(({ order, names }) => (
      [order.buyerName, order.reference, ...names]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(term)
    ))
    : notifications;

  const newOnes = visible.filter((item) => item.pending);
  const previous = visible.filter((item) => !item.pending);
  const pendingCount = notifications.filter((item) => item.pending).length;
  const busyId = confirm.isPending ? confirm.variables : null;

  const renderRow = ({ order, names, quantity, value, pending, cancelled }) => {
    const isBusy = busyId === order.id;
    const title = pending
      ? 'New order for'
      : cancelled
        ? 'Order cancelled for'
        : 'Order confirmed for';

    return (
      <div key={order.id} className={`nf-row${pending ? ' is-new' : ''}`}>
        <div className={`nf-icon${pending ? ' is-new' : ''}${cancelled ? ' is-cancelled' : ''}`}>
          <MaterialIcon name={pending ? 'shopping_bag' : cancelled ? 'close' : 'check_circle'} />
        </div>

        <div className="nf-body">
          <p className="nf-title">
            {title} <strong>{formatProductNames(names)}</strong>
          </p>
          <p className="nf-meta">
            {order.buyerName || 'Customer'}
            {quantity > 0 ? ` · ${quantity} item${quantity === 1 ? '' : 's'}` : ''}
            {' · '}
            {formatMoney(value)}
          </p>
          <p className="nf-time">
            {order.reference ? `#${order.reference} · ` : ''}
            {timeAgo(order.createdAt)}
          </p>
        </div>

        <div className="nf-right">
          <span className={`nf-status${pending ? ' is-pending' : cancelled ? ' is-cancelled' : ' is-confirmed'}`}>
            {pending ? 'Awaiting confirmation' : cancelled ? 'Cancelled' : 'Confirmed'}
          </span>
          {pending && (
            <button
              type="button"
              className="nf-confirm"
              onClick={() => confirm.mutate(order.id)}
              disabled={isBusy}
            >
              <MaterialIcon name={isBusy ? 'refresh' : 'check_circle'} />
              {isBusy ? 'Confirming…' : 'Confirm order'}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <Sidebar active="notifications" mobileOpen={menuOpen} onMobileClose={() => setMenuOpen(false)} />

      <main className="sd-main">
        {/* TopAppBar */}
        <header className="sd-topbar">
          <div className="sd-topbar-left">
            <button className="sd-topbar-menu" aria-label="Open menu" onClick={() => setMenuOpen(true)}>
              <MaterialIcon name="menu" />
            </button>
            <div className="sd-top-search">
              <MaterialIcon name="search" />
              <input
                type="text"
                placeholder="Search notifications..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <div className="sd-topbar-actions">
            <SellerNotifications variant="standard" />
            <button className="sd-icon-btn" aria-label="Account">
              <MaterialIcon name="account_circle" />
            </button>
          </div>
        </header>

        {/* Page Content */}
        <div className="sd-page">
          <div className="nf-header">
            <div>
              <h1 className="sd-page-title">Notifications</h1>
              <p className="sd-page-sub">
                New order requests and a preview of your previous orders.
              </p>
            </div>
            {pendingCount > 0 && (
              <span className="nf-pending-pill">
                <MaterialIcon name="notifications" />
                {pendingCount} awaiting confirmation
              </span>
            )}
          </div>

          {isError ? (
            <div className="nf-state">
              <MaterialIcon name="warning" />
              <p>We could not load your notifications.</p>
              <small>{error?.message || 'Check your connection and try again.'}</small>
            </div>
          ) : isLoading ? (
            <div className="nf-state">
              <MaterialIcon name="notifications" />
              <p>Loading notifications…</p>
            </div>
          ) : notifications.length === 0 ? (
            <div className="nf-state">
              <MaterialIcon name="check_circle" />
              <p>You have no order notifications yet.</p>
              <small>New buyer orders will appear here.</small>
            </div>
          ) : visible.length === 0 ? (
            <div className="nf-state">
              <MaterialIcon name="search" />
              <p>No notifications match “{query}”.</p>
              <small>Try a product name, buyer or order reference.</small>
            </div>
          ) : (
            <>
              <section className="nf-group">
                <div className="nf-group-head">
                  <h2 className="nf-group-title">New order requests</h2>
                  <span className="nf-count">{newOnes.length}</span>
                </div>
                <div className="nf-panel">
                  {newOnes.length > 0 ? (
                    newOnes.map(renderRow)
                  ) : (
                    <p className="nf-group-empty">No orders waiting for confirmation.</p>
                  )}
                </div>
              </section>

              <section className="nf-group">
                <div className="nf-group-head">
                  <h2 className="nf-group-title">Previous orders</h2>
                  <span className="nf-count">{previous.length}</span>
                </div>
                <div className="nf-panel">
                  {previous.length > 0 ? (
                    previous.map(renderRow)
                  ) : (
                    <p className="nf-group-empty">No previous orders yet.</p>
                  )}
                </div>
              </section>
            </>
          )}

          {confirm.isError && (
            <p className="nf-error" role="alert">
              {confirm.error?.message || 'Could not confirm that order. Please try again.'}
            </p>
          )}
        </div>
      </main>
    </>
  );
}

export default SellerNotificationsPage;
