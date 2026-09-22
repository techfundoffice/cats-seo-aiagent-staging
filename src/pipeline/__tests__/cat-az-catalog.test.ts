import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchViaPaApi } from "../amazon";
import {
  CAT_AZ_PENDING_CAP,
  catCatalogSearchKeyword,
  catCatalogSearchQueries,
  nextCatalogLetter,
  planCatAzRefill,
  searchCatCatalogLetter,
  type CatAzCatalogHit
} from "../cat-az-catalog";

vi.mock("../amazon", () => ({
  fetchViaCreatorsApi: vi.fn(async () => []),
  fetchViaPaApi: vi.fn(async () => [])
}));

const ARM: CatAzCatalogHit = {
  asin: "B0ARMHAM01",
  title: "Arm & Hammer Slide Cat Litter",
  brand: "Arm & Hammer"
};

const PETSAFE: CatAzCatalogHit = {
  asin: "B0PETSAFE2",
  title: "PetSafe ScoopFree Crystal Litter",
  brand: "PetSafe"
};

const PA_CREDS = {
  creators: [],
  pa: [{ key: "key", secret: "secret", label: "primary" }]
};

function paHit(hit: CatAzCatalogHit) {
  return {
    name: hit.title,
    displayName: hit.title,
    asin: hit.asin,
    brand: hit.brand,
    source: "pa-api-v5" as const
  };
}

