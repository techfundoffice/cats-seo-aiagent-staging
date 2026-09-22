import { describe, expect, it } from "vitest";
import * as amazon from "../amazon";

describe("Creators-only product search", () => {
  it("does not export the legacy PA-API v5 keyword search", () => {
    expect(amazon).not.toHaveProperty("fetchViaPaApi");
    expect(typeof amazon.fetchViaCreatorsApi).toBe("function");
  });
});
