/**
 * Cats Luv Us site chrome for clone / staging deployments.
 *
 * Production (`catsluvus.com`) articles are wrapped by the live site consumer
 * (Universal Chrome header + category menus + footer). Staging serves raw KV
 * HTML from this Worker, so we inject a snapshot of that Universal Chrome at
 * response time.
 *
 * Snapshot source: live catsluvus.com article page header/footer (self-contained
 * CSS + markup + menu JS). Menu links point at production catsluvus.com so the
 * staging article still navigates to real site pages.
 *
 * `wrapWithSiteChrome` is a no-op when DOMAIN includes catsluvus.com.
 */

const CHROME_MARKER = "clu-header";

const CHROME_CSS = `
    /* Universal Chrome Variables */
    :root {
      --primary-color: #FF6B35;
      --primary-hover: #e55a2b;
      --text-color: #333;
      --bg-light: #f8f9fa;
      --header-height: 260px;
      --brand-blue: #1a237e;
      --brand-pink: #DF0082;
    }
    /* Prevent horizontal overflow on all devices (dvw = dynamic viewport for foldables) */
    html, body { overflow-x: hidden; max-width: 100vw; max-width: 100dvw; }
    /* Safe area insets for edge-to-edge / notch / foldable displays */
    .clu-header { padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right); }
    .clu-newsletter-banner, .clu-utilitybar, .clu-brandrow, .clu-services-bar {
      padding-left: max(var(--_pad-l, 0px), env(safe-area-inset-left));
      padding-right: max(var(--_pad-r, 0px), env(safe-area-inset-right));
    }

    /* ====== NEWSLETTER BANNER ====== */
    .clu-newsletter-banner {
      background: var(--brand-blue);
      text-align: center;
      padding: 5px 16px;
      font-family: 'Open Sans', sans-serif;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.3px;
      /* Default to flex for mobile/desktop toggle logic */
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 40px;
    }
    .clu-newsletter-banner a {
      color: #ffffff;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .clu-newsletter-banner a:hover {
      text-decoration: underline;
      opacity: 0.95;
    }
    .clu-newsletter-banner svg {
      width: 18px;
      height: 18px;
      fill: #ffffff;
      flex-shrink: 0;
    }

    /* ====== CLU HEADER ====== */
    .clu-header {
      position: relative;
      width: 100%;
      z-index: 1000;
      font-family: 'DM Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      overflow: visible;
    }

    body {
      padding-top: 0 !important;
    }

    /* Utility Bar (phone, address, social) */
    .clu-utilitybar {
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 3px 24px;
      border-bottom: 1px solid #e5e7eb;
    }
    .clu-utilitybar-inner {
      display: flex;
      align-items: center;
      justify-content: center;
      max-width: 1200px;
      width: 100%;
    }
    .clu-utilitybar-contact {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 24px;
    }
    .clu-info-item {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--brand-pink);
      font-size: 0.8rem;
      font-weight: 700;
      text-decoration: none;
      white-space: nowrap;
    }
    a.clu-info-item:hover { color: var(--brand-blue); }
    .clu-info-item svg { flex-shrink: 0; stroke: var(--brand-pink); width: 12px; height: 12px; }

    /* Social Icons (in utility bar) */
    .clu-social-icons {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .clu-social-icons a {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      color: #ffffff;
      text-decoration: none;
      transition: transform 0.15s, opacity 0.2s;
    }
    .clu-social-icons a:hover { transform: scale(1.15); opacity: 0.85; }
    .clu-social-icons a.clu-social-fb { background: #1877F2; }
    .clu-social-icons a.clu-social-ig { background: radial-gradient(circle at 30% 107%, #fdf497 0%, #fdf497 5%, #fd5949 45%, #d6249f 60%, #285AEB 90%); }
    .clu-social-icons a.clu-social-x { background: #000000; }
    .clu-social-icons a.clu-social-yt { background: #FF0000; }
    .clu-social-icons a.clu-social-tt { background: #000000; }
    .clu-social-icons a.clu-social-pin { background: #E60023; }
    .clu-social-icons a.clu-social-li { background: #0A66C2; }
    .clu-social-icons a.clu-social-email { background: #1a237e; }
    .clu-social-icons svg { width: 12px; height: 12px; fill: currentColor; }

    /* Brand Row (logo, name, search, CTAs) */
    .clu-brandrow {
      background: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 10px 24px;
    }
    .clu-brandrow-inner {
      display: flex;
      align-items: center;
      max-width: 1200px;
      width: 100%;
      gap: 60px;
      justify-content: center;
      height: 110px;
    }
    .clu-brand-h1 {
      margin: 0;
      padding: 0;
      font-size: 1.6rem;
      font-weight: 700;
      line-height: 1.2;
      flex-shrink: 0;
    }
    .clu-brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      color: var(--brand-pink);
      font-weight: 700;
      font-size: inherit;
      white-space: nowrap;
      flex-shrink: 0;
      overflow: visible;
    }
    .clu-brand:hover { color: #DF0082; }
    .clu-brand img {
      width: 100px;
      height: 100px;
      border-radius: 0;
      object-fit: contain;
      display: block;
      max-width: none;
      max-height: none;
    }
    
    /* Brand Name & Titles */
    .clu-brand-name {
      font-size: 42px;
      font-weight: 700;
      color: #DF0082;
      text-decoration: none;
      font-family: 'Playfair Display', serif;
      letter-spacing: -0.3px;
      line-height: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      text-align: center;
      white-space: nowrap;
      height: auto;
      padding: 10px 0;
    }
    .clu-brand-title {
      font-size: 42px;
      padding-bottom: 4px;
    }
    .clu-brand-subtitle {
      font-size: 26px;
      color: #1a237e;
    }

    /* Book Now Button */
    .clu-booknow-btn {
      background: #DF0082;
      color: #fff;
      border: 3px solid #1a237e;
      padding: 8px 40px;
      cursor: pointer;
      border-radius: 20px;
      white-space: nowrap;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      box-shadow: 0 6px 20px rgba(223,0,130,0.35), 0 2px 6px rgba(0,0,0,0.1);
      transition: all 0.2s ease;
      position: relative;
      overflow: hidden;
      line-height: 1.2;
      height: 85px;
    }
    .clu-booknow-btn:hover {
      transform: translateY(-2px) scale(1.02);
      box-shadow: 0 8px 28px rgba(223,0,130,0.45), 0 4px 10px rgba(0,0,0,0.12);
    }
    .clu-booknow-btn:active {
      transform: translateY(0) scale(0.98);
      box-shadow: 0 2px 8px rgba(223,0,130,0.3), 0 1px 3px rgba(0,0,0,0.1);
    }
    .clu-booknow-text-main {
      font-size: 34px;
      font-weight: 900;
      letter-spacing: 1px;
      text-shadow: 0 1px 2px rgba(0,0,0,0.2);
      font-family: 'Playfair Display', serif;
    }
    .clu-booknow-text-sub {
      font-size: 16px;
      font-weight: 500;
      color: rgba(255,255,255,0.9);
      letter-spacing: 0.3px;
    }
    .clu-booknow-text-promo {
      font-size: 13px;
      font-weight: 600;
      color: #ffd1e8;
      letter-spacing: 0.2px;
    }

    /* Class-based responsive hooks (supplement fragile [style*="..."] selectors) */
    .clu-brand-group { 
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 30px;
      flex-wrap: wrap;
      height: auto; 
    }
    .clu-brand-link { height: auto; }
    .clu-brand-logo { width: 100px; height: 100px; }
    .clu-brand-name { height: auto; }
    .clu-brand-title { font-size: 42px; }
    .clu-brand-subtitle { font-size: 26px; }
    .clu-brandrow-center {
      display: flex;
      align-items: center;
      gap: 15px;
      flex-shrink: 0;
    }
    .clu-brandrow-right {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .clu-search-form {
      flex-shrink: 0;
      width: 200px;
      min-width: 160px;
      position: relative;
    }
    .clu-search-form input {
      width: 100%;
      padding: 8px 36px 8px 14px;
      border: 1px solid #d1d5db;
      border-radius: 20px;
      font-size: 0.85rem;
      font-weight: 500;
      background: #ffffff;
      color: #333;
      outline: none;
      transition: box-shadow 0.2s;
      box-sizing: border-box;
    }
    .clu-search-form input::placeholder { color: #999; }
    .clu-search-form input:focus { box-shadow: 0 0 0 2px rgba(0,84,166,0.3); }
    .clu-search-form button {
      position: absolute;
      right: 4px;
      top: 50%;
      transform: translateY(-50%);
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px;
      display: flex;
      align-items: center;
    }
    .clu-search-form button svg { width: 18px; height: 18px; fill: #999; }
    .clu-cta-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: var(--primary-color);
      color: #fff;
      padding: 8px 16px;
      border-radius: 20px;
      text-decoration: none;
      font-weight: 600;
      font-size: 0.8rem;
      white-space: nowrap;
      transition: background 0.2s, transform 0.15s;
      flex-shrink: 0;
      min-height: 36px;
      box-sizing: border-box;
    }
    .clu-cta-btn:hover { transform: scale(1.03); }

    /* Nav Bar - PetSmart style blue */
    .clu-navbar {
      background: #1a237e;
      height: 42px;
      display: flex;
      align-items: center;
      padding: 0 24px;
      overflow: visible;
      justify-content: center;
    }
    .clu-navbar-inner {
      display: flex;
      align-items: stretch;
      max-width: 1200px;
      width: 100%;
      height: 100%;
    }
    .clu-nav-list {
      display: flex;
      list-style: none;
      margin: 0;
      padding: 0;
      gap: 0;
      height: 100%;
      align-items: stretch;
      width: 100%;
    }
    .clu-nav-item {
      position: relative;
      display: flex;
      align-items: stretch;
    }
    .clu-nav-link {
      display: flex;
      align-items: center;
      padding: 0 14px;
      color: #ffffff;
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 700;
      white-space: nowrap;
      transition: background 0.2s;
      height: 100%;
    }
    .clu-nav-link:hover,
    .clu-nav-item:hover > .clu-nav-link { background: rgba(255,255,255,0.15); color: #fff; }
    
    .clu-nav-link .arrow { margin-left: 5px; font-size: 0.55rem; transition: transform 0.2s; }
    .clu-nav-item:hover .arrow { transform: rotate(180deg); }

    /* Search Row */
    .clu-searchrow {
      background: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 10px 24px;
      border-bottom: 1px solid #e5e7eb;
    }
    .clu-searchrow-inner {
      max-width: 600px;
      width: 100%;
    }
    .clu-searchrow .clu-search-form {
      width: 100%;
    }

    /* Dropdowns */
    .clu-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      min-width: 240px;
      background: #fff;
      border-radius: 0 0 8px 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.15);
      opacity: 0;
      visibility: hidden;
      transform: translateY(-4px);
      transition: opacity 0.2s, visibility 0.2s, transform 0.2s;
      z-index: 1001;
    }
    .clu-nav-item:hover > .clu-dropdown { opacity: 1; visibility: visible; transform: translateY(0); }
    .clu-dropdown a {
      display: block;
      padding: 10px 18px;
      color: var(--text-color);
      text-decoration: none;
      font-size: 0.85rem;
      transition: background 0.15s, color 0.15s;
      border-bottom: 1px solid #f0f0f0;
    }
    .clu-dropdown a:last-child { border-bottom: none; border-radius: 0 0 8px 8px; }
    .clu-dropdown a:hover { background: #e8f0fe; color: #1f2937; }

    /* Second Nav Row (Pet Categories) */
    .clu-navbar-sub {
      background: var(--brand-blue);
      height: 42px;
      display: flex;
      align-items: center;
      padding: 0 24px;
      justify-content: center;
    }
    .clu-navbar-sub-inner {
      display: flex;
      align-items: stretch;
      max-width: 1200px;
      width: 100%;
      height: 100%;
    }
    .clu-nav-sub-list {
      display: flex;
      list-style: none;
      margin: 0;
      padding: 0;
      gap: 0;
      height: 100%;
      align-items: stretch;
    }
    .clu-nav-sub-item {
      position: relative;
      display: flex;
      align-items: stretch;
    }
    .clu-nav-sub-link {
      display: flex;
      align-items: center;
      padding: 0 14px;
      color: #ffffff;
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 600;
      white-space: nowrap;
      transition: color 0.2s, background 0.2s;
      height: 100%;
    }
    .clu-nav-sub-link:hover { color: #fff; background: rgba(255,255,255,0.1); }
    .clu-nav-sub-link.clu-sub-highlight { font-weight: 700; color: #fff; }
    .clu-nav-sub-link.clu-sub-highlight:hover { background: rgba(255,255,255,0.15); }

    /* Mega Dropdown (About Us) */
    .clu-dropdown-mega {
      display: flex;
      min-width: 600px;
      left: auto;
      right: 0;
      padding: 12px 0;
    }
    .clu-dropdown-col {
      flex: 1;
      min-width: 180px;
      padding: 0 8px;
      border-right: 1px solid #f0f0f0;
    }
    .clu-dropdown-col:last-child { border-right: none; }
    .clu-dropdown-heading {
      display: block;
      padding: 6px 18px 8px;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #1f2937;
      font-weight: 700;
    }
    .clu-dropdown-mega a { border-bottom: none; padding: 7px 18px; font-size: 0.82rem; border-radius: 4px; }
    .clu-dropdown-mega a:hover { background: #e8f0fe; }

    /* Mobile Hamburger */
    .clu-hamburger {
      display: none;
      background: none;
      border: none;
      cursor: pointer;
      padding: 8px;
      flex-direction: column;
      gap: 5px;
    }
    .clu-hamburger span {
      display: block;
      width: 22px;
      height: 2px;
      background: var(--brand-pink);
      border-radius: 1px;
      transition: transform 0.3s, opacity 0.3s;
    }
    .clu-hamburger.active span:nth-child(1) { transform: rotate(45deg) translate(5px, 5px); }
    .clu-hamburger.active span:nth-child(2) { opacity: 0; }
    .clu-hamburger.active span:nth-child(3) { transform: rotate(-45deg) translate(5px, -5px); }

    /* Mobile Menu Overlay */
    .clu-mobile-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.5);
      z-index: 999;
    }
    .clu-mobile-overlay.active { display: block; }
    .clu-mobile-menu {
      display: none;
      position: fixed;
      top: 0; right: 0; width: 300px; height: 100vh;
      background: #fff;
      z-index: 1002;
      overflow-y: auto;
      transform: translateX(100%);
      transition: transform 0.3s ease;
    }
    .clu-mobile-menu.open { transform: translateX(0); }
    .clu-mobile-menu-header {
      background: var(--brand-blue);
      color: #fff;
      padding: 16px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .clu-mobile-menu-header h3, .clu-mobile-menu-title { margin: 0; font-size: 1.1rem; font-weight: bold; }
    .clu-mobile-close {
      background: none; border: none; color: #fff; font-size: 1.5rem; cursor: pointer; padding: 4px;
    }
    .clu-mobile-search {
      padding: 12px 16px;
      border-bottom: 1px solid #eee;
    }
    .clu-mobile-search input {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 0.9rem;
    }
    .clu-mobile-nav { padding: 8px 0; }
    .clu-mobile-group { border-bottom: 1px solid #f0f0f0; }
    .clu-mobile-group-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 20px;
      font-weight: 600;
      color: #1f2937;
      cursor: pointer;
      background: none;
      border: none;
      width: 100%;
      font-size: 0.95rem;
      text-align: left;
    }
    .clu-mobile-group-title .chevron {
      font-size: 0.7rem;
      transition: transform 0.2s;
    }
    .clu-mobile-group.open .chevron { transform: rotate(180deg); }
    .clu-mobile-group-links {
      display: none;
      padding: 0 0 8px;
    }
    .clu-mobile-group.open .clu-mobile-group-links { display: block; }
    .clu-mobile-group-links a {
      display: block;
      padding: 10px 20px 10px 36px;
      color: var(--text-color);
      text-decoration: none;
      font-size: 0.875rem;
      transition: background 0.15s;
    }
    .clu-mobile-group-links a:hover { background: #e8f0fe; }
    .clu-mobile-direct-link {
      display: block;
      padding: 14px 20px;
      color: #1f2937;
      text-decoration: none;
      font-weight: 600;
      font-size: 0.95rem;
      border-bottom: 1px solid #f0f0f0;
    }
    .clu-mobile-direct-link:hover { background: #e8f0fe; }

    /* Tablet: 769px - 1024px */
    @media (max-width: 1024px) {
      .clu-brandrow { padding: 10px 16px; }
      .clu-brandrow-inner { gap: 12px; }
      .clu-search-form { max-width: 320px !important; min-width: 160px !important; }
      .clu-newsletter-banner { font-size: 14px !important; padding: 6px 16px !important; }
      .clu-newsletter-banner .clu-topbar-contact { font-size: 14px !important; gap: 12px !important; }
      .clu-brand img { width: 100px !important; height: 100px !important; }
      .clu-services-bar-inner { gap: 14px !important; font-size: 13px; }
    }

    /* Regular Desktop/Tablet Layout */
    .clu-search-desktop { display: flex; }
    .clu-search-mobile { display: none !important; }

    /* Mobile: 768px and below */
    @media (max-width: 768px) {
      /* ... */
      .clu-search-desktop { display: none !important; }
      .clu-search-mobile { display: flex !important; }
      /* ... */
      :root { --header-height: 110px; }
      /* Top banner: stack vertically */
      .clu-newsletter-banner {
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 6px 12px !important;
        gap: 4px;
      }
      .clu-newsletter-banner .clu-topbar-contact {
        font-size: 13px !important;
        gap: 8px !important;
        flex-wrap: wrap;
        justify-content: center;
      }
      /* Brand row: responsive layout */
      .clu-email-form { display: none !important; }
      .clu-topbar-search { display: flex !important; width: 100%; justify-content: center; margin: 4px 0; }
      .clu-topbar-search input { width: 100% !important; max-width: 260px !important; }
      .clu-brandrow { padding: 8px 12px !important; overflow: hidden; max-width: 100vw; max-width: 100dvw; }
      .clu-brandrow-inner { gap: 10px; max-width: 100%; height: auto !important; min-height: unset !important; justify-content: center !important; flex-wrap: wrap !important; }
      /* Override all inline heights on brand row children (class + attribute selectors) */
      .clu-brand-group, .clu-brandrow-inner > div[style*="height"] { height: auto !important; }
      .clu-brand-link, .clu-brandrow-inner > div > a[style*="height"] { height: auto !important; }
      /* Logo: 60px on tablet */
      .clu-brand-logo,
      .clu-brand img,
      .clu-brandrow-inner img[style*="width:100px"] { width: 60px !important; height: 60px !important; }
      /* Brand text: responsive (class + attribute selectors) */
      .clu-brand-name,
      .clu-brandrow-inner a[style*="font-size:42px"] { font-size: 26px !important; height: auto !important; white-space: normal !important; }
      .clu-brand-title,
      .clu-brandrow-inner a[style*="font-size:42px"] span:first-child { font-size: 26px !important; }
      .clu-brand-subtitle,
      .clu-brandrow-inner a[style*="font-size:42px"] span:last-child { font-size: 15px !important; }
      /* Book Now: smaller on tablet */
      .clu-booknow-wrapper { height: auto !important; }
      .clu-booknow-wrapper button { padding: 5px 16px !important; height: auto !important; min-height: 50px; }
      .clu-booknow-wrapper button span:first-child { font-size: 20px !important; }
      .clu-booknow-wrapper button span:nth-child(2) { font-size: 10px !important; }
      .clu-booknow-wrapper button span:nth-child(3) { display: none !important; }
      /* Nav: hamburger instead of services bar */
      .clu-hamburger { display: flex; }
      .clu-navbar { display: none; }
      .clu-mobile-menu { display: block; }
      .clu-cta-btn { display: none; }
      .clu-social-icons { display: none; }
      .clu-signin-section { display: none !important; }
      /* Services bar: HIDE on mobile - use hamburger menu instead */
      .clu-services-bar { display: none !important; }
    }

    /* Small mobile: 480px and below */
    @media (max-width: 480px) {
      .clu-newsletter-banner .clu-topbar-contact {
        font-size: 11px !important;
        gap: 6px !important;
      }
      /* Brand row: compact mobile layout */
      .clu-brandrow { padding: 6px 10px !important; }
      .clu-brandrow-inner { height: auto !important; min-height: unset !important; gap: 8px !important; flex-wrap: nowrap !important; max-width: 100vw !important; max-width: 100dvw !important; }
      .clu-brand-group, .clu-brandrow-inner > div[style*="height"] { height: auto !important; }
      .clu-brand-link, .clu-brandrow-inner > div > a[style*="height"] { height: auto !important; }
      /* Logo: 46px */
      .clu-brand-logo,
      .clu-brand img,
      .clu-brandrow-inner img[style*="width:100px"] { width: 46px !important; height: 46px !important; }
      /* Brand text: compact */
      .clu-brand-name,
      .clu-brandrow-inner a[style*="font-size:42px"] { font-size: 22px !important; height: auto !important; white-space: normal !important; gap: 1px !important; }
      .clu-brand-title,
      .clu-brandrow-inner a[style*="font-size:42px"] span:first-child { font-size: 22px !important; padding-bottom: 1px !important; }
      .clu-brand-subtitle,
      .clu-brandrow-inner a[style*="font-size:42px"] span:last-child { font-size: 12px !important; }
      /* Hide Book Now button - use hamburger menu instead */
      .clu-booknow-wrapper { display: none !important; }
      .clu-signin-section { display: none !important; }
      #cluBookNowDropdown { display: none !important; }
      /* Top banner: hide address */
      .clu-utilitybar-contact .clu-info-item:not([href^="tel"]) { display: none !important; }
      /* Touch targets */
      .clu-services-bar-inner a { min-height: 44px !important; display: inline-flex !important; align-items: center !important; }
      .clu-hamburger { min-width: 44px; min-height: 44px; justify-content: center; align-items: center; }
      /* Prevent services bar overflow */
      .clu-services-bar { max-width: 100vw !important; }
      .clu-services-bar-inner { max-width: 100% !important; }
    }

    /* Galaxy S series & small phones: 360px and below */
    @media (max-width: 360px) {
      .clu-brandrow { padding: 5px 8px !important; }
      .clu-brandrow-inner { gap: 6px !important; }
      .clu-brandrow-inner > div[style*="gap"] { gap: 6px !important; }
      /* Logo: 40px */
      .clu-brand-logo,
      .clu-brand img,
      .clu-brandrow-inner img[style*="width:100px"] { width: 40px !important; height: 40px !important; }
      /* Brand text: smaller */
      .clu-brand-name,
      .clu-brandrow-inner a[style*="font-size:42px"] { font-size: 18px !important; gap: 0px !important; }
      .clu-brand-title,
      .clu-brandrow-inner a[style*="font-size:42px"] span:first-child { font-size: 18px !important; padding-bottom: 0px !important; }
      .clu-brand-subtitle,
      .clu-brandrow-inner a[style*="font-size:42px"] span:last-child { font-size: 11px !important; }
      .clu-booknow-wrapper { display: none !important; }
      .clu-newsletter-banner { padding: 4px 8px !important; }
      .clu-newsletter-banner .clu-topbar-contact { font-size: 10px !important; }
      .clu-services-bar-inner { gap: 12px !important; padding: 0 8px !important; }
      .clu-services-bar-inner a { font-size: 12px !important; min-height: 44px !important; }
      /* Global content overflow prevention */
      .page-content, [class*="container"] { padding-left: 12px !important; padding-right: 12px !important; }
      img { max-width: 100% !important; height: auto !important; }
      .clu-mobile-menu { width: 85vw !important; max-width: 300px; }
    }

    /* Galaxy Z Fold 5/6 folded & Z Flip cover: 320px and below (Z Fold 7 cover is ~360-412px — handled by 480px/360px breakpoints above) */
    @media (max-width: 320px) {
      .clu-brandrow { padding: 4px 6px !important; }
      .clu-brand-logo, .clu-brand img { width: 40px !important; height: 40px !important; }
      .clu-brand-name, .clu-brandrow-inner a[style*="font-size:42px"] { font-size: 18px !important; }
      .clu-brand-title, .clu-brandrow-inner a[style*="font-size:42px"] span:first-child { font-size: 18px !important; }
      .clu-brand-subtitle, .clu-brandrow-inner a[style*="font-size:42px"] span:last-child { font-size: 11px !important; }
      .clu-booknow-wrapper { display: none !important; }
      .clu-services-bar { display: none !important; }
      .clu-newsletter-banner { font-size: 10px !important; padding: 3px 6px !important; }
      .clu-newsletter-banner .clu-topbar-contact { display: none !important; }
      .clu-utilitybar { padding: 2px 6px !important; }
      .clu-utilitybar-contact { gap: 8px !important; }
      .clu-info-item { font-size: 0.7rem !important; }
      .clu-mobile-menu { width: 90vw !important; max-width: 280px; }
      #cluBookNowDropdown { width: 220px !important; right: 0 !important; }
      .footer-grid { grid-template-columns: 1fr !important; gap: 20px !important; }
      .related-articles-grid { grid-template-columns: 1fr !important; }
    }

    /* Galaxy Z Fold 5/6 outer screen minimum: 280px and below */
    @media (max-width: 280px) {
      .clu-brandrow { padding: 3px 4px !important; }
      .clu-brandrow-inner { gap: 4px !important; justify-content: space-between !important; }
      .clu-brand-logo, .clu-brand img { width: 36px !important; height: 36px !important; }
      .clu-brand-subtitle, .clu-brandrow-inner a[style*="font-size:42px"] span:last-child { display: none !important; }
      .clu-brand-title, .clu-brandrow-inner a[style*="font-size:42px"] span:first-child { font-size: 16px !important; }
      .clu-newsletter-banner { display: none !important; }
      .clu-utilitybar { display: none !important; }
      .clu-mobile-menu { width: 95vw !important; max-width: 260px; }
      .clu-mobile-menu-header { padding: 12px 14px !important; }
      .clu-mobile-group-title { padding: 12px 14px !important; font-size: 0.85rem !important; }
      .clu-mobile-group-links a { padding: 8px 14px 8px 28px !important; font-size: 0.8rem !important; }
      .clu-mobile-direct-link { padding: 12px 14px !important; font-size: 0.85rem !important; }
    }

    /* Galaxy Z Flip flex mode (half-folded) - very short viewport */
    @media (max-height: 450px) and (max-width: 400px) {
      .clu-newsletter-banner { display: none !important; }
      .clu-utilitybar { display: none !important; }
      .clu-brandrow { padding: 4px 8px !important; }
      .clu-brandrow-inner { height: auto !important; min-height: 40px; }
      .clu-brandrow-inner > div:first-child { height: auto !important; }
      .clu-brandrow-inner > div:first-child > a:first-child { height: auto !important; }
      .clu-brand img { width: 36px !important; height: 36px !important; }
      .clu-brandrow-inner a[style*="font-size:42px"] { font-size: 18px !important; height: auto !important; }
      .clu-brandrow-inner a[style*="font-size:42px"] span:first-child { font-size: 18px !important; }
      .clu-brandrow-inner a[style*="font-size:42px"] span:last-child { font-size: 11px !important; }
      .clu-booknow-wrapper { height: auto !important; }
      .clu-booknow-wrapper button { height: auto !important; min-height: 36px; padding: 2px 12px !important; }
      .clu-booknow-wrapper button span:first-child { font-size: 14px !important; }
      .clu-booknow-wrapper button span:nth-child(2) { display: none !important; }
      .clu-booknow-wrapper button span:nth-child(3) { display: none !important; }
      .clu-services-bar { padding: 4px 0 !important; }
      .clu-services-bar-inner a { font-size: 11px !important; min-height: 36px !important; }
      .clu-email-form { display: none !important; }
      .clu-mobile-menu { max-height: 100vh; overflow-y: auto; }
    }

    /* Galaxy Z Fold 5/6 unfolded (tablet-like ~586px wide) */
    @media (min-width: 480px) and (max-width: 600px) {
      .clu-brandrow-inner { gap: 10px !important; height: auto !important; }
      .clu-brandrow-inner > div:first-child { height: auto !important; }
      .clu-brandrow-inner > div:first-child > a:first-child { height: auto !important; }
      .clu-brand img { width: 60px !important; height: 60px !important; }
      .clu-brandrow-inner a[style*="font-size:42px"] { font-size: 28px !important; height: auto !important; }
      .clu-brandrow-inner a[style*="font-size:42px"] span:first-child { font-size: 28px !important; }
      .clu-brandrow-inner a[style*="font-size:42px"] span:last-child { font-size: 16px !important; }
      .clu-booknow-wrapper { height: auto !important; }
      .clu-booknow-wrapper button { height: auto !important; min-height: 44px; padding: 6px 20px !important; }
      .clu-booknow-wrapper button span:first-child { font-size: 20px !important; }
      .clu-booknow-wrapper button span:nth-child(2) { font-size: 10px !important; }
      .clu-booknow-wrapper button span:nth-child(3) { display: none !important; }
    }

    /* Galaxy Z Fold 7 unfolded (large inner display ~752-912px wide, near-square ~1.1:1 aspect ratio) */
    @media (min-width: 700px) and (max-width: 920px) {
      :root { --header-height: 140px; }
      /* Ensure banner uses Flex center on desktop/fold */
      .clu-newsletter-banner { 
        display: flex !important; 
        justify-content: center !important;
        align-items: center !important;
        gap: 40px !important;
        flex-direction: row !important; /* Override potential flex-col from mobile */
        padding: 8px 16px !important;
      }
      .clu-search-mobile { display: none !important; }
      .clu-search-desktop { display: flex !important; }
      .clu-brandrow { padding: 8px 16px !important; }
      .clu-brandrow-inner { gap: 40px !important; height: auto !important; justify-content: center !important; }
      .clu-brandrow-inner > div:first-child { height: auto !important; }
      .clu-brandrow-inner > div:first-child > a:first-child { height: auto !important; }
      /* Logo removed, rules deleted */
      .clu-brand-name { font-size: 32px !important; height: auto !important; }
      .clu-brand-name .clu-brand-title { font-size: 32px !important; }
      .clu-brand-name .clu-brand-subtitle { font-size: 18px !important; }
      /* Show desktop nav instead of hamburger on Fold 7 unfolded — 8" screen is big enough */
      .clu-hamburger { display: none !important; }
      .clu-mobile-menu { display: none !important; }
      .clu-navbar { display: flex !important; }
      .clu-services-bar { display: flex !important; }
      /* Book Now: visible but compact */
      .clu-booknow-wrapper { display: flex !important; height: auto !important; }
      .clu-booknow-wrapper button { height: auto !important; min-height: 44px; padding: 6px 18px !important; }
      .clu-booknow-wrapper button span:first-child { font-size: 20px !important; }
      .clu-booknow-wrapper button span:nth-child(2) { font-size: 10px !important; }
      .clu-booknow-wrapper button span:nth-child(3) { display: none !important; }
      .clu-services-bar-inner { gap: 14px !important; font-size: 13px; flex-wrap: wrap !important; white-space: normal !important; }
      .clu-social-icons { display: flex !important; }
      .clu-signin-section { display: flex !important; }
      /* Also override any attribute-selector based styles from the 768px breakpoint */
      .clu-brandrow-inner img[style*="width:100px"] { width: 70px !important; height: 70px !important; }
      .clu-brandrow-inner a[style*="font-size:42px"] { font-size: 32px !important; height: auto !important; }
      .clu-brandrow-inner a[style*="font-size:42px"] span:first-child { font-size: 32px !important; }
      .clu-brandrow-inner a[style*="font-size:42px"] span:last-child { font-size: 18px !important; }
    }

    /* Foldable Viewport Segments API: dual-pane / Flex mode / split-screen */
    @media (horizontal-viewport-segments: 2) {
      /* Device is showing content across the hinge (e.g. Z Fold 7 tabletop/book mode) */
      .clu-header {
        /* Avoid the hinge/fold gap */
        column-gap: env(viewport-segment-right 0 0, 0px);
      }
      .clu-brandrow-inner {
        /* Keep all header content on the left pane, away from the hinge */
        max-width: env(viewport-segment-width 0 0, 100%);
      }
    }
    @media (vertical-viewport-segments: 2) {
      /* Device folded in landscape "tent" mode — compact header */
      .clu-newsletter-banner { display: none !important; }
      .clu-utilitybar { display: none !important; }
      .clu-brandrow { padding: 4px 10px !important; }
      .clu-brand-logo { width: 40px !important; height: 40px !important; }
      .clu-brand-name { font-size: 20px !important; }
    }
    @media (max-width: 768px) {
      .clu-nav-link, .clu-nav-sub-link { min-height: 44px; }
      .clu-mobile-group-title { min-height: 44px; }
      .clu-mobile-group-links a { min-height: 44px; display: flex !important; align-items: center; }
      .clu-mobile-direct-link { min-height: 44px; display: flex !important; align-items: center; }
      .clu-cta-btn { min-height: 44px; }
      .clu-social-icons a { min-width: 44px; min-height: 44px; }
      .clu-hamburger { min-width: 44px; min-height: 44px; display: flex; justify-content: center; align-items: center; }
    }
    /* ====== END CLU HEADER ====== */

    /* Universal Footer */
    .universal-footer {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
      padding: 60px 20px 30px;
      margin-top: 60px;
      font-family: 'Open Sans', sans-serif;
    }
    .footer-container {
      max-width: 1200px;
      margin: 0 auto;
    }
    .footer-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 40px;
      margin-bottom: 40px;
    }
    .footer-section h3, .footer-heading {
      color: var(--primary-color);
      margin-bottom: 20px;
      font-size: 1.2rem;
      font-weight: bold;
    }
    .footer-section ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .footer-section li {
      margin-bottom: 10px;
    }
    .footer-section a {
      color: #ccc;
      text-decoration: none;
      transition: color 0.2s;
    }
    .footer-section a:hover {
      color: var(--primary-color);
    }
    .footer-reviews-disclosure {
      border-top: 1px solid rgba(255,255,255,0.1);
      padding-top: 30px;
      margin-bottom: 30px;
    }
    .footer-reviews-disclosure p {
      color: #aaa;
      font-size: 0.85rem;
      line-height: 1.7;
      max-width: 900px;
    }
    .footer-bottom {
      border-top: 1px solid #e5e7eb;
      border-bottom: 1px solid #e5e7eb;
      padding-top: 20px;
      text-align: center;
      color: #888;
      font-size: 0.9rem;
    }
    .footer-bottom a {
      color: var(--primary-color);
      text-decoration: none;
    }

    /* Adjust body padding for sticky header */
    body {
      padding-top: var(--header-height);
    }

    /* Breadcrumb spacing below fixed header */
    .breadcrumb {
      padding-top: 20px;
    }

    /* Related Articles Section */
    .related-articles {
      max-width: 1200px;
      margin: 60px auto 40px;
      padding: 0 20px;
    }
    .related-articles h2 {
      font-size: 1.75rem;
      color: #1a1a2e;
      margin-bottom: 30px;
      text-align: center;
      font-weight: 600;
    }
    .related-articles-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 24px;
    }
    .related-card {
      background: #fff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      transition: transform 0.2s, box-shadow 0.2s;
      text-decoration: none;
      display: block;
    }
    .related-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.12);
    }
    .related-card-image {
      width: 100%;
      height: 160px;
      object-fit: cover;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .related-card-content {
      padding: 16px;
    }
    .related-card-title {
      font-size: 1rem;
      font-weight: 600;
      color: #1a1a2e;
      line-height: 1.4;
      margin: 0;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .related-card-category {
      font-size: 0.75rem;
      color: #C44B1C;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 8px;
      font-weight: 600;
    }
    .related-articles-loading {
      text-align: center;
      padding: 40px;
      color: #666;
    }
    .related-articles-error {
      text-align: center;
      padding: 20px;
      color: #999;
      font-style: italic;
    }

    /* Amazon Button Override - Modern Orange Style */
    .amazon-btn {
      display: inline-flex !important;
      align-items: center !important;
      gap: 8px !important;
      background: linear-gradient(180deg, #ff9900 0%, #e47911 100%) !important;
      color: #fff !important;
      padding: 10px 18px !important;
      border-radius: 8px !important;
      text-decoration: none !important;
      font-weight: 700 !important;
      font-size: 14px !important;
      border: none !important;
      box-shadow: 0 4px 14px rgba(255,153,0,0.4) !important;
      transition: all 0.3s ease !important;
      white-space: nowrap !important;
    }
    .amazon-btn:hover {
      background: linear-gradient(180deg, #ffad33 0%, #ff9900 100%) !important;
      transform: translateY(-2px) !important;
      box-shadow: 0 6px 20px rgba(255,153,0,0.5) !important;
      text-decoration: none !important;
      color: #fff !important;
    }
    .amazon-btn::before {
      content: '';
      display: inline-block;
      width: 18px;
      height: 18px;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='white'%3E%3Cpath d='M15.75 10.5V6a3.75 3.75 0 1 0-7.5 0v4.5m11.356-1.993 1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 0 1-1.12-1.243l1.264-12A1.125 1.125 0 0 1 5.513 7.5h12.974c.576 0 1.059.435 1.119 1.007ZM8.625 10.5a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm7.5 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z'/%3E%3C/svg%3E");
      background-size: contain;
      background-repeat: no-repeat;
    }
    .amazon-btn:active {
      transform: translateY(0) !important;
      box-shadow: 0 2px 8px rgba(255,153,0,0.4) !important;
    }
  

/* ── Staging chrome safety: keep drawers/menus hidden until JS opens them ──
   Production ships drawer CSS in a separate <style> block that was missing
   from the original snapshot, so unstyled drawer HTML leaked under the header.
   Also pin mobile-menu closed; some media queries set display:block globally. */
.clu-drawer-overlay {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5); z-index: 9998; display: none !important;
}
.clu-drawer-overlay.active { display: block !important; }
.clu-drawer {
  position: fixed; left: 0; top: 0; width: 365px; max-width: 90vw; height: 100%;
  background: #fff; z-index: 9999; transform: translateX(-100%);
  transition: transform 0.3s ease; overflow-y: auto;
  box-shadow: 2px 0 8px rgba(0,0,0,0.3);
  font-family: 'Open Sans', system-ui, sans-serif;
}
.clu-drawer.open { transform: translateX(0); }
.clu-drawer-header {
  background: #232f3e; color: #fff; padding: 15px 20px;
  display: flex; justify-content: space-between; align-items: center;
  font-size: 18px; font-weight: bold;
}
.clu-drawer-close {
  background: none; border: none; color: #fff; font-size: 28px;
  cursor: pointer; line-height: 1;
}
.clu-drawer-body { position: relative; min-height: 100%; }
.clu-drawer-main-item {
  padding: 14px 20px; border-bottom: 1px solid #eee; cursor: pointer;
  display: flex; justify-content: space-between; align-items: center;
  font-size: 15px; font-weight: 600; color: #111;
}
.clu-drawer-main-item:hover { background: #f5f5f5; }
.clu-drawer-panel {
  display: none; position: absolute; top: 0; left: 0; width: 100%;
  min-height: 100%; background: #fff;
}
.clu-drawer-panel.active { display: block; }
.clu-drawer-back {
  padding: 12px 20px; background: #f5f5f5; border-bottom: 1px solid #ddd;
  cursor: pointer; font-size: 14px; font-weight: 600; color: #333;
}
.clu-drawer-panel-title {
  padding: 14px 20px; font-size: 16px; font-weight: 700;
  border-bottom: 1px solid #eee; color: #111;
}
.clu-drawer-link {
  display: block; padding: 12px 20px; border-bottom: 1px solid #f0f0f0;
  color: #0277BD; text-decoration: none; font-size: 14px;
}
.clu-drawer-link:hover { background: #f8f8f8; }

.clu-mobile-overlay {
  display: none !important; position: fixed; top: 0; left: 0;
  width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1001;
}
.clu-mobile-overlay.active { display: block !important; }
.clu-mobile-menu {
  display: none !important; position: fixed; top: 0; right: 0;
  width: 300px; max-width: 90vw; height: 100vh; background: #fff;
  z-index: 1002; overflow-y: auto; box-shadow: -2px 0 8px rgba(0,0,0,0.2);
}
.clu-mobile-menu.open { display: block !important; }

/* Don't let medium breakpoints force mobile menu open */
@media (max-width: 1024px) {
  .clu-mobile-menu:not(.open) { display: none !important; }
}

/* Staging: no dropdowns / submenus — flat primary nav only */
.clu-servbar-dropdown-disabled,
.clu-servbar-dd-menu-disabled,
.clu-servbar-dd-menu-disabled-disabled,
.clu-dropdown {
  display: none !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
`;

