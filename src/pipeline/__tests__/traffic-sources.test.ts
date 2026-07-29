import { describe, expect, it } from "vitest";
import {
  COPY_CHANNELS,
  MAX_ATTEMPTS,
  TRAFFIC_SOURCE_IDS,
  TRAFFIC_SOURCES,
  artifactKey,
  extractArticleFacts,
  isLedgerComplete,
  ledgerKey,
  mergeLedgers,
  mergeQaPayloadIntoFacts,
  parseCopyResponse,
  pendingSourceIds,
  type ArticleFacts,
  type TrafficSourceLedger
} from "../traffic-sources";

const URL_ = "https://catsluvus.com/cat-litter-boxes/best-automatic-litter-box";

const HTML = `<!DOCTYPE html><html><head>
<title>Best Automatic Litter Box (2026 Picks)</title>
<meta name="description" content="Our picks for the best automatic litter box &amp; what to avoid.">
<meta property="og:image" content="https://img.catsluvus.com/hero.jpg">
<script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Article", headline: "Best Automatic Litter Box" },
    {
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Are automatic litter boxes safe for kittens?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Most models lock out cats under 5 lbs."
          }
        },
        {
          "@type": "Question",
          name: "How often do they need emptying?",
          acceptedAnswer: { "@type": "Answer", text: "Roughly every 7 days." }
        }
      ]
    }
  ]
})}</script>
</head><body>
<p><strong>Quick Answer:</strong> The Litter-Robot 4 is the pick for most homes.</p>
<div class="key-takeaways"><strong>Key Takeaways:</strong><ul>
<li>Weight sensors matter more than cycle speed</li>
<li>Budget models clog with clumping litter</li>
</ul></div>
<ul class="top-picks-list">
<li class="top-pick-item"><span class="pick-rank">1</span><div class="pick-info">
<p class="pick-name">Litter-Robot 4</p></div></li>
<li class="top-pick-item"><span class="pick-rank">2</span><div class="pick-info">
<p class="pick-name">PetSafe ScoopFree</p></div></li>
</ul>
</body></html>`;

const FACTS: ArticleFacts = {
  title: "Best Automatic Litter Box",
  metaDescription: "Our picks.",
  ogImage: "https://img.catsluvus.com/hero.jpg",
  quickAnswer: "The Litter-Robot 4 is the pick for most homes.",
  takeaways: ["Weight sensors matter"],
  faqs: [
    { question: "Safe for kittens?", answer: "Most lock out under 5 lbs." }
  ],
  products: ["Litter-Robot 4"]
};

/** Repeat `s` until it is at least `n` characters long. */
function pad(s: string, n: number): string {
  let out = s;
  while (out.length < n) out += ` ${s}`;
  return out;
}

function emptyLedger(): TrafficSourceLedger {
  return {
    kvKey: "cat-litter-boxes:best-automatic-litter-box",
    url: URL_,
    keyword: "best automatic litter box",
    updatedAt: "2026-07-29T00:00:00.000Z",
    sources: {}
  };
}

describe("extractArticleFacts", () => {
  const facts = extractArticleFacts(HTML);

  it("reads the SERP fields and hero image", () => {
    expect(facts.title).toBe("Best Automatic Litter Box (2026 Picks)");
    expect(facts.metaDescription).toBe(
      "Our picks for the best automatic litter box & what to avoid."
    );
    expect(facts.ogImage).toBe("https://img.catsluvus.com/hero.jpg");
  });

  it("reads the quick answer and key takeaways", () => {
    expect(facts.quickAnswer).toBe(
      "The Litter-Robot 4 is the pick for most homes."
    );
    expect(facts.takeaways).toEqual([
      "Weight sensors matter more than cycle speed",
      "Budget models clog with clumping litter"
    ]);
  });

  it("reads FAQ pairs out of nested FAQPage JSON-LD without duplicates", () => {
    expect(facts.faqs).toEqual([
      {
        question: "Are automatic litter boxes safe for kittens?",
        answer: "Most models lock out cats under 5 lbs."
      },
      {
        question: "How often do they need emptying?",
        answer: "Roughly every 7 days."
      }
    ]);
  });

  it("reads the product picks", () => {
    expect(facts.products).toEqual(["Litter-Robot 4", "PetSafe ScoopFree"]);
  });

  it("never throws on markup it does not recognise", () => {
    const facts = extractArticleFacts("<html><body>nothing here</body></html>");
    expect(facts.title).toBe("");
    expect(facts.faqs).toEqual([]);
    expect(facts.products).toEqual([]);
  });

  it("ignores malformed JSON-LD blocks", () => {
    const facts = extractArticleFacts(
      `<script type="application/ld+json">{ not json }</script>`
    );
    expect(facts.faqs).toEqual([]);
  });
});

