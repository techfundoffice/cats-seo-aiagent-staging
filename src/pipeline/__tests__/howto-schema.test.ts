import { describe, expect, it } from "vitest";
import { buildHowToSchema, isHowToKeyword } from "../html-builder";

describe("isHowToKeyword", () => {
  it.each([
    "how to introduce a new cat",
    "how do cats stay hydrated",
    "how can I stop my cat scratching",
    "how should I clean a cat fountain",
    "how long does cat litter last",
    "How To Bathe a Senior Cat"
  ])("flags '%s' as how-to", (kw) => {
    expect(isHowToKeyword(kw)).toBe(true);
  });

  it.each([
    "best cat fountains for senior cats",
    "automatic cat feeder review",
    "the article discusses how to do many things", // mid-string, not start
    "cat trees and how to choose one"
  ])("does NOT flag '%s'", (kw) => {
    expect(isHowToKeyword(kw)).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isHowToKeyword("")).toBe(false);
  });
});

describe("buildHowToSchema", () => {
  const canonical = "https://catsluvus.com/cat-care/how-to-introduce-cats";

  it("returns null when keyword isn't how-to", () => {
    expect(
      buildHowToSchema(
        {
          title: "Best Cat Trees",
          sections: [
            { heading: "Top Picks", content: "<p>First.</p>" },
            { heading: "How We Picked", content: "<p>Second.</p>" }
          ]
        },
        "best cat trees",
        canonical
      )
    ).toBeNull();
  });

  it("returns null when there are fewer than 2 sections (Google's min)", () => {
    expect(
      buildHowToSchema(
        {
          title: "How To Bathe a Cat",
          sections: [{ heading: "Step 1", content: "<p>Wet the cat.</p>" }]
        },
        "how to bathe a cat",
        canonical
      )
    ).toBeNull();
  });

  it("builds a HowTo with one HowToStep per section", () => {
    const schema = buildHowToSchema(
      {
        title: "How to Introduce a New Cat",
        sections: [
          {
            heading: "Prepare the space",
            content:
              "<p>Set up a separate room with food, water, and a litter box. Close the door.</p>"
          },
          {
            heading: "Swap scents",
            content:
              "<p>Rub a cloth on each cat and place it in the other's area to acclimate scents.</p>"
          },
          {
            heading: "Supervised meetings",
            content:
              "<p>After several days, allow short supervised visits before letting them roam together.</p>"
          }
        ]
      },
      "how to introduce a new cat",
      canonical
    ) as Record<string, unknown>;
    expect(schema).not.toBeNull();
    expect(schema["@type"]).toBe("HowTo");
    expect(schema.name).toBe("How to Introduce a New Cat");
    const steps = schema.step as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({
      "@type": "HowToStep",
      position: 1,
      name: "Prepare the space",
      url: `${canonical}#section-1`
    });
    expect(steps[1].position).toBe(2);
    expect(steps[2].url).toBe(`${canonical}#section-3`);
  });

  it("strips HTML and takes only the first sentence as step text", () => {
    const schema = buildHowToSchema(
      {
        title: "How to Clean a Cat Fountain",
        sections: [
          {
            heading: "Disassemble",
            content:
              "<p>Unplug the fountain and remove the pump. <strong>Then</strong> rinse all parts.</p>"
          },
          {
            heading: "Wash",
            content:
              "<p>Use mild dish soap on every component. Avoid abrasive scrubbers.</p>"
          }
        ]
      },
      "how to clean a cat fountain",
      canonical
    ) as Record<string, unknown>;
    const steps = schema.step as Array<Record<string, unknown>>;
    expect(steps[0].text).toBe("Unplug the fountain and remove the pump.");
    expect(steps[0].text).not.toContain("<");
    expect(steps[1].text).toBe("Use mild dish soap on every component.");
  });

  it("caps step text at 320 chars when no sentence boundary is found", () => {
    const schema = buildHowToSchema(
      {
        title: "How to Train a Cat",
        sections: [
          { heading: "Step A", content: "a".repeat(500) },
          { heading: "Step B", content: "<p>Short step.</p>" }
        ]
      },
      "how to train a cat",
      canonical
    ) as Record<string, unknown>;
    const steps = schema.step as Array<Record<string, unknown>>;
    expect((steps[0].text as string).length).toBeLessThanOrEqual(320);
  });

  it("caps at 12 steps even when the article has more sections", () => {
    const sections = Array.from({ length: 20 }, (_, i) => ({
      heading: `Step ${i + 1}`,
      content: `<p>Do thing ${i + 1}.</p>`
    }));
    const schema = buildHowToSchema(
      { title: "How to Do 20 Things", sections },
      "how to do 20 things",
      canonical
    ) as Record<string, unknown>;
    expect((schema.step as unknown[]).length).toBe(12);
  });

  it("excludes 'Top Picks' / 'Our Top Picks' sections to match rendered IDs", () => {
    // html-builder filters these headings before assigning #section-N
    // IDs in the rendered article; the schema must do the same so
    // step URLs deep-link to anchors that actually exist.
    const schema = buildHowToSchema(
      {
        title: "How to Choose a Cat Fountain",
        sections: [
          {
            heading: "Top Picks",
            content: "<p>Our recommended fountains.</p>"
          },
          {
            heading: "Measure your space",
            content: "<p>Measure the area where the fountain will sit.</p>"
          },
          {
            heading: "Pick a material",
            content: "<p>Ceramic or stainless steel both resist biofilm.</p>"
          },
          {
            heading: "Our Top Picks",
            content: "<p>Duplicate top picks block.</p>"
          },
          {
            heading: "Set it up",
            content: "<p>Place it away from food and litter.</p>"
          }
        ]
      },
      "how to choose a cat fountain",
      canonical
    ) as Record<string, unknown>;
    const steps = schema.step as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(3);
    expect(steps[0].name).toBe("Measure your space");
    expect(steps[0].url).toBe(`${canonical}#section-1`);
    expect(steps[1].name).toBe("Pick a material");
    expect(steps[1].url).toBe(`${canonical}#section-2`);
    expect(steps[2].name).toBe("Set it up");
    expect(steps[2].url).toBe(`${canonical}#section-3`);
  });

  it("strips HTML from heading text in HowToStep.name", () => {
    const schema = buildHowToSchema(
      {
        title: "How to Soothe a Stressed Cat",
        sections: [
          {
            heading: "Identify <em>signs</em> of stress",
            content: "<p>Look for hiding, hissing, or appetite loss.</p>"
          },
          {
            heading: "Create a <strong>safe</strong> space",
            content: "<p>Set up a quiet room with a covered bed.</p>"
          }
        ]
      },
      "how to soothe a stressed cat",
      canonical
    ) as Record<string, unknown>;
    const steps = schema.step as Array<Record<string, unknown>>;
    expect(steps[0].name).toBe("Identify signs of stress");
    expect(steps[1].name).toBe("Create a safe space");
    expect(steps[0].name as string).not.toContain("<");
  });
});