const CHROME_HEADER = `<!-- Universal Chrome: PetSmart-inspired Header -->
    <header class="clu-header" id="cluHeader">
      <!-- Newsletter Subscription Banner -->
      <div class="clu-newsletter-banner" style="display:flex;justify-content:center;align-items:center;gap:20px;padding:8px 24px;max-width:100%;flex-wrap:wrap;">
        <div class="clu-contact-group" style="display:flex;align-items:center;justify-content:center;gap:20px;flex-wrap:wrap;text-align:center;">
          <div class="clu-topbar-contact" style="display:flex;align-items:center;justify-content:center;gap:8px;flex-shrink:1;font-size:18px;font-weight:600;">
            <a href="#" onclick="event.preventDefault();document.getElementById('cluMapModal').style.display='flex';" style="color:#fff;text-decoration:none;display:inline-flex;align-items:center;gap:6px;cursor:pointer;text-align:center;line-height:1.2;"><svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;"><path d="M12 0C7.31 0 3.5 3.81 3.5 8.5C3.5 14.88 12 24 12 24S20.5 14.88 20.5 8.5C20.5 3.81 16.69 0 12 0Z" fill="#EA4335"/><circle cx="12" cy="8.5" r="3.5" fill="#fff"/></svg> <span>27601 Forbes Rd #25, Laguna Niguel, CA 92677</span></a>
          </div>
          <div class="clu-topbar-contact" style="display:flex;align-items:center;justify-content:center;gap:8px;flex-shrink:0;font-size:18px;font-weight:600;">
            <a href="tel:+19495821732" style="color:#fff;text-decoration:none;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;"><svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" fill="#34A853" stroke="#34A853" stroke-width="1"/></svg> (949) 582-1732</a>
          </div>
        </div>
        <form class="clu-topbar-search clu-search-mobile" action="https://catsluvus.com/search" method="get" style="position:relative;align-items:center;flex-shrink:0;">
          <input type="text" name="q" placeholder="Search" autocomplete="off" style="width:260px;padding:6px 32px 6px 12px;border:1px solid rgba(255,255,255,0.3);border-radius:16px;font-size:13px;background:rgba(255,255,255,0.1);color:#fff;outline:none;box-sizing:border-box;">
          <button type="submit" aria-label="Search" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;padding:2px;display:flex;align-items:center;"><svg viewBox="0 0 24 24" style="width:16px;height:16px;"><path d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" stroke="rgba(255,255,255,0.7)" stroke-width="2" fill="none" stroke-linecap="round"/></svg></button>
        </form>
      </div>
      <!-- Map Modal -->
      <div id="cluMapModal" onclick="if(event.target===this)this.style.display='none';" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;align-items:center;justify-content:center;">
        <div style="background:#fff;border-radius:12px;width:90%;max-width:800px;overflow:hidden;position:relative;box-shadow:0 8px 30px rgba(0,0,0,0.3);">
          <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid #eee;">
            <div>
              <div style="font-weight:bold;font-size:20px;color:#333;">Cats Luv Us Boarding Hotel &amp; Grooming</div>
              <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
                <span style="font-weight:bold;color:#333;font-size:14px;">4.8</span>
                <span style="color:#FBBC04;font-size:16px;">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
                <span style="color:#666;font-size:13px;">(72 reviews)</span>
                <span style="color:#999;font-size:13px;">&middot; Pet boarding service</span>
              </div>
            </div>
            <button onclick="document.getElementById('cluMapModal').style.display='none';" style="background:none;border:none;font-size:28px;cursor:pointer;color:#000;font-weight:bold;line-height:1;padding:0;">&times;</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;">
            <iframe src="https://www.google.com/maps?q=Cats+Luv+Us+Boarding+Hotel+%26+Grooming,+27601+Forbes+Rd+%2325,+Laguna+Niguel,+CA+92677&output=embed" style="border:0;display:block;flex:1;min-width:300px;height:350px;" allowfullscreen="" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
            <div style="flex:0 0 280px;padding:20px;font-size:14px;color:#333;border-left:1px solid #eee;">
              <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:16px;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;margin-top:2px;"><path d="M12 0C7.31 0 3.5 3.81 3.5 8.5C3.5 14.88 12 24 12 24S20.5 14.88 20.5 8.5C20.5 3.81 16.69 0 12 0Z" fill="#EA4335"/><circle cx="12" cy="8.5" r="3.5" fill="#fff"/></svg>
                <div>
                  <div style="font-weight:600;">27601 Forbes Rd #25</div>
                  <div style="color:#666;">Laguna Niguel, CA 92677</div>
                  <div style="color:#666;font-size:12px;margin-top:2px;">Located in: Three Flags Center</div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#34A853" stroke-width="2" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                <div>
                  <span style="color:#34A853;font-weight:600;">Open</span> <span style="color:#666;">&middot; Closes 5 PM</span>
                </div>
              </div>
              <a href="tel:+19495821732" style="display:flex;align-items:center;gap:10px;margin-bottom:16px;color:#1a73e8;text-decoration:none;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" stroke-width="2" style="flex-shrink:0;"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
                (949) 582-1732
              </a>
              <a href="https://catsluvus.com" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:10px;margin-bottom:16px;color:#1a73e8;text-decoration:none;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" stroke-width="2" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
                catsluvus.com
              </a>
              <div style="display:flex;gap:8px;margin-top:8px;">
                <a href="https://www.google.com/maps/dir/?api=1&destination=Cats+Luv+Us+Boarding+Hotel+%26+Grooming&destination_place_id=ChIJIXkv_e7u3IAR5Lb6alMtpks" target="_blank" rel="noopener" style="flex:1;background:#1a73e8;color:#fff;padding:10px 0;border-radius:6px;text-decoration:none;font-weight:bold;font-size:13px;text-align:center;">Directions</a>
                <a href="https://www.google.com/maps/place/?q=place_id:ChIJIXkv_e7u3IAR5Lb6alMtpks" target="_blank" rel="noopener" style="flex:1;background:#fff;color:#1a73e8;padding:10px 0;border-radius:6px;text-decoration:none;font-weight:bold;font-size:13px;text-align:center;border:1px solid #dadce0;">View on Maps</a>
              </div>
            </div>
          </div>
        </div>
      </div>
      <!-- Brand Row: logo, name, CTAs -->
      <div class="clu-brandrow">
        <div class="clu-brandrow-inner" style="display:flex;align-items:center;justify-content:center;position:relative;height:auto;flex-wrap:wrap;gap:20px;">
          <!-- Centered Group: Brand Name + Book Now Button -->
          <div style="display:flex;align-items:center;justify-content:center;gap:30px;flex-wrap:wrap;">
            <!-- Brand Name (Logo Removed) -->
            <a href="https://catsluvus.com/" class="clu-brand-name" style="font-size:42px;font-weight:700;color:#DF0082;text-decoration:none;font-family:'Playfair Display',serif;letter-spacing:-0.3px;line-height:1;display:flex;flex-direction:column;justify-content:center;text-align:center;white-space:nowrap;height:auto;padding:10px 0;"><span class="clu-brand-title" style="font-size:42px;padding-bottom:4px;">Cats Luv Us</span><span class="clu-brand-subtitle" style="font-size:26px;color:#1a237e;">Boarding Hotel &amp; Grooming</span></a>
            
            <!-- Book Now Button -->
            <div class="clu-booknow-wrapper" style="flex-shrink:0;display:flex;align-items:center;height:auto;justify-content:center;position:relative;">
              <button id="cluBookNowBtn" onclick="window.location.href='/sign-in/';" style="background:#DF0082;color:#fff;border:3px solid #1a237e;padding:8px 40px;cursor:pointer;border-radius:20px;white-space:nowrap;display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(223,0,130,0.35),0 2px 6px rgba(0,0,0,0.1);transition:all 0.2s ease;position:relative;overflow:hidden;line-height:1.2;height:85px;">
                <span style="font-size:34px;font-weight:900;letter-spacing:1px;text-shadow:0 1px 2px rgba(0,0,0,0.2);font-family:'Playfair Display',serif;">Book Now</span>
                <span style="font-size:16px;font-weight:500;color:rgba(255,255,255,0.9);letter-spacing:0.3px;">Sign In &middot; Rewards &amp; Account</span>
                <span style="font-size:13px;font-weight:600;color:#ffd1e8;letter-spacing:0.2px;">First Night Free For New Customers!</span>
              </button>
              <style>
                #cluBookNowBtn:hover {
                  transform: translateY(-2px) scale(1.02);
                  box-shadow: 0 8px 28px rgba(223,0,130,0.45), 0 4px 10px rgba(0,0,0,0.12) !important;
                }
                #cluBookNowBtn:active {
                  transform: translateY(0) scale(0.98);
                  box-shadow: 0 2px 8px rgba(223,0,130,0.3), 0 1px 3px rgba(0,0,0,0.1) !important;
                }
                #cluBookNowBtn::after {
                  content: '';
                  position: absolute;
                  top: 0;
                  left: -100%;
                  width: 60%;
                  height: 100%;
                  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
                  animation: cluBtnShimmer 3s ease-in-out infinite;
                }
                @keyframes cluBtnShimmer {
                  0% { left: -100%; }
                  50% { left: 150%; }
                  100% { left: 150%; }
                }
              </style>
              <div id="cluBookNowDropdown" style="display:none;position:absolute;top:100%;right:0;margin-top:6px;background:#fff;border:1px solid #ccc;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:1001;width:280px;padding:10px 20px 20px;">
                <p style="margin:0 0 8px 0;font-size:16px;font-weight:bold;text-align:center;line-height:1.2;"><span style="color:#DF0082;">CatsLuvUs</span> <span style="color:#1a237e;">Rewards</span></p>
                <p style="margin:0 0 10px 0;font-size:13px;color:#000;font-weight:600;line-height:1.4;text-align:center;">Join our loyalty program & earn points every time you shop!</p>
                <a href="https://catsluvus.com/login/" style="display:block;width:100%;background:#0054A6;color:white;border:none;padding:12px;border-radius:4px;font-weight:bold;cursor:pointer;margin-bottom:6px;font-size:15px;text-decoration:none;text-align:center;box-sizing:border-box;">Sign In or Create Account</a>
                <p style="margin:0;font-size:11px;color:#000;text-align:center;line-height:1.3;">Sign in to book Cat Boarding or Grooming</p>
              </div>
            </div>
          </div>
          <button class="clu-hamburger" id="cluHamburger" aria-label="Open menu"><span></span><span></span><span></span></button>
        </div>
      </div>
      <!-- Services Bar: flat top-level links only (no dropdowns) -->
      <nav class="clu-services-bar" style="background: #1a237e; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.1); overflow: visible;">
        <div class="clu-services-bar-inner" style="max-width: 1200px; margin: 0 auto; display: flex; align-items: center; justify-content: center; gap: 20px; flex-wrap: wrap; white-space: normal;">
          <a href="https://catsluvus.com/" style="color: white; text-decoration: none; font-weight: bold; font-size: 14px;">Home</a>
          <a href="https://catsluvus.com/about-us/" style="color: white; text-decoration: none; font-weight: bold; font-size: 14px;">About Us</a>
          <a href="https://catsluvus.com/cat-boarding/" style="color: white; text-decoration: none; font-weight: bold; font-size: 14px;">Services &amp; Rates</a>
          <a href="https://catsluvus.com/photos/" style="color: white; text-decoration: none; font-weight: bold; font-size: 14px;">Photos</a>
          <a href="https://catsluvus.com/contact-us-map/" style="color: white; text-decoration: none; font-weight: bold; font-size: 14px;">Contact Us | Map</a>
          <a href="https://catsluvus.com/shop/" style="color: white; text-decoration: none; font-weight: bold; font-size: 14px;">Shop</a>
          <a href="https://catsluvus.com/blog/" style="color: white; text-decoration: none; font-weight: bold; font-size: 14px;">Blog</a>
        </div>
      </nav>
    </header>`;

