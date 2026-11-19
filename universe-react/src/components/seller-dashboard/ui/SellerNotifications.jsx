import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCurrentUser } from '../../../hooks/useAuth';
import {
  useConfirmSellerOrder,
  useSellerPendingOrders,
} from '../../../hooks/useSellerAnalytics';
import { formatMoney, timeAgo } from '../../../lib/user';
import MaterialIcon from '../../../components/ui/MaterialIcon';
import './seller-notifications.css';

/** Format the seller's product names for the confirmation message. */
function formatProductNames(names) {
  if (names.length === 0) return 'your product';
  if (names.length === 1) return `"${names[0]}"`;
  if (names.length === 2) return `"${names[0]}" and "${names[1]}"`;
  return `"${names[0]}", "${names[1]}" and ${names.length - 2} more`;
}

/**
 * Dashboard notification bell for seller order confirmations.
 *
 * A buyer's order does NOT count as revenue until the seller confirms it was
 * actually made. This bell shows a badge for every pending order and opens a
 * dropdown that names the product(s), the buyer and the order value, with a
 * "Confirm order" action. Confirming refreshes the pending list AND the Sales
 * Analytics figures through the shared `seller-orders` query prefix.
 */
function SellerNotifications({ variant = 'overview', autoOpen = false }) {
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef(null);
  const lastCountRef = useRef(null);
  const prevCountRef = useRef(0);

  const { data: user } = useCurrentUser();
  const { data: orders, isLoading, isError } = useSellerPendingOrders();
  const confirm = useConfirmSellerOrder();
  const pending = orders ?? [];

  // Open the dropdown automatically when pending orders appear (or increase)
  // so the seller immediately sees the confirmation request. Closing it is
  // respected until another new order arrives.
  useEffect(() => {
    if (!autoOpen) return;
    const count = pending.length;
    if (lastCountRef.current === null) {
      lastCountRef.current = count;
      if (count > 0) setOpen(true);
      return;
    }
    if (count > lastCountRef.current) setOpen(true);
    lastCountRef.current = count;
  }, [autoOpen, pending.length]);

  // Keep the one-at-a-time preview in range. A new order arrives at the top
  // (newest first), so jump back to it; confirming the current order simply
  // clamps to the last remaining notification.
  useEffect(() => {
    const count = pending.length;
    setActiveIndex((index) => (
      count > prevCountRef.current ? 0 : Math.min(index, Math.max(0, count - 1))
    ));
    prevCountRef.current = count;
  }, [pending.length]);

  // Anchor the dropdown to the bell, but keep the whole panel inside the main
  // column so it can never slide under the fixed sidebar or off-screen. The
  // topbar sits below the sidebar in the stacking order, so a panel that
  // overflowed into it would be clipped.
  useLayoutEffect(() => {
    if (!open) {
      setPanelPos(null);
      return undefined;
    }

    const place = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const main = wrap.closest('.dh-main, .sd-main');
      const mainRect = main?.getBoundingClientRect();
      const bar = wrap.closest('header');
      const barBottom = bar?.getBoundingClientRect().bottom ?? rect.bottom;

      const viewportPadding = 12;
      const minLeft = (mainRect ? mainRect.left : 0) + 8;
      const maxLeft = window.innerWidth - viewportPadding;
      const width = Math.max(
        240,
        Math.min(
          380,
          (mainRect ? mainRect.width : window.innerWidth) - 16,
          window.innerWidth - viewportPadding * 2,
        ),
      );

      // Prefer right-aligning to the bell; fall back to left-aligning when
      // there is not enough room between the main column edge and the bell.
      let left = rect.right - width;
      if (left < minLeft) left = rect.left;
      left = Math.max(minLeft, Math.min(left, maxLeft - width));

      setPanelPos({
        top: Math.max(rect.bottom, barBottom) + 10,
        left,
        width,
      });
    };

    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onMouseDown = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const items = useMemo(
    () => (orders ?? []).map((order) => {
      const lines = Array.isArray(order.items) ? order.items : [];
      const own = user?.id ? lines.filter((line) => !line.sellerId || line.sellerId === user.id) : lines;
      const names = own.map((line) => line.productName).filter(Boolean);
      const quantity = own.reduce((sum, line) => sum + (line.quantity ?? 0), 0);
      const value = own.reduce((sum, line) => {
        const lineTotal = line.lineTotal ?? (line.unitPrice != null ? line.unitPrice * line.quantity : 0);
        return sum + (Number.isFinite(lineTotal) ? lineTotal : 0);
      }, 0);
      return { order, names, quantity, value };
    }),
    [orders, user?.id],
  );

  const count = pending.length;
  const busyId = confirm.isPending ? confirm.variables : null;
  const activeItem = items[activeIndex] ?? items[0];

  return (
    <div className={`sn-wrap${variant === 'overview' ? ' sn-wrap--overview' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className={variant === 'overview' ? 'sn-bell sn-bell--overview' : 'sd-icon-btn sn-bell sn-bell--standard'}
        onClick={() => setOpen((value) => !value)}
        aria-label={count > 0
          ? `Notifications, ${count} order${count === 1 ? '' : 's'} awaiting confirmation`
          : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <MaterialIcon name="notifications" fill={count > 0} />
        {count > 0 && <span className="sn-badge">{count > 9 ? '9+' : count}</span>}
      </button>

      {open && (
        <div
          className="sn-panel"
          role="dialog"
          aria-label="Order notifications"
          style={panelPos
            ? { top: panelPos.top, left: panelPos.left, width: panelPos.width }
            : { visibility: 'hidden' }}
        >
          <div className="sn-head">
            <div className="sn-head-text">
              <p className="sn-title">Order notifications</p>
              <p className="sn-sub">
                {isLoading
                  ? 'Checking for new orders…'
                  : count > 0
                    ? `${count} order${count === 1 ? '' : 's'} awaiting your confirmation`
                    : 'You are all caught up'}
              </p>
            </div>
            <button
              type="button"
              className="sn-close"
              onClick={() => setOpen(false)}
              aria-label="Close notifications"
            >
              <MaterialIcon name="close" />
            </button>
          </div>

          {isError ? (
            <div className="sn-empty">
              <MaterialIcon name="warning" />
              <p>We could not load your notifications.</p>
              <small>Check your connection and try again.</small>
            </div>
          ) : isLoading && count === 0 ? (
            <div className="sn-empty">
              <MaterialIcon name="notifications" />
              <p>Checking for new orders…</p>
            </div>
          ) : count === 0 ? (
            <div className="sn-empty">
              <MaterialIcon name="check_circle" />
              <p>No orders waiting for confirmation</p>
              <small>New buyer orders will appear here.</small>
            </div>
          ) : (
            <>
              {count > 1 && (
                <div className="sn-pager">
                  <button
                    type="button"
                    className="sn-pager-btn"
                    onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}
                    disabled={activeIndex === 0}
                    aria-label="Previous notification"
                  >
                    <MaterialIcon name="arrow_back" />
                  </button>
                  <span className="sn-pager-count">
                    {activeIndex + 1} of {count}
                  </span>
                  <button
                    type="button"
                    className="sn-pager-btn"
                    onClick={() => setActiveIndex((index) => Math.min(count - 1, index + 1))}
                    disabled={activeIndex >= count - 1}
                    aria-label="Next notification"
                  >
                    <MaterialIcon name="arrow_forward" />
                  </button>
                </div>
              )}

              <div className="sn-list" aria-live="polite">
                {activeItem && (
                  <div key={activeItem.order.id} className="sn-item">
                    <div className="sn-item-icon">
                      <MaterialIcon name="shopping_bag" />
                    </div>
                    <div className="sn-item-body">
                      <p className="sn-item-text">
                        New order for <strong>{formatProductNames(activeItem.names)}</strong>
                      </p>
                      <p className="sn-item-meta">
                        {activeItem.order.buyerName || 'Customer'}
                        {activeItem.quantity > 0
                          ? ` · ${activeItem.quantity} item${activeItem.quantity === 1 ? '' : 's'}`
                          : ''}
                        {' · '}
                        {formatMoney(activeItem.value)}
                      </p>
                      <p className="sn-item-time">
                        {activeItem.order.reference ? `#${activeItem.order.reference} · ` : ''}
                        {timeAgo(activeItem.order.createdAt)}
                      </p>
                      <button
                        type="button"
                        className="sn-confirm"
                        onClick={() => confirm.mutate(activeItem.order.id)}
                        disabled={busyId === activeItem.order.id}
                      >
                        <MaterialIcon
                          name={busyId === activeItem.order.id ? 'refresh' : 'check_circle'}
                        />
                        {busyId === activeItem.order.id ? 'Confirming…' : 'Confirm order'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {confirm.isError && (
            <p className="sn-error" role="alert">
              {confirm.error?.message || 'Could not confirm that order. Please try again.'}
            </p>
          )}

          <div className="sn-foot">
            <p>Orders count toward revenue and products sold only after you confirm them.</p>
            <div className="sn-foot-links">
              <Link to="/seller/notifications" className="sn-foot-link" onClick={() => setOpen(false)}>
                View all notifications
                <MaterialIcon name="arrow_forward" />
              </Link>
              <Link to="/seller/sales" className="sn-foot-link" onClick={() => setOpen(false)}>
                Open Sales
                <MaterialIcon name="arrow_forward" />
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default SellerNotifications;
