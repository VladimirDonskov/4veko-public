import { describe, expect, it } from "vitest";
import { cents, lineAmount, sum, taxOn } from "../src/lib/money";

describe("money arithmetic (decimal, never floating point)", () => {
  it("adds amounts that break binary floating point", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sum(["0.10", "0.20"]).toFixed(2)).toBe("0.30");
  });

  it("rounds half up to cents", () => {
    expect(cents("2.345")).toBe("2.35");
    expect(cents("2.344")).toBe("2.34");
    expect(cents("-2.345")).toBe("-2.35");
  });

  it("computes line amounts with discounts", () => {
    expect(lineAmount("3", "19.99")).toBe("59.97");
    expect(lineAmount("2.5", "10.00", "10")).toBe("22.50");
    expect(lineAmount("1", "0.05", "50")).toBe("0.03");
    expect(lineAmount("7", "14.285")).toBe("100.00");
  });

  it("computes sales tax once on the taxable subtotal", () => {
    expect(taxOn("100.00", "8.25")).toBe("8.25");
    expect(taxOn("19.99", "7.25")).toBe("1.45");
    expect(taxOn("0", "8.25")).toBe("0.00");
  });

  it("handles large amounts exactly", () => {
    expect(sum(["9999999999999.99", "0.01"]).toFixed(2)).toBe("10000000000000.00");
  });
});