const CHROME_FOOTER = `<footer class="universal-footer">
      <div class="footer-container">
        <div class="footer-grid">
          <div class="footer-section">
            <div class="footer-heading">Cats Luv Us Boarding Hotel & Grooming</div>
            <p style="color: #ccc; line-height: 1.6;">Your trusted resource for cat care, products, and expert advice. We help cat lovers provide the best life for their feline companions.</p>
          </div>
          <div class="footer-section">
            <div class="footer-heading">Categories</div>
            <ul>
              <li><a href="https://catsluvus.com/cat-trees-furniture/">Cat Trees & Furniture</a></li>
              <li><a href="https://catsluvus.com/cat-grooming/">Cat Grooming</a></li>
              <li><a href="https://catsluvus.com/petinsurance/">Pet Insurance</a></li>
              <li><a href="https://catsluvus.com/cat-boarding/">Cat Boarding</a></li>
            </ul>
          </div>
          <div class="footer-section">
            <div class="footer-heading">Resources</div>
            <ul>
              <li><a href="https://catsluvus.com/about-us/">About Us</a></li>
              <li><a href="https://catsluvus.com/contact/">Contact</a></li>
              <li><a href="https://catsluvus.com/privacy/">Privacy Policy</a></li>
              <li><a href="https://catsluvus.com/terms-of-use/">Terms of Service</a></li>
            </ul>
          </div>
          <div class="footer-section">
            <div class="footer-heading">Connect</div>
            <ul>
              <li><a href="https://link.catsluvus.com/widget/form/newsletter" target="_blank" rel="noopener">Newsletter</a></li>
              <li><a href="https://catsluvus.com/sitemap.xml">Sitemap</a></li>
            </ul>
            <div class="footer-social" style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;">
              <a href="mailto:catsluvus@gmail.com" aria-label="Email" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#444;"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#fff;"><path d="M1.5 8.67v8.58a3 3 0 003 3h15a3 3 0 003-3V8.67l-8.928 5.493a3 3 0 01-3.144 0L1.5 8.67z"/><path d="M22.5 6.908V6.75a3 3 0 00-3-3h-15a3 3 0 00-3 3v.158l9.714 5.978a1.5 1.5 0 001.572 0L22.5 6.908z"/></svg></a>
              <a href="https://www.facebook.com/catsluvus" target="_blank" rel="noopener" aria-label="Facebook" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#1877F2;"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#fff;"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg></a>
              <a href="https://www.instagram.com/catsluvus" target="_blank" rel="noopener" aria-label="Instagram" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:linear-gradient(45deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888);"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#fff;"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg></a>
              <a href="https://x.com/catsluvus" target="_blank" rel="noopener" aria-label="X" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#000;"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#fff;"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>
              <a href="https://www.youtube.com/@catsluvus" target="_blank" rel="noopener" aria-label="YouTube" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#FF0000;"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#fff;"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
              <a href="https://www.tiktok.com/@catsluvus" target="_blank" rel="noopener" aria-label="TikTok" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#000;"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#fff;"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg></a>
              <a href="https://www.linkedin.com/company/catsluvus" target="_blank" rel="noopener" aria-label="LinkedIn" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#0A66C2;"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#fff;"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg></a>
              <a href="https://www.pinterest.com/catsluvus" target="_blank" rel="noopener" aria-label="Pinterest" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:#E60023;"><svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:#fff;"><path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 01.083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.631-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12.017 24c6.624 0 11.99-5.367 11.99-11.988C24.007 5.367 18.641 0 12.017 0z"/></svg></a>
            </div>
          </div>
        </div>
        <div class="footer-reviews-disclosure">
          <div class="footer-heading">Our Cat Product Reviews</div>
          <p>At CatsLuvUs.com, many of the products we feature are the same ones used every day by our feline guests at Cats Luv Us Boarding Hotel in Laguna Niguel, California, where we've specialized in cat boarding and grooming for over 30 years. Drawing on real-world experience with thousands of cats of different breeds, ages, and personalities, our team focuses on how products actually perform in everyday use, from comfort and enrichment to ease of cleaning and safety. When we've personally tested an item in our facility, we explain how we used it and what we observed, and we regularly update our recommendations as we see what works best for the cats in our care.</p>
        </div>
        <div class="footer-bottom">
          <p>&copy; 2026 <a href="https://catsluvus.com/">CatsLuvUs</a>. All rights reserved. Made with ❤️ for cat lovers.</p>
        </div>
      </div>
    </footer>`;