describe("Cat A–Z planner", () => {
  it("enqueues a real Cat-A product title with its ASIN", () => {
    const plan = planCatAzRefill({
      letter: "A",
      doneAsins: new Set(),
      pendingCount: 0,
      searchOk: true,
      products: [ARM, PETSAFE]
    });
    expect(plan.enqueue).toHaveLength(1);
    expect(plan.enqueue[0]).toMatchObject({
      keyword: "Arm & Hammer Slide Cat Litter",
      asin: "B0ARMHAM01",
      categorySlug: "cat-a",
      categoryTitle: "Cat A"
    });
    expect(plan.enqueue[0].keyword).not.toMatch(
      /dashboard refill|e2e|claude only/i
    );
    expect(plan.advanced).toBe(false);
    expect(plan.nextLetter).toBe("A");
  });

  it("does not advance when search hits do not match the letter", () => {
    const plan = planCatAzRefill({
      letter: "A",
      doneAsins: new Set(),
      pendingCount: 0,
      searchOk: true,
      products: [PETSAFE]
    });
    expect(plan.enqueue).toHaveLength(0);
    expect(plan.skipAsins).toEqual([]);
    expect(plan.advanced).toBe(false);
    expect(plan.nextLetter).toBe("A");
  });

  it("advances when the catalog page is empty", () => {
    const plan = planCatAzRefill({
      letter: "A",
      doneAsins: new Set(),
      pendingCount: 0,
      searchOk: true,
      products: []
    });
    expect(plan.enqueue).toHaveLength(0);
    expect(plan.advanced).toBe(true);
    expect(plan.nextLetter).toBe("B");
  });

  it("advances when every letter match is already in doneAsins", () => {
    const second: CatAzCatalogHit = {
      asin: "B0ANDCAT02",
      title: "Andover Cat Tunnel",
      brand: "Andover"
    };
    const plan = planCatAzRefill({
      letter: "A",
      doneAsins: new Set(["B0ARMHAM01", "B0ANDCAT02"]),
      pendingCount: 0,
      searchOk: true,
      products: [ARM, second, PETSAFE]
    });
    expect(plan.enqueue).toHaveLength(0);
    expect(plan.skipAsins).toEqual([]);
    expect(plan.advanced).toBe(true);
    expect(plan.nextLetter).toBe("B");
  });

  it("does not advance when Amazon itself failed", () => {
    const plan = planCatAzRefill({
      letter: "C",
      doneAsins: new Set(),
      pendingCount: 0,
      searchOk: false,
      products: []
    });
    expect(plan.advanced).toBe(false);
    expect(plan.nextLetter).toBe("C");
  });

  it("caps the pending buffer at 3 and holds the letter", () => {
    const plan = planCatAzRefill({
      letter: "A",
      doneAsins: new Set(),
      pendingCount: CAT_AZ_PENDING_CAP,
      searchOk: true,
      products: [ARM]
    });
    expect(plan.enqueue).toHaveLength(0);
    expect(plan.advanced).toBe(false);
    expect(plan.nextLetter).toBe("A");
  });

  it("enqueues only the open slots and leaves the rest for the next tick", () => {
    const second: CatAzCatalogHit = {
      asin: "B0ANDCAT02",
      title: "Andover Cat Tunnel",
      brand: "Andover"
    };
    const plan = planCatAzRefill({
      letter: "A",
      doneAsins: new Set(),
      pendingCount: 2,
      searchOk: true,
      products: [ARM, second]
    });
    expect(plan.enqueue.map((row) => row.asin)).toEqual(["B0ARMHAM01"]);
    expect(plan.skipAsins).toEqual([]);
    expect(plan.advanced).toBe(false);
    expect(plan.nextLetter).toBe("A");
  });

  it("skips already-seen ASINs and junk titles", () => {
    const junk: CatAzCatalogHit = {
      asin: "B0JUNKREF1",
      title: "Acme dashboard refill e2e claude only",
      brand: "Acme"
    };
    const plan = planCatAzRefill({
      letter: "A",
      doneAsins: new Set(["B0ARMHAM01"]),
      pendingCount: 0,
      searchOk: true,
      products: [ARM, junk]
    });
    expect(plan.enqueue).toHaveLength(0);
    expect(plan.skipAsins).toEqual(["B0JUNKREF1"]);
    expect(plan.advanced).toBe(true);
  });

  it("advances when the cap is filled and later letter matches are only junk", () => {
    const junk: CatAzCatalogHit = {
      asin: "B0JUNKREF1",
      title: "Acme dashboard refill e2e claude only",
      brand: "Acme"
    };
    const plan = planCatAzRefill({
      letter: "A",
      doneAsins: new Set(),
      pendingCount: CAT_AZ_PENDING_CAP - 1,
      searchOk: true,
      products: [ARM, junk]
    });
    expect(plan.enqueue.map((row) => row.asin)).toEqual(["B0ARMHAM01"]);
    expect(plan.skipAsins).toEqual(["B0JUNKREF1"]);
    expect(plan.advanced).toBe(true);
    expect(plan.nextLetter).toBe("B");
  });

  it("wraps Z back to A", () => {
    expect(nextCatalogLetter("Z")).toBe("A");
    expect(nextCatalogLetter("a")).toBe("B");
    expect(catCatalogSearchKeyword("a")).toBe("cat A");
    expect(catCatalogSearchQueries("b")).toEqual([
      "cat B",
      "B for cats",
      "B cat toy",
      "B cat tree"
    ]);
  });
});

