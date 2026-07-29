import { describe, expect, it } from "vitest";
import { removeTrustBox, hasTrustBox } from "../trust-box-removal";

const TEMPLATE_BLOCK = `<article>
  <p>Intro paragraph stays.</p>
  <section class="wc-trust-box">
    <div class="wc-trust-icon">&#128300;</div>
    <div class="wc-trust-content">
      <h2>Why You Should Trust Us</h2>
      <p>At Cats Luv Us Boarding Hotel in Laguna Niguel, California, we've cared for thousands of cats across fifteen years. Our staff includes certified feline behavior consultants and experienced installers.</p>
    </div>
  </section>
  <section class="wc-methodology"><h2>How We Picked</h2><p>We compared 8 products sold on Amazon.</p></section>
</article>`;

describe("removeTrustBox", () => {
  it("removes the template block whole", () => {
    const r = removeTrustBox(TEMPLATE_BLOCK);
    expect(r.removed).toBe(1);
    expect(r.html).not.toMatch(/Why You Should Trust Us/);
    expect(r.html).not.toMatch(/certified feline behavior consultants/);
    expect(r.html).not.toMatch(/wc-trust-box/);
  });

  it("keeps the surrounding article intact", () => {
    const r = removeTrustBox(TEMPLATE_BLOCK);
    expect(r.html).toMatch(/Intro paragraph stays/);
    expect(r.html).toMatch(/How We Picked/);
    expect(r.html).toMatch(/We compared 8 products sold on Amazon/);
  });

  it("removes a rewritten block that lost its class attribute", () => {
    const reshaped = `<div><p>Before.</p><h2>&#128300; Why You Should Trust Us</h2><p>Our staff includes certified feline behavior consultants.</p><h2>Next Section</h2><p>After.</p></div>`;
    const r = removeTrustBox(reshaped);
    expect(r.removed).toBe(1);
    expect(r.html).not.toMatch(/Why You Should Trust Us/);
    expect(r.html).not.toMatch(/certified feline behavior consultants/);
    // Everything on either side survives — a heading-only match would
    // have swallowed the following section.
    expect(r.html).toMatch(/Before\./);
    expect(r.html).toMatch(/Next Section/);
    expect(r.html).toMatch(/After\./);
  });

  it("is idempotent", () => {
    const once = removeTrustBox(TEMPLATE_BLOCK).html;
    const twice = removeTrustBox(once);
    expect(twice.removed).toBe(0);
    expect(twice.html).toBe(once);
  });

  it("is a no-op on an article that never had one", () => {
    const clean = `<article><p>Nothing to see.</p></article>`;
    const r = removeTrustBox(clean);
    expect(r.removed).toBe(0);
    expect(r.html).toBe(clean);
  });

  it("handles empty and non-string input", () => {
    expect(removeTrustBox("").removed).toBe(0);
    expect(removeTrustBox(undefined as unknown as string).removed).toBe(0);
  });
});

describe("disclosure nested inside the block", () => {
  // Observed in 15 of 424 live blocks: a model had put the honest FTC
  // Editorial Note INSIDE the trust box. Removing the section wholesale
  // deleted the disclosure the page actually needs.
  const NESTED = `<article>
    <section class="wc-trust-box">
      <div class="wc-trust-icon">&#128300;</div>
      <div class="wc-editorial-note">Editorial Note: No free products were received, and our Amazon affiliate relationship does not influence ranking order.</div>
      <div class="wc-trust-content">
        <h2>Why You Should Trust Us</h2>
        <p>Our staff includes certified feline behavior consultants.</p>
      </div>
    </section>
  </article>`;

  it("keeps the disclosure and drops the fabricated part", () => {
    const r = removeTrustBox(NESTED);
    expect(r.removed).toBe(1);
    expect(r.html).toMatch(/No free products were received/);
    expect(r.html).toMatch(/does not influence ranking order/);
    expect(r.html).not.toMatch(/Why You Should Trust Us/);
    expect(r.html).not.toMatch(/certified feline behavior consultants/);
  });
});

describe("orphaned heading", () => {
  // Observed live on one article: a preceding model-mangled block had
  // swallowed the opening <h2>, leaving the closing tag behind.
  const ORPHAN = `<div><p>Before.</p>Why You Should Trust Us</h2>
    <p>Cats Luv Us has served Laguna Niguel since 1998. Our recommendations draw from decades of observation.</p>
    <h2>Next Section</h2><p>After.</p></div>`;

  it("removes a heading that lost its opening tag", () => {
    const r = removeTrustBox(ORPHAN);
    expect(r.removed).toBe(1);
    expect(r.html).not.toMatch(/Why You Should Trust Us/);
    expect(r.html).not.toMatch(/decades of observation/);
    expect(r.html).toMatch(/Before\./);
    expect(r.html).toMatch(/Next Section/);
    expect(r.html).toMatch(/After\./);
  });
});

describe("stylesheet rules", () => {
  it("drops the dead CSS and does not read it as a block", () => {
    const cssOnly = `<html><head><style>.wc-trust-box{display:flex;gap:16px}.wc-trust-icon{font-size:28px}</style></head><body><p>No block here.</p></body></html>`;
    // The CSS alone must not register as a trust box…
    expect(hasTrustBox(cssOnly)).toBe(false);
    // …but the dead rules are still cleaned away.
    const r = removeTrustBox(cssOnly);
    expect(r.removed).toBe(0);
    expect(r.html).not.toMatch(/wc-trust-box\{/);
    expect(r.html).toMatch(/No block here/);
  });
});

describe("hasTrustBox", () => {
  it("detects both the class and the bare heading", () => {
    expect(hasTrustBox(TEMPLATE_BLOCK)).toBe(true);
    expect(hasTrustBox(`<h2>Why You Should Trust Us</h2>`)).toBe(true);
    expect(hasTrustBox(`<article><p>Clean.</p></article>`)).toBe(false);
  });

  it("reports false after removal", () => {
    expect(hasTrustBox(removeTrustBox(TEMPLATE_BLOCK).html)).toBe(false);
  });
});