const CHROME_SCRIPT = `function openCluDrawer() {
        document.getElementById('cluDrawerOverlay').classList.add('active');
        document.getElementById('cluDrawer').classList.add('open');
        document.body.style.overflow = 'hidden';
      }
      function closeCluDrawer() {
        document.getElementById('cluDrawerOverlay').classList.remove('active');
        document.getElementById('cluDrawer').classList.remove('open');
        document.body.style.overflow = '';
        showCluMainMenu();
      }
      function showCluPanel(panelId) {
        document.getElementById('cluDrawerMain').style.display = 'none';
        var panels = document.querySelectorAll('.clu-drawer-panel');
        for (var i = 0; i < panels.length; i++) { panels[i].classList.remove('active'); }
        document.getElementById(panelId).classList.add('active');
      }
      function showCluMainMenu() {
        document.getElementById('cluDrawerMain').style.display = '';
        var panels = document.querySelectorAll('.clu-drawer-panel');
        for (var i = 0; i < panels.length; i++) { panels[i].classList.remove('active'); }
      }
(function() {
        var hamburger = document.getElementById('cluHamburger');
        var mobileMenu = document.getElementById('cluMobileMenu');
        var mobileOverlay = document.getElementById('cluMobileOverlay');
        var mobileClose = document.getElementById('cluMobileClose');
        var searchForm = document.getElementById('cluSearchForm');
        var searchInput = document.getElementById('cluSearchInput');
        var mobileSearchInput = document.getElementById('cluMobileSearchInput');

        function openMobile() {
          mobileMenu.classList.add('open');
          mobileOverlay.classList.add('active');
          hamburger.classList.add('active');
          document.body.style.overflow = 'hidden';
        }
        function closeMobile() {
          mobileMenu.classList.remove('open');
          mobileOverlay.classList.remove('active');
          hamburger.classList.remove('active');
          document.body.style.overflow = '';
        }
        if (hamburger) hamburger.addEventListener('click', function() {
          mobileMenu.classList.contains('open') ? closeMobile() : openMobile();
        });
        if (mobileClose) mobileClose.addEventListener('click', closeMobile);
        if (mobileOverlay) mobileOverlay.addEventListener('click', closeMobile);

        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') closeMobile();
        });

        if (searchForm) searchForm.addEventListener('submit', function(e) {
          e.preventDefault();
          var q = searchInput ? searchInput.value.trim() : '';
          if (q) {
            window.location.href = '/search?q=' + encodeURIComponent(q);
          }
        });
        if (mobileSearchInput) mobileSearchInput.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            var q = mobileSearchInput.value.trim();
            if (q) {
              window.location.href = '/search?q=' + encodeURIComponent(q);
              closeMobile();
            }
          }
        });

        document.querySelectorAll('.clu-mobile-group-title').forEach(function(btn) {
          btn.addEventListener('click', function() {
            this.parentElement.classList.toggle('open');
          });
        });

        document.querySelectorAll('.clu-nav-link[href="#"]').forEach(function(link) {
          link.addEventListener('click', function(e) { e.preventDefault(); });
        });

        // FAQ Accordion
        document.querySelectorAll('.faq-item').forEach(function(item) {
          item.addEventListener('click', function() {
            this.classList.toggle('active');
          });
        });

        document.addEventListener('click', function(e) {
          if (!e.target.closest('.clu-nav-item')) {
            document.querySelectorAll('.clu-dropdown').forEach(function(d) {
              d.style.opacity = ''; d.style.visibility = ''; d.style.transform = '';
            });
          }
        });

        // Foldable device support: close mobile menu and recalculate layout on fold/unfold
        var lastWidth = window.innerWidth;
        window.addEventListener('resize', function() {
          var w = window.innerWidth;
          // Significant width change (>100px) indicates fold/unfold transition
          if (Math.abs(w - lastWidth) > 100) {
            closeMobile();
            // Force CSS recalc on layout shift
            document.documentElement.style.setProperty('--vw', w + 'px');
          }
          lastWidth = w;
        });
      })();`;