describe("searchCatCatalogLetter", () => {
  beforeEach(() => {
    vi.mocked(fetchViaPaApi).mockReset();
  });

  it("queries PA API for cat products at the current letter and keeps letter matches", async () => {
    vi.mocked(fetchViaPaApi).mockImplementation(async (keyword: string) => {
      expect(keyword).toBe("cat A");
      return [
        {
          name: ARM.title,
          displayName: ARM.title,
          asin: ARM.asin,
          brand: ARM.brand,
          source: "pa-api-v5"
        },
        {
          name: PETSAFE.title,
          displayName: PETSAFE.title,
          asin: PETSAFE.asin,
          brand: PETSAFE.brand,
          source: "pa-api-v5"
        }
      ];
    });

    const found = await searchCatCatalogLetter(
      "A",
      {
        creators: [],
        pa: [{ key: "key", secret: "secret", label: "primary" }]
      },
      "catsluvus03-20",
      () => undefined
    );
    expect(found.ok).toBe(true);
    expect(found.products.map((product) => product.asin)).toEqual([ARM.asin]);

    const plan = planCatAzRefill({
      letter: "A",
      doneAsins: new Set(),
      pendingCount: 0,
      searchOk: found.ok,
      products: found.products.map((product) => ({
        asin: product.asin ?? "",
        title: product.name,
        brand: product.brand
      }))
    });
    expect(plan.enqueue[0]).toMatchObject({
      keyword: "Arm & Hammer Slide Cat Litter",
      asin: "B0ARMHAM01"
    });
    expect(plan.advanced).toBe(false);
    expect(plan.nextLetter).toBe("A");
  });

  it("tries later queries until a letter-matching product appears", async () => {
    const queries: string[] = [];
    vi.mocked(fetchViaPaApi).mockImplementation(async (keyword: string) => {
      queries.push(keyword);
      if (keyword === "A for cats") return [paHit(ARM)];
      return [paHit(PETSAFE)];
    });

    const warnings: string[] = [];
    const found = await searchCatCatalogLetter(
      "A",
      PA_CREDS,
      "catsluvus03-20",
      (msg) => warnings.push(msg)
    );
    expect(queries).toEqual(["cat A", "A for cats"]);
    expect(found.ok).toBe(true);
    expect(found.products.map((product) => product.asin)).toEqual([ARM.asin]);
    expect(warnings).toEqual([]);
  });

  it("warns and holds the letter when every query misses it", async () => {
    vi.mocked(fetchViaPaApi).mockImplementation(async () => [paHit(PETSAFE)]);
    const warnings: string[] = [];
    const found = await searchCatCatalogLetter(
      "A",
      PA_CREDS,
      "catsluvus03-20",
      (msg) => warnings.push(msg)
    );
    expect(found.ok).toBe(true);
    expect(found.products.map((product) => product.asin)).toEqual([
      PETSAFE.asin
    ]);
    expect(warnings).toEqual([
      "letter A searches returned 4 catalog hit(s) but no title or brand starts with A (tried: cat A, A for cats, A cat toy, A cat tree) — not advancing"
    ]);

    const plan = planCatAzRefill({
      letter: "A",
      doneAsins: new Set(),
      pendingCount: 0,
      searchOk: found.ok,
      products: found.products.map((product) => ({
        asin: product.asin ?? "",
        title: product.name,
        brand: product.brand
      }))
    });
    expect(plan.enqueue).toEqual([]);
    expect(plan.advanced).toBe(false);
    expect(plan.nextLetter).toBe("A");
  });

  it("treats an empty catalog page as letter exhaustion", async () => {
    vi.mocked(fetchViaPaApi).mockImplementation(async () => []);
    const warnings: string[] = [];
    const found = await searchCatCatalogLetter(
      "Q",
      PA_CREDS,
      "catsluvus03-20",
      (msg) => warnings.push(msg)
    );
    expect(found.ok).toBe(true);
    expect(found.products).toEqual([]);
    expect(warnings).toEqual([]);

    const plan = planCatAzRefill({
      letter: "Q",
      doneAsins: new Set(),
      pendingCount: 0,
      searchOk: found.ok,
      products: []
    });
    expect(plan.advanced).toBe(true);
    expect(plan.nextLetter).toBe("R");
  });

  it("keeps querying when the only letter matches were already seen", async () => {
    const queries: string[] = [];
    const andover: CatAzCatalogHit = {
      asin: "B0ANDCAT02",
      title: "Andover Cat Tunnel",
      brand: "Andover"
    };
    vi.mocked(fetchViaPaApi).mockImplementation(async (keyword: string) => {
      queries.push(keyword);
      if (keyword === "cat A") return [paHit(ARM)];
      if (keyword === "A cat toy") return [paHit(andover)];
      return [];
    });

    const found = await searchCatCatalogLetter(
      "A",
      PA_CREDS,
      "catsluvus03-20",
      () => undefined,
      new Set([ARM.asin])
    );
    expect(queries).toEqual(["cat A", "A for cats", "A cat toy"]);
    expect(found.products.map((product) => product.asin)).toEqual([
      andover.asin
    ]);
  });
});
