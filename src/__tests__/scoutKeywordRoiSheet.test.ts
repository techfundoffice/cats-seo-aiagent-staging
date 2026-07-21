import { describe, expect, it } from "vitest";
import { extractSheetTabTitlesFromComposio } from "../scoutKeywordRoiSheet";

describe("extractSheetTabTitlesFromComposio", () => {
  it("parses sheet_names entries that are JSON-stringified arrays", () => {
    expect(
      extractSheetTabTitlesFromComposio({
        sheet_names: ['["Scout keyword ROI","Archive"]']
      })
    ).toEqual(["Scout keyword ROI", "Archive"]);
  });

  it("dedupes titles from nested stringified arrays inside sheet_names", () => {
    expect(
      extractSheetTabTitlesFromComposio({
        sheet_names: ['"Scout keyword ROI"', '["Archive","Scout keyword ROI"]']
      })
    ).toEqual(["Scout keyword ROI", "Archive"]);
  });
});
