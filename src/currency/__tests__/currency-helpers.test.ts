import { describe, it, expect } from "vitest";
import {
  getCurrencyInfo,
  currencySymbol,
  currencyDecimals,
  getAllCurrencies,
  defaultCurrencyForLang,
  formatMoney,
} from "../currency-helpers.js";

describe("getCurrencyInfo", () => {
  it("returns metadata for EUR", () => {
    const info = getCurrencyInfo("EUR");
    expect(info).not.toBeNull();
    expect(info!.code).toBe("EUR");
    expect(info!.name).toBe("Euro");
    expect(info!.symbol).toBe("€");
    expect(info!.decimals).toBe(2);
  });

  it("returns metadata for JPY with 0 decimals", () => {
    const info = getCurrencyInfo("JPY");
    expect(info).not.toBeNull();
    expect(info!.code).toBe("JPY");
    expect(info!.name).toBe("Japanese Yen");
    expect(info!.decimals).toBe(0);
  });

  it("returns null for unknown currency code", () => {
    expect(getCurrencyInfo("ZZZ")).toBeNull();
  });
});

describe("currencySymbol", () => {
  it("returns € for EUR", () => {
    expect(currencySymbol("EUR")).toBe("€");
  });

  it("returns $ for USD", () => {
    expect(currencySymbol("USD")).toBe("$");
  });

  it("returns ¥ for JPY", () => {
    expect(currencySymbol("JPY")).toBe("¥");
  });

  it("falls back to code for unknown currency", () => {
    expect(currencySymbol("XYZ")).toBe("XYZ");
  });
});

describe("currencyDecimals", () => {
  it("returns 2 for EUR", () => {
    expect(currencyDecimals("EUR")).toBe(2);
  });

  it("returns 0 for JPY", () => {
    expect(currencyDecimals("JPY")).toBe(0);
  });

  it("falls back to 2 for unknown currency", () => {
    expect(currencyDecimals("XYZ")).toBe(2);
  });
});

describe("getAllCurrencies", () => {
  it("returns array with at least 150 currencies", () => {
    const all = getAllCurrencies();
    expect(all.length).toBeGreaterThanOrEqual(150);
  });

  it("each entry has code, name, symbol, decimals", () => {
    const all = getAllCurrencies();
    const eur = all.find((c) => c.code === "EUR");
    expect(eur).toBeDefined();
    expect(eur!.name).toBe("Euro");
    expect(eur!.symbol).toBe("€");
    expect(eur!.decimals).toBe(2);
  });
});

describe("defaultCurrencyForLang", () => {
  it("returns EUR for it-IT", () => {
    expect(defaultCurrencyForLang("it-IT")).toBe("EUR");
  });

  it("returns USD for en-US", () => {
    expect(defaultCurrencyForLang("en-US")).toBe("USD");
  });

  it("returns GBP for en-GB", () => {
    expect(defaultCurrencyForLang("en-GB")).toBe("GBP");
  });

  it("returns JPY for ja-JP", () => {
    expect(defaultCurrencyForLang("ja-JP")).toBe("JPY");
  });

  it("falls back to EUR for unknown locale", () => {
    expect(defaultCurrencyForLang("xx-XX")).toBe("EUR");
  });

  it("falls back to EUR when no region suffix", () => {
    expect(defaultCurrencyForLang("it")).toBe("EUR");
  });
});

describe("formatMoney", () => {
  it("formats EUR with Italian locale", () => {
    const result = formatMoney(1234.56, "it-IT", "EUR");
    // Italian locale uses , for decimals (thousands separator depends on ICU data)
    expect(result).toMatch(/1234[,]56/);
    expect(result).toContain("€");
  });

  it("formats USD with US locale", () => {
    const result = formatMoney(1234.56, "en-US", "USD");
    expect(result).toContain("1,234.56");
    expect(result).toContain("$");
  });

  it("formats GBP with UK locale", () => {
    const result = formatMoney(1234.56, "en-GB", "GBP");
    expect(result).toContain("1,234.56");
    expect(result).toContain("£");
  });

  it("formats zero", () => {
    const result = formatMoney(0, "it-IT", "EUR");
    expect(result).toContain("0,00");
  });

  it("returns empty string for null", () => {
    expect(formatMoney(null, "it-IT", "EUR")).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(formatMoney(undefined, "it-IT", "EUR")).toBe("");
  });

  it("formats JPY with no decimals", () => {
    const result = formatMoney(1000, "ja-JP", "JPY");
    expect(result).toContain("1,000");
    expect(result).not.toContain(".");
  });
});