describe("mergeQaPayloadIntoFacts", () => {
  it("prefers the Q&A payload when it has richer content", () => {
    const merged = mergeQaPayloadIntoFacts(
      FACTS,
      JSON.stringify({
        quickAnswer: "Payload answer.",
        keyTakeaways: ["a", "b"],
        faqs: [{ question: "Q", answer: "A" }],
        topProducts: [{ asin: "B1", name: "Payload Pick", reason: "r" }]
      })
    );
    expect(merged.quickAnswer).toBe("Payload answer.");
    expect(merged.takeaways).toEqual(["a", "b"]);
    expect(merged.faqs).toEqual([{ question: "Q", answer: "A" }]);
    expect(merged.products).toEqual(["Payload Pick"]);
  });

  it("keeps the HTML facts when the payload is missing or malformed", () => {
    expect(mergeQaPayloadIntoFacts(FACTS, null)).toEqual(FACTS);
    expect(mergeQaPayloadIntoFacts(FACTS, "{oops")).toEqual(FACTS);
    expect(mergeQaPayloadIntoFacts(FACTS, "{}")).toEqual(FACTS);
  });
});

describe("parseCopyResponse", () => {
  const socialChannels = COPY_CHANNELS.filter((c) => c.batch === "social");

  const validSocial = {
    pinterest: {
      pinTitle: "The automatic litter box that actually handles two cats",
      pinDescription: pad(
        "Weight sensors matter more than cycle speed when two cats share a box.",
        200
      ),
      board: "Cat Gear",
      altText: "An automatic litter box in a bathroom"
    },
    x: {
      thread: [
        "Two cats, one automatic box: the spec that decides it is the weight sensor.",
        "Cycle speed is the number every listing shouts about. It is not the one that matters.",
        "Full breakdown of the picks:"
      ]
    },
    facebook: {
      groups: ["Multi-cat households", "Cat product reviews"],
      post: pad(
        "If your box jams every other day, the culprit is usually litter type.",
        200
      )
    },
    reddit: {
      subreddits: ["cats", "r/CatAdvice"],
      title: "What finally stopped my automatic box from jamming",
      body: pad("The clumping litter I used was too fine for the rake.", 250)
    }
  };

  it("builds every channel present in a well-formed response", () => {
    const out = parseCopyResponse(
      JSON.stringify(validSocial),
      socialChannels,
      FACTS,
      URL_
    );
    expect(Object.keys(out).sort()).toEqual(
      ["facebook", "pinterest", "reddit", "x"].sort()
    );
  });

  it("appends the article link to channels that omitted it", () => {
    const out = parseCopyResponse(
      JSON.stringify(validSocial),
      socialChannels,
      FACTS,
      URL_
    );
    expect(out.reddit.fields.body).toContain(URL_);
    expect(out.facebook.fields.post).toContain(URL_);
    expect((out.x.fields.thread as string[]).join(" ")).toContain(URL_);
  });

  it("carries the hero image and destination into the Pinterest fields", () => {
    const out = parseCopyResponse(
      JSON.stringify(validSocial),
      socialChannels,
      FACTS,
      URL_
    );
    expect(out.pinterest.fields.imageUrl).toBe(FACTS.ogImage);
    expect(out.pinterest.fields.destinationUrl).toBe(URL_);
  });

  it("normalises subreddit names to the r/ prefix", () => {
    const out = parseCopyResponse(
      JSON.stringify(validSocial),
      socialChannels,
      FACTS,
      URL_
    );
    expect(out.reddit.fields.subreddits).toEqual(["r/cats", "r/CatAdvice"]);
  });

  it("drops only the channels that fail validation", () => {
    const partial = {
      ...validSocial,
      // Too short to be a usable post, and a 2-post "thread".
      facebook: { groups: ["a"], post: "too short" },
      x: { thread: ["one", "two"] }
    };
    const out = parseCopyResponse(
      JSON.stringify(partial),
      socialChannels,
      FACTS,
      URL_
    );
    expect(Object.keys(out).sort()).toEqual(["pinterest", "reddit"]);
  });

  it("tolerates fenced JSON with prose around it", () => {
    const wrapped = `Sure! Here is the copy:\n\`\`\`json\n${JSON.stringify(validSocial)}\n\`\`\`\nLet me know.`;
    const out = parseCopyResponse(wrapped, socialChannels, FACTS, URL_);
    expect(Object.keys(out).length).toBe(4);
  });

  it("returns nothing when the response contains no JSON object", () => {
    expect(
      parseCopyResponse("I cannot help with that.", socialChannels, FACTS, URL_)
    ).toEqual({});
  });

  it("keeps the X thread's final post within the 260-char cap", () => {
    const full = {
      ...validSocial,
      x: { thread: [pad("a", 300), pad("b", 300), pad("c", 300)] }
    };
    const out = parseCopyResponse(
      JSON.stringify(full),
      socialChannels,
      FACTS,
      URL_
    );
    const thread = out.x.fields.thread as string[];
    expect(thread[thread.length - 1]).toContain(URL_);
    for (const post of thread) expect(post.length).toBeLessThanOrEqual(260);
  });
});

