// Browser scrape template.
// Workers AI extraction was removed from this repository. Do not add an
// AI binding. Structured extraction belongs on Claude. See
// docs/workers-ai-removal.md.

import puppeteer from "@cloudflare/puppeteer";

interface Env {
  MYBROWSER: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { searchParams } = new URL(request.url);
    const url = searchParams.get("url");

    if (!url) {
      return new Response("Missing ?url parameter", { status: 400 });
    }

    // Step 1: Scrape page content with browser
    const browser = await puppeteer.launch(env.MYBROWSER);

    try {
      const page = await browser.newPage();

      await page.goto(url, {
        waitUntil: "networkidle0",
        timeout: 30000
      });

      // Extract raw HTML content
      const bodyContent = await page.$eval("body", (el) => el.innerHTML);

      await browser.close();

      return Response.json(
        {
          url,
          htmlLength: bodyContent.length,
          error:
            "Workers AI extraction was removed from this repository. Use Claude."
        },
        { status: 501 }
      );
    } catch (error) {
      await browser.close();
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "AI-enhanced scraping failed"
        },
        { status: 500 }
      );
    }
  }
};

/**
 * Setup:
 *   Browser binding only. Do not add a Workers AI binding.
 *   {
 *     "browser": { "binding": "MYBROWSER" },
 *     "compatibility_flags": ["nodejs_compat"]
 *   }
 *
 * Usage:
 *   GET /?url=https://example.com/product
 *
 * Response:
 *   {
 *     "url": "https://example.com/product",
 *     "product": {
 *       "name": "Example Product",
 *       "price": "$99.99",
 *       "description": "Product description...",
 *       "availability": "In Stock"
 *     },
 *     "extractedAt": "2025-10-22T12:34:56.789Z"
 *   }
 *
 * Benefits:
 * - No need to write custom CSS selectors for each site
 * - AI adapts to different page structures
 * - Extracts semantic information, not just raw HTML
 * - Handles variations in HTML structure
 *
 * Limitations:
 * - AI context limited to ~4000 chars of HTML
 * - May hallucinate if data not present
 * - This repository has no Workers AI binding
 *
 * See also:
 * - docs/workers-ai-removal.md
 * - web-scraper-basic.ts for traditional CSS selector approach
 */
