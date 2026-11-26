import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCurrentUser } from '../../../hooks/useAuth';
import { useInfiniteProducts } from '../../../hooks/useProducts';
import {
  Icon,
  MobileFrame,
  ProductCard,
  ProductGridSkeleton,
} from '../../marketplace/MobileMarketplaceShell';

const CATEGORIES = ['All', 'Fashion', 'Electronics', 'Gadgets', 'Books', 'Others'];
const MARKETPLACE_BANNERS = [
  '/ads1.jpg',
  '/ads2.jpg',
  '/ads3.jpg',
];

/**
 * Listings fetched per request. The catalog can outgrow one page (every seller
 * may list up to MARKETPLACE_LISTING_LIMIT products), so the grid renders page
 * one and "Load more" appends the next page — previously page one was all a
 * buyer could ever see, which hid freshly added products entirely.
 */
const PAGE_SIZE = 40;

/**
 * Scroll offset is remembered across the marketplace → product → back trip.
 * The route unmounts while a product is open, and the shell scrolls an inner
 * <main>, so the browser's own scroll restoration cannot help here.
 */
const SCROLL_STORAGE_KEY = 'universe.marketplace.scrollTop';
const CATEGORY_STORAGE_KEY = 'universe.marketplace.category';
const SEARCH_STORAGE_KEY = 'universe.marketplace.search';