/** Map dead catsluvus.com menu paths (404) to nearest live 200 pages. */
const CATSLUVUS_HREF_FIXES: Record<string, string> = {
  "https://catsluvus.com/sign-in/": "https://catsluvus.com/login/",
  "https://catsluvus.com/sign-in": "https://catsluvus.com/login/",
  "https://catsluvus.com/faq/": "https://catsluvus.com/contact-us-map/",
  "https://catsluvus.com/faq": "https://catsluvus.com/contact-us-map/",
  "https://catsluvus.com/in-the-news/": "https://catsluvus.com/blog/",
  "https://catsluvus.com/in-the-news": "https://catsluvus.com/blog/",
  "https://catsluvus.com/community-partners/": "https://catsluvus.com/about-us/",
  "https://catsluvus.com/community-partners": "https://catsluvus.com/about-us/",
  "https://catsluvus.com/services-rates/": "https://catsluvus.com/cat-boarding/",
  "https://catsluvus.com/services-rates": "https://catsluvus.com/cat-boarding/",
  "https://catsluvus.com/services-and-rates/": "https://catsluvus.com/cat-boarding/",
  "https://catsluvus.com/suites-rates/": "https://catsluvus.com/cat-boarding/",
  "https://catsluvus.com/suites-rates": "https://catsluvus.com/cat-boarding/",
  "https://catsluvus.com/amenities/": "https://catsluvus.com/cat-boarding/",
  "https://catsluvus.com/amenities": "https://catsluvus.com/cat-boarding/",
  "https://catsluvus.com/entertainment/": "https://catsluvus.com/cat-boarding/",
  "https://catsluvus.com/entertainment": "https://catsluvus.com/cat-boarding/",
  "https://catsluvus.com/webcam-security/": "https://catsluvus.com/cat-boarding/",
  "https://catsluvus.com/webcam-security": "https://catsluvus.com/cat-boarding/",
  "https://catsluvus.com/hours/": "https://catsluvus.com/contact-us-map/",
  "https://catsluvus.com/hours": "https://catsluvus.com/contact-us-map/",
  "https://catsluvus.com/holiday-schedule/": "https://catsluvus.com/contact-us-map/",
  "https://catsluvus.com/holiday-schedule": "https://catsluvus.com/contact-us-map/",
  "https://catsluvus.com/join-our-team/": "https://catsluvus.com/about-us/",
  "https://catsluvus.com/join-our-team": "https://catsluvus.com/about-us/",
};