describe("parseCopyResponse — longform batch", () => {
  const longformChannels = COPY_CHANNELS.filter((c) => c.batch === "longform");

  const validLongform = {
    quora: {
      questions: [
        "Are automatic litter boxes worth it for two cats?",
        "Do automatic litter boxes jam with clumping litter?",
        "How often do you empty an automatic litter box?"
      ],
      answer: pad(
        "The weight sensor is what decides whether a box works in a two-cat home.",
        400
      )
    },
    youtubeShort: {
      hook: "The litter box spec nobody checks",
      script: pad(
        "Everyone compares cycle speed. The spec that actually matters is the weight sensor.",
        350
      ),
      description: pad("Why weight sensors decide the winner here.", 120),
      tags: ["cat litter box", "automatic litter box", "cat gear"]
    },
    newsletter: {
      subject: "The litter box spec nobody checks",
      preheader: "It is not cycle speed, and it is not price",
      body: pad(
        "Every listing leads with cycle speed. The weight sensor is the part that decides it.",
        350
      )
    },
    medium: {
      title: "The litter box spec nobody checks",
      standfirst: "Cycle speed sells boxes. Weight sensors make them work.",
      intro: pad(
        "Two cats sharing one automatic box is where the cheap models fall apart.",
        400
      )
    }
  };

  it("builds every longform channel from a well-formed response", () => {
    const out = parseCopyResponse(
      JSON.stringify(validLongform),
      longformChannels,
      FACTS,
      URL_
    );
    expect(Object.keys(out).sort()).toEqual([
      "medium",
      "newsletter",
      "quora",
      "youtube-short"
    ]);
  });

  it("cites the article in every longform channel", () => {
    const out = parseCopyResponse(
      JSON.stringify(validLongform),
      longformChannels,
      FACTS,
      URL_
    );
    expect(out.quora.fields.answer).toContain(URL_);
    expect(out["youtube-short"].fields.description).toContain(URL_);
    expect(out.newsletter.fields.body).toContain(URL_);
    expect(out.medium.fields.intro).toContain(URL_);
    expect(out.medium.fields.canonicalUrl).toBe(URL_);
  });

  it("rejects longform channels that fall under their length floors", () => {
    const thin = {
      quora: { questions: ["only one"], answer: "too short" },
      youtubeShort: { hook: "hi", script: "short", description: "", tags: [] },
      newsletter: { subject: "s", preheader: "p", body: "short" },
      medium: { title: "t", standfirst: "s", intro: "short" }
    };
    expect(
      parseCopyResponse(JSON.stringify(thin), longformChannels, FACTS, URL_)
    ).toEqual({});
  });
});