function PublicMarketplace({ cartItems = [], savedProducts = [], onToggleSaved, onAddToCart }) {
  const navigate = useNavigate();
  const { data: user } = useCurrentUser();
  const [activeCategory, setActiveCategory] = useState(() => {
    const saved = window.sessionStorage.getItem(CATEGORY_STORAGE_KEY);
    return saved && CATEGORIES.includes(saved) ? saved : 'All';
  });
  const [search, setSearch] = useState(() => window.sessionStorage.getItem(SEARCH_STORAGE_KEY) ?? '');
  const [activeBanner, setActiveBanner] = useState(0);
  const bannerRef = useRef(null);
  const prefetchTriggerRef = useRef(null);
  const isFetchingRef = useRef(false);
  const scrollRef = useRef(null);
  const previousFiltersRef = useRef({ search: search.trim(), category: activeCategory });
  
  const trimmedSearch = search.trim();
  const isFiltered = Boolean(trimmedSearch) || activeCategory !== 'All';
  const {
    data: catalog,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteProducts({
    featured: true,
    status: 'active',
    search: trimmedSearch || undefined,
    category: activeCategory === 'All' ? undefined : activeCategory,
    pageSize: PAGE_SIZE,
  });
  const products = (catalog?.pages ?? []).flatMap((page) => page.items);
  const catalogTotal = catalog?.pages[0]?.total ?? products.length;
  const savedIds = new Set(savedProducts.map((product) => product.id));
  const displayProducts = products;

  const submitSearch = (event) => {
    event.preventDefault();
    navigate(`/marketplace/search${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`);
  };

  // Remember the chosen filters for the session so returning from a product
  // restores the same list instead of silently resetting to "All".
  useEffect(() => {
    window.sessionStorage.setItem(CATEGORY_STORAGE_KEY, activeCategory);
  }, [activeCategory]);

  useEffect(() => {
    window.sessionStorage.setItem(SEARCH_STORAGE_KEY, search);
  }, [search]);

  // A new filter starts at the top — the old offset belongs to another list.
  // The query key already includes the filters, so changing them starts a
  // fresh infinite query on its own; no cache reset is needed.
  useEffect(() => {
    const previous = previousFiltersRef.current;
    if (previous.search === trimmedSearch && previous.category === activeCategory) return;
    previousFiltersRef.current = { search: trimmedSearch, category: activeCategory };
    const container = scrollRef.current;
    if (container) container.scrollTop = 0;
    window.sessionStorage.setItem(SCROLL_STORAGE_KEY, '0');
  }, [trimmedSearch, activeCategory]);

  // Restore the scroll offset when the buyer comes back from a product page.
  // Runs on mount and retries for a few seconds because the grid may still be
  // laying out (or fetching) when the first frame lands. No ref/guard here:
  // StrictMode double-invokes mount effects, and a guard would let the first
  // cleanup cancel the only scheduled restore.
  useEffect(() => {
    const container = scrollRef.current;
    const initial = Number(window.sessionStorage.getItem(SCROLL_STORAGE_KEY));
    if (!container || !Number.isFinite(initial) || initial <= 0) return undefined;

    const deadline = performance.now() + 5000;
    let frame = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
    };
    const restore = () => {
      if (stopped || !container.isConnected) return;
      // Re-read each frame: a filter change writes 0 and must win.
      const saved = Number(window.sessionStorage.getItem(SCROLL_STORAGE_KEY));
      if (!Number.isFinite(saved) || saved <= 0) return;
      container.scrollTop = saved;
      if (Math.abs(container.scrollTop - saved) > 1 && performance.now() < deadline) {
        frame = window.requestAnimationFrame(restore);
      }
    };

    frame = window.requestAnimationFrame(restore);
    // A real scroll means the buyer took over — never yank them back.
    container.addEventListener('wheel', stop, { passive: true, once: true });
    container.addEventListener('touchstart', stop, { passive: true, once: true });
    container.addEventListener('keydown', stop, { once: true });
    return () => {
      window.cancelAnimationFrame(frame);
      container.removeEventListener('wheel', stop);
      container.removeEventListener('touchstart', stop);
      container.removeEventListener('keydown', stop);
    };
  }, []);

  // Remember the position while scrolling. The write happens synchronously so
  // the latest offset is already stored when a tap navigates to a product; a
  // cleanup write would run after React detaches the node and read 0.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return undefined;
    const onScroll = () => window.sessionStorage.setItem(SCROLL_STORAGE_KEY, String(container.scrollTop));
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  // Banner carousel auto-advance
  useEffect(() => {
    const timer = window.setInterval(() => {
      setActiveBanner((current) => (current + 1) % MARKETPLACE_BANNERS.length);
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  // Banner scroll behavior
  useEffect(() => {
    const track = bannerRef.current;
    const slide = track?.children[activeBanner];
    // Scroll only the banner track itself (horizontal). scrollIntoView() would
    // also scroll the page's vertical container, yanking the user back to the
    // top every time the carousel auto-advances.
    if (track && slide) track.scrollTo({ left: slide.offsetLeft, behavior: 'smooth' });
  }, [activeBanner]);

  // Prefetch next page when user reaches ~50% of current products
  useEffect(() => {
    // Track fetching state to prevent duplicate requests
    isFetchingRef.current = isFetchingNextPage;
  }, [isFetchingNextPage]);

  useEffect(() => {
    const trigger = prefetchTriggerRef.current;
    if (!trigger || isLoading || !hasNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        // Trigger prefetch when the 50% marker becomes visible
        // Only if we're not already fetching and there's a next page
        if (entry.isIntersecting && !isFetchingRef.current && hasNextPage) {
          fetchNextPage();
        }
      },
      {
        root: null,
        rootMargin: '0px',
        threshold: 0,
      }
    );

    observer.observe(trigger);
    return () => observer.disconnect();
  }, [displayProducts.length, hasNextPage, isLoading, fetchNextPage]);

  // Sellers browsing the public marketplace get a quick way back into the
  // dashboard (buyers and guests never see this row). Linking instead of
  // navigate(-1) makes the destination predictable no matter how the seller
  // reached the marketplace.
  const isSeller = user?.accountType === 'seller';

  return <MobileFrame active="home" cartCount={cartItems.reduce((total, item) => total + item.quantity, 0)}>
    <main className="mm-scroll mm-discover" ref={scrollRef}>
      <section className="mm-discover-heading">
        <h1>Discover</h1>
        {isSeller && (
          <Link to="/seller" className="mm-seller-back">
            <Icon name="arrowBack" />
            <span>Back to dashboard</span>
          </Link>
        )}
      </section>
      <form className="mm-search-row" onSubmit={submitSearch}><label><Icon name="search" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search for product" /></label><button type="submit" aria-label="Search products" className="mm-filter"><Icon name="search" /></button></form>
      <section className="mm-banner-carousel" aria-label="Marketplace promotions"><div className="mm-banner-track" ref={bannerRef}>{MARKETPLACE_BANNERS.map((banner, index) => <img key={banner} src={banner} className="mm-banner-slide" alt={`Marketplace promotion ${index + 1}`} />)}</div><div className="mm-banner-dots" aria-hidden="true">{MARKETPLACE_BANNERS.map((banner, index) => <button type="button" key={banner} className={activeBanner === index ? 'active' : ''} aria-label={`Show promotion ${index + 1}`} onClick={() => setActiveBanner(index)} />)}</div></section>
      <section className="mm-categories"><div><h2>Categories</h2><button type="button">See all</button></div><div className="mm-category-scroll">{CATEGORIES.map((category) => <button type="button" key={category} className={activeCategory === category ? 'active' : ''} onClick={() => setActiveCategory(category)}>{category}</button>)}</div></section>
      {isLoading ? <ProductGridSkeleton /> : displayProducts.length ? <section className="mm-product-grid">{displayProducts.map((product, index) => {
        // Place the prefetch trigger at approximately 50% of visible products
        const isPrefetchTrigger = index === Math.floor(displayProducts.length * 0.5);
        return (
          <div key={product.id} ref={isPrefetchTrigger ? prefetchTriggerRef : null}>
            <ProductCard product={product} saved={savedIds.has(product.id)} onToggleSaved={onToggleSaved} onAddToCart={onAddToCart} onOpen={(item) => navigate(`/marketplace/product/${item.id}`)} />
          </div>
        );
      })}</section> : <section className="mm-empty-cart mm-marketplace-empty"><Icon name="search" /><h2>{isFiltered ? 'No products match your filters' : 'No products available yet'}</h2><p>{isFiltered ? 'Try another search or category.' : 'Products will appear here when sellers publish them.'}</p></section>}
      {displayProducts.length > 0 && isFetchingNextPage && (
        <div className="mm-load-more">
          <p className="mm-loading">Loading more products...</p>
        </div>
      )}
      {displayProducts.length > 0 && hasNextPage && !isFetchingNextPage && (
        <div className="mm-load-more">
          <button type="button" onClick={() => fetchNextPage()}>
            Load more products ({displayProducts.length} of {catalogTotal})
          </button>
        </div>
      )}
    </main>
  </MobileFrame>;
}

export default PublicMarketplace;
