/**
 * Currency metadata + formatting helpers for Primebrick services.
 *
 * Uses `countries-list` for ISO 4217 currency data and country→currency mapping.
 * The FE has its own independent copy of these helpers (it cannot import from the SDK).
 *
 * @module currency-helpers
 */
import { getCurrency, currencies } from "countries-list/currencies";
import { getCountryData } from "countries-list";
import type { TCurrencyCode, TCountryCode } from "countries-list";

/** ISO 4217 currency metadata. */
export interface CurrencyInfo {
  code: string;
  name: string;
  symbol: string;
  symbolNative: string;
  numeric: string;
  decimals: number;
}

/** Get ISO 4217 metadata for a currency code. Returns null for unknown codes. */
export function getCurrencyInfo(code: string): CurrencyInfo | null {
  try {
    const raw = getCurrency(code as TCurrencyCode);
    // countries-list returns a partial object ({code}) for unknown codes — treat as unknown
    if (!raw || !raw.name || !raw.symbol) return null;
    return {
      code: raw.code,
      name: raw.name,
      symbol: raw.symbol,
      symbolNative: raw.symbolNative,
      numeric: raw.numeric,
      decimals: raw.decimals,
    };
  } catch {
    return null;
  }
}

/** Get the currency symbol for a currency code (e.g. "EUR" → "€"). Falls back to the code. */
export function currencySymbol(code: string): string {
  return getCurrencyInfo(code)?.symbol ?? code;
}

/** Get the number of decimal places for a currency code (e.g. "EUR" → 2, "JPY" → 0). Falls back to 2. */
export function currencyDecimals(code: string): number {
  return getCurrencyInfo(code)?.decimals ?? 2;
}

/** Get the full list of ISO 4217 currencies (for currency selector dropdowns). */
export function getAllCurrencies(): CurrencyInfo[] {
  return Object.entries(currencies).map(([code, raw]) => ({
    code,
    name: raw.name,
    symbol: raw.symbol,
    symbolNative: raw.symbolNative,
    numeric: raw.numeric,
    decimals: raw.decimals,
  }));
}

/**
 * Derive the default currency code from a locale string.
 * Uses the region suffix: "it-IT" → "IT" → getCountryData("IT").currency → "EUR".
 * Falls back to "EUR" for unknown locales.
 */
export function defaultCurrencyForLang(lang: string): string {
  const region = lang.split("-")[1];
  if (!region) return "EUR";
  try {
    const country = getCountryData(region.toUpperCase() as TCountryCode);
    return country?.currency?.[0] ?? "EUR";
  } catch {
    return "EUR";
  }
}

/**
 * Format a numeric amount as a localized currency string.
 * Uses Intl.NumberFormat with the currency's native decimal precision.
 * Returns empty string for null/undefined values.
 */
export function formatMoney(
  amount: number | null | undefined,
  lang: string,
  currency: string,
): string {
  if (amount === null || amount === undefined) return "";
  const decimals = currencyDecimals(currency);
  return new Intl.NumberFormat(lang, {
    style: "currency",
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}