describe("ledger bookkeeping", () => {
  it("keys are namespaced per article and per source", () => {
    expect(ledgerKey("cat:slug")).toBe("traffic-sources:cat:slug");
    expect(artifactKey("pinterest", "cat:slug")).toBe(
      "traffic-source:pinterest:cat:slug"
    );
  });

  it("lists every source as pending for a fresh article", () => {
    expect(pendingSourceIds(emptyLedger())).toEqual(TRAFFIC_SOURCE_IDS);
    expect(isLedgerComplete(emptyLedger())).toBe(false);
  });

  it("stops listing a source once it is filled or skipped", () => {
    const ledger = emptyLedger();
    ledger.sources.pinterest = {
      status: "filled",
      detail: "",
      at: "",
      attempts: 1
    };
    ledger.sources.quora = {
      status: "skipped",
      detail: "",
      at: "",
      attempts: 1
    };
    const pending = pendingSourceIds(ledger);
    expect(pending).not.toContain("pinterest");
    expect(pending).not.toContain("quora");
  });

  it("retries a failed source until MAX_ATTEMPTS, then gives up", () => {
    const ledger = emptyLedger();
    ledger.sources.indexnow = {
      status: "failed",
      detail: "403",
      at: "",
      attempts: MAX_ATTEMPTS - 1
    };
    expect(pendingSourceIds(ledger)).toContain("indexnow");

    ledger.sources.indexnow.attempts = MAX_ATTEMPTS;
    expect(pendingSourceIds(ledger)).not.toContain("indexnow");
  });

  it("is complete only when every source has a terminal outcome", () => {
    const ledger = emptyLedger();
    for (const id of TRAFFIC_SOURCE_IDS) {
      ledger.sources[id] = {
        status: "filled",
        detail: "",
        at: "",
        attempts: 1
      };
    }
    expect(isLedgerComplete(ledger)).toBe(true);
    expect(pendingSourceIds(ledger)).toEqual([]);

    delete ledger.sources.newsletter;
    expect(isLedgerComplete(ledger)).toBe(false);
  });
});

describe("mergeLedgers", () => {
  const entry = (
    status: "filled" | "failed" | "skipped",
    attempts: number,
    artifact?: string
  ) => ({
    status,
    detail: "",
    at: "",
    attempts,
    ...(artifact ? { artifactKey: artifact } : {})
  });

  it("keeps a concurrent pass's work that this run never saw", () => {
    const stored = emptyLedger();
    stored.sources.pinterest = entry("filled", 1, "traffic-source:pinterest:k");
    const local = emptyLedger();
    local.sources.reddit = entry("filled", 1);

    const merged = mergeLedgers(stored, local);
    expect(merged.sources.pinterest.status).toBe("filled");
    expect(merged.sources.pinterest.artifactKey).toBe(
      "traffic-source:pinterest:k"
    );
    expect(merged.sources.reddit.status).toBe("filled");
  });

  it("prefers the entry with more attempts", () => {
    const stored = emptyLedger();
    stored.sources.indexnow = entry("failed", 3);
    const local = emptyLedger();
    local.sources.indexnow = entry("failed", 1);

    expect(mergeLedgers(stored, local).sources.indexnow.attempts).toBe(3);
    expect(mergeLedgers(local, stored).sources.indexnow.attempts).toBe(3);
  });

  it("prefers a terminal outcome when attempt counts tie", () => {
    const stored = emptyLedger();
    stored.sources.rss = entry("filled", 1);
    const local = emptyLedger();
    local.sources.rss = entry("failed", 1);

    expect(mergeLedgers(stored, local).sources.rss.status).toBe("filled");
    expect(mergeLedgers(local, stored).sources.rss.status).toBe("filled");
  });
});

describe("source registry", () => {
  it("covers search, answer-engine, syndication, social, community and owned", () => {
    const kinds = new Set(TRAFFIC_SOURCES.map((s) => s.kind));
    expect([...kinds].sort()).toEqual([
      "answer-engine",
      "community",
      "owned",
      "search",
      "social",
      "syndication"
    ]);
  });

  it("has no duplicate ids", () => {
    expect(new Set(TRAFFIC_SOURCE_IDS).size).toBe(TRAFFIC_SOURCE_IDS.length);
  });

  it("registers every copy channel as a traffic source", () => {
    for (const channel of COPY_CHANNELS) {
      expect(TRAFFIC_SOURCE_IDS).toContain(channel.id);
    }
  });
});
