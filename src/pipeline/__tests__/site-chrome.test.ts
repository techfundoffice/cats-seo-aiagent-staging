import { describe, expect, it } from "vitest";
import { ensureChromeAffiliateBar, wrapWithSiteChrome } from "../site-chrome";

const bare = `<!DOCTYPE html><html><head><title>T</title></head><body><main>hi</main></body></html>`;

describe("wrapWithSiteChrome", () => {
  it("injects flat Universal Chrome without dropdown submenus", () => {
    const out = wrapWithSiteChrome(
      bare,
      "cats-seo-aiagent-staging.webmaster-bc8.workers.dev"
    );
    expect(out).toContain("clu-header");
    expect(out).toContain("Book Now");
    expect(out).toContain("clu-affiliate-bar");
    expect(out).toContain("earn a commission");
    expect(out).toContain("27601 Forbes");
    expect(out).toContain(">Home</a>");
    expect(out).toContain(">About Us</a>");
    expect(out).toContain('href="https://catsluvus.com/photos/"');
    expect(out).not.toMatch(
      /href="https:\/\/catsluvus\.com\/blog\/"[^>]*>Photos/
    );
    // Exactly one Photos menu link, and only one services bar (no nested copy in Book Now)
    expect((out.match(/>Photos<\/a>/g) || []).length).toBe(1);
    expect((out.match(/class="clu-services-bar"/g) || []).length).toBe(1);
    expect(out).toContain('href="https://catsluvus.com/shop/"');
    expect(out).toContain(">Blog</a>");
    // Services bar Shop is a real link (not drawer trigger)
    expect(out).not.toMatch(/href="#"[^>]*openCluDrawer\(\)[^>]*>[\s\S]*?Shop/);
    expect(out).toContain(">Services &amp; Rates</a>");
    expect(out).toContain("<main>hi</main>");
    // No dropdown submenu markup (class= dropdown wrappers / dd menus / carets)
    expect(out).not.toContain('class="clu-servbar-dropdown"');
    expect(out).not.toContain('class="clu-servbar-dd-menu"');
    expect(out).not.toContain("&#9660;");
    expect(out).not.toContain("MAIN MENU");
    // Dead paths remapped
    expect(out).not.toContain('href="https://catsluvus.com/sign-in/"');
    expect(out).toContain('href="https://catsluvus.com/login/"');
    expect(out).toContain("Staging chrome safety");
  });

  it("is a no-op on catsluvus.com", () => {
    const out = wrapWithSiteChrome(bare, "catsluvus.com");
    expect(out).toBe(bare);
  });

  it("does not double-wrap", () => {
    const once = wrapWithSiteChrome(
      bare,
      "cats-seo-aiagent-staging.webmaster-bc8.workers.dev"
    );
    const twice = wrapWithSiteChrome(
      once,
      "cats-seo-aiagent-staging.webmaster-bc8.workers.dev"
    );
    expect(twice).toBe(once);
  });
});

describe("ensureChromeAffiliateBar", () => {
  it("injects the bar into HTML that already has clu-header", () => {
    const existing = `<!DOCTYPE html><html><head></head><body>
<header class="clu-header" id="cluHeader"><nav>nav</nav></header>
<main>article with <a href="https://www.amazon.com/dp/B0?tag=x">buy</a></main>
</body></html>`;
    const out = ensureChromeAffiliateBar(existing);
    expect(out).toContain("clu-affiliate-bar");
    expect(out).toContain("earn a commission");
    expect(out.indexOf("clu-affiliate-bar")).toBeLessThan(out.indexOf("</header>"));
    expect(ensureChromeAffiliateBar(out)).toBe(out);
  });

  it("is a no-op without site chrome", () => {
    const bare = "<html><body><p>no chrome</p></body></html>";
    expect(ensureChromeAffiliateBar(bare)).toBe(bare);
  });
});