function rewriteDeadCatsluvusHrefs(html: string): string {
  let out = html;
  for (const [from, to] of Object.entries(CATSLUVUS_HREF_FIXES)) {
    // href="..." only
    out = out.split(`href="${from}"`).join(`href="${to}"`);
    // also without quotes edge cases already covered
  }
  return out;
}

function isProductionDomain(domain: string | undefined): boolean {
  if (!domain) return false;
  const d = domain.trim().toLowerCase().replace(/^www\./, "");
  return d === "catsluvus.com" || d.endsWith(".catsluvus.com");
}

/**
 * Inject site header/nav/footer into article HTML for non-production hosts.
 */
export function wrapWithSiteChrome(
  html: string,
  domain: string | undefined
): string {
  // Never alter the real production site (petinsurance consumer owns chrome).
  if (isProductionDomain(domain)) return html;
  // Already wrapped — do not double-inject.
  if (html.includes(CHROME_MARKER) || html.includes("clu-site-chrome")) {
    return html;
  }

  const styleTag = `<style id="clu-universal-chrome-css">\n${CHROME_CSS}\n</style>`;
  const scriptTag = CHROME_SCRIPT
    ? `<script id="clu-universal-chrome-js">\n${CHROME_SCRIPT}\n</script>`
    : "";
  const headInject = styleTag;
  const bodyOpenInject = rewriteDeadCatsluvusHrefs(CHROME_HEADER);
  const bodyCloseInject = `${rewriteDeadCatsluvusHrefs(CHROME_FOOTER)}${scriptTag}`;

  let out = html;

  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${headInject}`);
  } else {
    out = headInject + out;
  }

  if (/<body[^>]*>/i.test(out)) {
    out = out.replace(/(<body[^>]*>)/i, `$1${bodyOpenInject}`);
  } else {
    out = bodyOpenInject + out;
  }

  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${bodyCloseInject}</body>`);
  } else {
    out = out + bodyCloseInject;
  }

  return out;
}
