/**
 * Helper functions for Excel format patterns based on locale
 */

/**
 * Get Excel date pattern from locale
 * @param locale - ISO locale string (e.g., 'it-IT', 'en-GB')
 * @returns Excel date format pattern (e.g., 'dd/mm/yyyy')
 */
export function getExcelDatePattern(locale: string): string {
  const testDate = new Date(2026, 4, 3); // 3 Maggio 2026
  
  const parts = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(testDate);

  return parts.map(part => {
    switch (part.type) {
      case 'day': return 'dd';
      case 'month': return 'mm';
      case 'year': return 'yyyy';
      case 'literal': return part.value;
      default: return '';
    }
  }).join('');
}

/**
 * Get Excel datetime pattern from locale (includes time up to seconds)
 * @param locale - ISO locale string (e.g., 'it-IT', 'en-GB')
 * @returns Excel datetime format pattern (e.g., 'dd/mm/yyyy hh:mm:ss')
 */
export function getExcelDateTimePattern(locale: string): string {
  const datePattern = getExcelDatePattern(locale);
  return `${datePattern} hh:mm:ss`;
}

/**
 * Get Excel number pattern based on precision
 * @param precision - Number of decimal places
 * @returns Excel number format pattern (e.g., '#,##0.00')
 */
export function getExcelNumberPattern(precision: number): string {
  if (precision === 0) return '#,##0';
  const decimals = '0'.repeat(precision);
  return `#,##0.${decimals}`;
}

/**
 * Get Excel currency pattern dynamically using Intl
 * @param locale - ISO locale string (e.g., 'it-IT', 'en-GB')
 * @param currencyCode - ISO currency code (e.g., 'EUR', 'USD', 'GBP')
 * @param precision - Number of decimal places
 * @returns Excel currency format pattern (e.g., '"€"#,##0.00')
 */
export function getExcelCurrencyPattern(locale: string, currencyCode: string, precision: number): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: precision
  });

  const parts = formatter.formatToParts(1234.56);
  const currencySymbol = parts.find(p => p.type === 'currency')?.value || currencyCode;
  const isSymbolFirst = parts[0].type === 'currency';
  
  const numberPattern = getExcelNumberPattern(precision);
  
  return isSymbolFirst 
    ? `"${currencySymbol}"${numberPattern}` 
    : `${numberPattern}"${currencySymbol}"`;
}

/**
 * Get Excel percentage pattern based on precision
 * @param precision - Number of decimal places
 * @returns Excel percentage format pattern (e.g., '0.00%')
 */
export function getExcelPercentagePattern(precision: number): string {
  const decimals = precision > 0 ? '.' + '0'.repeat(precision) : '';
  return `0${decimals}%`;
}

/**
 * Apply timezone to a date value
 * @param dateValue - Date value to convert
 * @param timezone - Target timezone (IANA format, e.g., 'Europe/Rome')
 * @param defaultTimezone - Fallback timezone if none provided
 * @returns Date object converted to target timezone
 */
export function applyTimezone(dateValue: Date | string, timezone: string | undefined, defaultTimezone: string): Date {
  const tz = timezone || defaultTimezone;
  
  // Parse the date if it's a string
  const date = typeof dateValue === 'string' ? new Date(dateValue) : dateValue;
  
  // Convert to target timezone
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: tz
  };
  
  const formatted = new Intl.DateTimeFormat('en-US', options).format(date);
  return new Date(formatted);
}

/**
 * Format date for HTML using Intl
 * @param dateValue - Date value to format
 * @param locale - ISO locale string (e.g., 'it-IT', 'en-GB')
 * @param timezone - Target timezone (IANA format)
 * @param defaultTimezone - Fallback timezone
 * @param includeTime - Whether to include time portion
 * @returns Formatted date string
 */
export function formatHtmlDate(
  dateValue: Date | string | null | undefined,
  locale: string,
  timezone: string | undefined,
  defaultTimezone: string,
  includeTime: boolean = false
): string {
  if (!dateValue) return '';
  
  const tz = timezone || defaultTimezone;
  const date = typeof dateValue === 'string' ? new Date(dateValue) : dateValue;
  
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: tz
  };
  
  if (includeTime) {
    options.hour = '2-digit';
    options.minute = '2-digit';
    options.second = '2-digit';
  }
  
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/**
 * Format number for HTML using Intl
 * @param value - Number value to format
 * @param locale - ISO locale string
 * @param precision - Number of decimal places
 * @returns Formatted number string
 */
export function formatHtmlNumber(
  value: number | null | undefined,
  locale: string,
  precision: number = 2
): string {
  if (value === null || value === undefined) return '';
  
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision
  }).format(value);
}

/**
 * Format currency for HTML using Intl
 * @param value - Number value to format
 * @param locale - ISO locale string
 * @param currencyCode - ISO currency code (e.g., 'EUR', 'USD')
 * @param precision - Number of decimal places
 * @returns Formatted currency string
 */
export function formatHtmlCurrency(
  value: number | null | undefined,
  locale: string,
  currencyCode: string,
  precision: number = 2
): string {
  if (value === null || value === undefined) return '';
  
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    minimumFractionDigits: precision,
    maximumFractionDigits: precision
  }).format(value);
}

/**
 * Format percentage for HTML using Intl
 * @param value - Number value to format (0.2 for 20%)
 * @param locale - ISO locale string
 * @param precision - Number of decimal places
 * @returns Formatted percentage string
 */
export function formatHtmlPercentage(
  value: number | null | undefined,
  locale: string,
  precision: number = 2
): string {
  if (value === null || value === undefined) return '';
  
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: precision,
    maximumFractionDigits: precision
  }).format(value);
}
