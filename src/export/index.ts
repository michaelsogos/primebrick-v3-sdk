import { logger } from "../lifecycle/logger.js";
import { extJsonParse, extJsonStringify } from "../json/ext-json.js";
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Handlebars from 'handlebars';
import type {
  ExportConfig,
  ExportOutputPaths,
  ExportOutputStreams,
  ExportFieldMapping,
  ExportFieldMetadata,
} from './types.js';
import {
  getExcelDatePattern,
  getExcelDateTimePattern,
  getExcelNumberPattern,
  getExcelCurrencyPattern,
  getExcelPercentagePattern,
  applyTimezone,
  formatHtmlDate,
  formatHtmlNumber,
  formatHtmlCurrency,
  formatHtmlPercentage,
} from './helpers.js';
import enGB from "./en-GB.json" with { type: "json" };
import itIT from "./it-IT.json" with { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Pre-process HTML template to convert our patterns to Handlebars syntax
 * @param template - HTML template string with {#fieldName} and {?translationKey} patterns
 * @returns Template string converted to Handlebars syntax
 */
function preprocessTemplate(template: string): string {
  // Convert {#fieldName} to {{fieldName}} (but not {{#...}} or {{/...}} which is native Handlebars)
  // Use negative lookbehind to avoid matching inside {{#...}} or {{/...}}
  let processed = template.replace(/(?<!\{)\{#([^}]+)\}(?!\})/g, '{{$1}}');
  
  // Convert {?translationKey} to {{translationKey}}
  processed = processed.replace(/(?<!\{)\{\?([^}]+)\}(?!\})/g, '{{$1}}');
  
  return processed;
}

/**
 * Load translations from i18n file based on locale
 * @param locale - ISO locale string (e.g., 'en-GB', 'it-IT')
 * @returns Translation object
 */
async function loadTranslations(locale: string): Promise<Record<string, string>> {
  const dict = BUNDLED_I18N[locale];
  if (!dict) {
    logger.warn(`Translation file for locale "${locale}" not found, using empty translations`, { tags: ["export"] });
    return {};
  }
  return dict;
}

const BUNDLED_I18N: Record<string, Record<string, string>> = {
  "en-GB": enGB,
  "it-IT": itIT,
};

/**
 * Resolve field name through mapping
 * @param fieldName - Field name from template
 * @param fieldMapping - Mapping object
 * @returns Mapped field name or original
 */
function resolveFieldName(fieldName: string, fieldMapping: ExportFieldMapping): string {
  return fieldMapping[fieldName] || fieldName;
}

/**
 * Resolve translation key through mapping and translations
 * @param translationKey - Translation key from template
 * @param fieldMapping - Mapping object
 * @param translations - Translations object
 * @returns Translated value or original key
 */
function resolveTranslation(
  translationKey: string,
  fieldMapping: ExportFieldMapping,
  translations: Record<string, string>
): string {
  const mappedKey = fieldMapping[translationKey] || translationKey;
  return translations[mappedKey] || translationKey;
}

/**
 * Convert row array to CSV format (RFC 4180)
 * @param arr - Row values array
 * @returns CSV formatted string
 */
function convertToCsvRow(arr: (string | number | Date | null | undefined)[]): string {
  return arr.map(val => {
    if (val === null || val === undefined) return '';
    let stringVal = val.toString();
    // Escape quotes, commas, and newlines
    if (stringVal.includes('"') || stringVal.includes(',') || stringVal.includes('\n') || stringVal.includes('\r')) {
      stringVal = stringVal.replace(/"/g, '""');
      return `"${stringVal}"`;
    }
    return stringVal;
  }).join(',') + '\n';
}

/**
 * Export data to Excel and CSV using template-based approach (writes to files)
 * @param templatePath - Path to Excel template file
 * @param outputPaths - Output paths for Excel and CSV
 * @param config - Export configuration
 */
export async function exportDataWithTemplate(
  templatePath: string,
  outputPaths: ExportOutputPaths,
  config: ExportConfig
): Promise<void> {
  const {
    locale,
    defaultTimezone,
    entity,
    translations: userTranslations,
    fieldMapping,
    metadata,
    data,
  } = config;

  // Load base translations from i18n file and merge with user translations
  const baseTranslations = await loadTranslations(locale);
  const translations = { ...baseTranslations, ...userTranslations };

  // ----------------------------------------------------
  // PHASE 1: TEMPLATE SCANNING (Fast read)
  // ----------------------------------------------------
  const readerWorkbook = new ExcelJS.Workbook();
  await readerWorkbook.xlsx.readFile(templatePath);
  
  const originalSheet = readerWorkbook.getWorksheet(1);
  if (!originalSheet) {
    throw new Error('Template must have at least one worksheet');
  }

  // Use entity.plural as sheet name
  const targetSheetName = entity.plural
    .replace(/[\\\/?:\[\]*]/g, '') // Remove invalid Excel characters
    .substring(0, 31); // Excel max length

  let dataStartRow = -1;
  const colMapping: Record<number, string> = {};
  const staticRows: Record<number, (string | number | null | undefined)[]> = [];
  const staticRowStyles: Record<number, Record<number, any>> = {};

  // Analyze template structure
  originalSheet.eachRow((row, rowNumber) => {
    let isDataRow = false;
    const rowValues: (string | number | null | undefined)[] = [];
    const rowStyles: Record<number, any> = {};

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const val = cell.value?.toString() || '';
      
      // Store cell style from template
      if (cell.style) {
        rowStyles[colNumber] = cell.style;
      }
      
      // 1. Identify vertical loop for data
      if (val.startsWith('{#')) {
        isDataRow = true;
        const fieldName = val.replace('{#', '').replace('}', '');
        colMapping[colNumber] = fieldName;
        rowValues[colNumber] = ''; // Clear tag for final file
      } 
      // 2. Identify scalar translation (e.g., column titles)
      else if (val.startsWith('{?')) {
        const translationKey = val.replace('{?', '').replace('}', '');
        rowValues[colNumber] = resolveTranslation(translationKey, fieldMapping, translations);
      } 
      // 3. Static text or empty cell
      else {
        rowValues[colNumber] = cell.value as string | number | null | undefined;
      }
    });

    if (isDataRow) {
      dataStartRow = rowNumber;
    } else if (dataStartRow === -1) {
      // Store header/logo rows before data
      staticRows[rowNumber] = rowValues;
      staticRowStyles[rowNumber] = rowStyles;
    }
  });

  if (dataStartRow === -1) {
    throw new Error('Invalid template: no vertical loop tag {#field} found');
  }

  // ----------------------------------------------------
  // PHASE 2: STREAMING GENERATION (Excel & CSV)
  // ----------------------------------------------------
  
  // Initialize streaming writer for Excel (constant RAM)
  const excelWriter = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: outputPaths.excelOutputPath,
    useStyles: true,
    useSharedStrings: true
  });
  const writerSheet = excelWriter.addWorksheet(targetSheetName);

  // Initialize CSV stream
  const csvWriteStream = fs.createWriteStream(outputPaths.csvOutputPath, { encoding: 'utf8' });

  // 1. Write static rows and translated headers (common to Excel and CSV)
  for (let i = 1; i < dataStartRow; i++) {
    const rowValues = staticRows[i] || [];
    const rowStyles = staticRowStyles[i] || {};
    
    // Write to Excel
    const excelRow = writerSheet.addRow(rowValues);
    
    // Apply cell styles from template
    Object.keys(rowStyles).forEach(colNum => {
      const colNumber = parseInt(colNum, 10);
      const cell = excelRow.getCell(colNumber);
      if (cell && rowStyles[colNumber as keyof typeof rowStyles]) {
        const style = rowStyles[colNumber as keyof typeof rowStyles];
        // Apply individual style properties
        if (style.font) cell.font = { ...style.font };
        if (style.fill) cell.fill = { ...style.fill };
        if (style.border) cell.border = { ...style.border };
        if (style.alignment) cell.alignment = { ...style.alignment };
        if (style.numFmt) cell.numFmt = style.numFmt;
      }
    });
    
    excelRow.commit();
    
    // Write to CSV (skip index 0 which ExcelJS uses as empty)
    const cleanCsvRow = rowValues.slice(1);
    csvWriteStream.write(convertToCsvRow(cleanCsvRow));
  }

  // 2. Massive loop on records (Pure streaming)
  for await (const record of data) {
    const rowData: (string | number | Date | null)[] = [];
    
    // Inject record only in mapped columns from template
    Object.keys(colMapping).forEach(colNum => {
      const colNumber = parseInt(colNum, 10);
      const fieldName = colMapping[colNumber];
      const mappedFieldName = resolveFieldName(fieldName, fieldMapping);
      const fieldMetadata = metadata.fields[mappedFieldName];
      
      let value: string | number | Date | null = record[mappedFieldName] as string | number | Date | null;

      // Apply formatting based on field metadata
      if (fieldMetadata) {
        switch (fieldMetadata.type) {
          case 'date':
          case 'datetime':
            if (value) {
              const timezone = fieldMetadata.timezoneField 
                ? (record[fieldMetadata.timezoneField] as string)
                : undefined;
              value = applyTimezone(value as Date | string, timezone, defaultTimezone);
            }
            break;
          case 'number':
            // Keep as number, formatting will be applied via numFmt
            break;
          case 'currency':
            // Keep as number, formatting will be applied via numFmt
            break;
          case 'percentage':
            // Keep as number (0.2 for 20%), formatting will be applied via numFmt
            break;
          default:
            // string or other: keep as is
            break;
        }
      }

      rowData[colNumber] = value !== undefined && value !== null ? value : '';
    });

    // Write row to Excel and clear RAM immediately
    const excelRow = writerSheet.addRow(rowData);
    
    // Apply number formats to cells based on metadata
    Object.keys(colMapping).forEach(colNum => {
      const colNumber = parseInt(colNum, 10);
      const fieldName = colMapping[colNumber];
      const mappedFieldName = resolveFieldName(fieldName, fieldMapping);
      const fieldMetadata = metadata.fields[mappedFieldName];
      
      if (fieldMetadata) {
        const cell = excelRow.getCell(colNumber);
        
        switch (fieldMetadata.type) {
          case 'date':
            cell.numFmt = getExcelDatePattern(locale);
            break;
          case 'datetime':
            cell.numFmt = getExcelDateTimePattern(locale);
            break;
          case 'number':
            cell.numFmt = getExcelNumberPattern(typeof fieldMetadata.precision === 'number' ? fieldMetadata.precision : 2);
            break;
          case 'currency': {
            const currencyCode = fieldMetadata.currencyField
              ? (record[fieldMetadata.currencyField] as string)
              : 'EUR';
            cell.numFmt = getExcelCurrencyPattern(locale, currencyCode, typeof fieldMetadata.precision === 'number' ? fieldMetadata.precision : 2);
            break;
          }
          case 'percentage':
            cell.numFmt = getExcelPercentagePattern(typeof fieldMetadata.precision === 'number' ? fieldMetadata.precision : 2);
            break;
        }
      }
    });
    
    excelRow.commit();

    // Write same row to CSV
    const cleanCsvDataRow = rowData.slice(1);
    csvWriteStream.write(convertToCsvRow(cleanCsvDataRow));
  }

  // Close and save final files
  csvWriteStream.end();
  await excelWriter.commit();
}

/**
 * Export data to HTML using template-based approach with Handlebars
 * @param templatePath - Path to HTML template file
 * @param outputStream - Output stream for HTML
 * @param config - Export configuration
 */
async function generateHtmlExport(
  templatePath: string,
  outputStream: NodeJS.WritableStream,
  config: ExportConfig
): Promise<void> {
  const {
    locale,
    defaultTimezone,
    translations: userTranslations,
    fieldMapping,
    metadata,
    data,
  } = config;

  // Load base translations from i18n file and merge with user translations
  const baseTranslations = await loadTranslations(locale);
  const translations = { ...baseTranslations, ...userTranslations };

  // Read HTML template
  const templateContent = await fs.promises.readFile(templatePath, 'utf-8');

  // Pre-process template: convert {#} and {?} to Handlebars syntax
  const processedTemplate = preprocessTemplate(templateContent);

  // Compile Handlebars template
  const template = Handlebars.compile(processedTemplate);

  // Collect all data records for Handlebars
  const dataRecords: Record<string, unknown>[] = [];
  for await (const record of data) {
    const formattedRecord: Record<string, unknown> = {};
    
    // Process each field according to metadata
    Object.keys(record).forEach(fieldName => {
      const mappedFieldName = resolveFieldName(fieldName, fieldMapping);
      const fieldMetadata = metadata.fields[mappedFieldName];
      
      let value = record[fieldName];
      
      // Apply formatting based on field metadata
      if (fieldMetadata) {
        switch (fieldMetadata.type) {
          case 'date':
            value = formatHtmlDate(
              value as Date | string,
              locale,
              fieldMetadata.timezoneField ? (record[fieldMetadata.timezoneField] as string) : undefined,
              defaultTimezone,
              false
            );
            break;
          case 'datetime':
            value = formatHtmlDate(
              value as Date | string,
              locale,
              fieldMetadata.timezoneField ? (record[fieldMetadata.timezoneField] as string) : undefined,
              defaultTimezone,
              true
            );
            break;
          case 'number':
            value = formatHtmlNumber(
              value as number,
              locale,
              typeof fieldMetadata.precision === 'number' ? fieldMetadata.precision : 2
            );
            break;
          case 'currency': {
            const currencyCode = fieldMetadata.currencyField
              ? (record[fieldMetadata.currencyField] as string)
              : 'EUR';
            value = formatHtmlCurrency(
              value as number,
              locale,
              currencyCode,
              typeof fieldMetadata.precision === 'number' ? fieldMetadata.precision : 2
            );
            break;
          }
          case 'percentage':
            value = formatHtmlPercentage(
              value as number,
              locale,
              typeof fieldMetadata.precision === 'number' ? fieldMetadata.precision : 2
            );
            break;
          default:
            // string or other: keep as is
            break;
        }
      }
      
      formattedRecord[mappedFieldName] = value;
    });
    
    dataRecords.push(formattedRecord);
  }

  // Prepare context for Handlebars
  const context = {
    data: dataRecords,
    ...translations,
  };

  // Generate HTML
  const html = template(context);

  // Write to output stream
  outputStream.write(html);
  outputStream.end();
}

/**
 * Export data to Excel, CSV, or HTML using template-based approach (streams to HTTP response)
 * @param templatePath - Path to template file (Excel for xlsx/csv, HTML for html)
 * @param outputStream - Output stream for the requested format
 * @param fileType - File type to export ('xlsx', 'csv', or 'html')
 * @param config - Export configuration
 */
export async function exportDataWithTemplateToStream(
  templatePath: string,
  outputStream: NodeJS.WritableStream,
  fileType: 'xlsx' | 'csv' | 'html',
  config: ExportConfig
): Promise<void> {
  const {
    locale,
    defaultTimezone,
    entity,
    translations: userTranslations,
    fieldMapping,
    metadata,
    data,
  } = config;

  // Load base translations from i18n file and merge with user translations
  const baseTranslations = await loadTranslations(locale);
  const translations = { ...baseTranslations, ...userTranslations };

  // Handle HTML export separately
  if (fileType === 'html') {
    await generateHtmlExport(templatePath, outputStream, config);
    return;
  }

  // ----------------------------------------------------
  // PHASE 1: TEMPLATE SCANNING (Fast read) - Excel/CSV only
  // ----------------------------------------------------
  const readerWorkbook = new ExcelJS.Workbook();
  await readerWorkbook.xlsx.readFile(templatePath);
  
  const originalSheet = readerWorkbook.getWorksheet(1);
  if (!originalSheet) {
    throw new Error('Template must have at least one worksheet');
  }

  // Use entity.plural as sheet name
  const targetSheetName = entity.plural
    .replace(/[\\\/?:\[\]*]/g, '') // Remove invalid Excel characters
    .substring(0, 31); // Excel max length

  let dataStartRow = -1;
  const colMapping: Record<number, string> = {};
  const staticRows: Record<number, (string | number | null | undefined)[]> = [];
  const staticRowStyles: Record<number, Record<number, any>> = {};

  // Analyze template structure
  originalSheet.eachRow((row, rowNumber) => {
    let isDataRow = false;
    const rowValues: (string | number | null | undefined)[] = [];
    const rowStyles: Record<number, any> = {};

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const val = cell.value?.toString() || '';
      
      // Store cell style from template
      if (cell.style) {
        rowStyles[colNumber] = cell.style;
      }
      
      // 1. Identify vertical loop for data
      if (val.startsWith('{#')) {
        isDataRow = true;
        const fieldName = val.replace('{#', '').replace('}', '');
        colMapping[colNumber] = fieldName;
        rowValues[colNumber] = ''; // Clear tag for final file
      } 
      // 2. Identify scalar translation (e.g., column titles)
      else if (val.startsWith('{?')) {
        const translationKey = val.replace('{?', '').replace('}', '');
        rowValues[colNumber] = resolveTranslation(translationKey, fieldMapping, translations);
      } 
      // 3. Static text or empty cell
      else {
        rowValues[colNumber] = cell.value as string | number | null | undefined;
      }
    });

    if (isDataRow) {
      dataStartRow = rowNumber;
    } else if (dataStartRow === -1) {
      // Store header/logo rows before data
      staticRows[rowNumber] = rowValues;
      staticRowStyles[rowNumber] = rowStyles;
    }
  });

  if (dataStartRow === -1) {
    throw new Error('Invalid template: no vertical loop tag {#field} found');
  }

  // ----------------------------------------------------
  // PHASE 2: STREAMING GENERATION
  // ----------------------------------------------------
  
  if (fileType === 'xlsx') {
    // Load template into regular workbook to preserve styles
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);
    
    const sheet = workbook.getWorksheet(1);
    if (!sheet) {
      throw new Error('Template must have at least one worksheet');
    }
    
    // Use entity.plural as sheet name
    const targetSheetName = entity.plural
      .replace(/[\\\/?:\[\]*]/g, '') // Remove invalid Excel characters
      .substring(0, 31); // Excel max length
    sheet.name = targetSheetName;

    // Detect and save table configuration if exists
    let tableConfig: any = null;
    let tableExists = false;
    try {
      const tables = sheet.getTables();
      // getTables returns a tuple [Table, void], so we need to handle it
      const table = Array.isArray(tables) ? tables[0] : tables;
      if (table && typeof table === 'object' && 'name' in table) {
        const tableObj = table as any;
        tableConfig = {
          name: tableObj.name,
          displayName: tableObj.displayName,
          headerRow: tableObj.headerRow,
          style: tableObj.style,
          theme: tableObj.theme,
          showFirstColumn: tableObj.showFirstColumn,
          showLastColumn: tableObj.showLastColumn,
          showRowStripes: tableObj.showRowStripes,
          showColumnStripes: tableObj.showColumnStripes,
        };
        tableExists = true;
        // Remove the table to avoid corruption when inserting rows
        sheet.removeTable(tableObj.name);
      }
    } catch (e) {
      // No table or error reading table config - continue without table
    }

    // Find and replace template tags with data
    let dataStartRow = -1;
    const colMapping: Record<number, string> = {};

    sheet.eachRow((row, rowNumber) => {
      let isDataRow = false;
      
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const val = cell.value?.toString() || '';
        
        // 1. Identify vertical loop for data
        if (val.startsWith('{#')) {
          isDataRow = true;
          const fieldName = val.replace('{#', '').replace('}', '');
          colMapping[colNumber] = fieldName;
          cell.value = ''; // Clear tag
        } 
        // 2. Identify scalar translation (e.g., column titles)
        else if (val.startsWith('{?')) {
          const translationKey = val.replace('{?', '').replace('}', '');
          cell.value = resolveTranslation(translationKey, fieldMapping, translations);
        }
      });

      if (isDataRow) {
        dataStartRow = rowNumber;
      }
    });

    if (dataStartRow === -1) {
      throw new Error('Invalid template: no vertical loop tag {#field} found');
    }

    // Build column definitions for table if table exists
    const originalColumnNames: string[] = [];
    const tableColumns = tableExists ? Object.keys(colMapping)
      .map(colNum => parseInt(colNum, 10))
      .sort((a, b) => a - b)
      .map(colNum => {
        const rawName = sheet.getRow(dataStartRow - 1).getCell(colNum).value?.toString() || `Column${colNum}`;
        // Store original name before sanitization
        originalColumnNames.push(rawName);
        // Sanitize column name: replace spaces and invalid characters with underscores
        // const sanitizedName = rawName.replace(/[^a-zA-Z0-9]/g, '_');
        // Use original name directly (test)
        const sanitizedName = rawName;
        return {
          name: sanitizedName,
          filterButton: false,
        };
      }) : [];

    logger.info('Table columns:', { tags: ["export"], error: tableColumns.map(c => c.name) });

    // Stream data and insert rows into worksheet
    let rowCount = dataStartRow; // Start from data row (header is at dataStartRow - 1)
    let firstRecord = true;
    let recordCount = 0;
    
    for await (const record of data) {
      const rowData: (string | number | Date | null)[] = [];
      
      // Sort column numbers to ensure correct order
      const sortedColNumbers = Object.keys(colMapping)
        .map(colNum => parseInt(colNum, 10))
        .sort((a, b) => a - b);
      
      sortedColNumbers.forEach((colNumber, index) => {
        const fieldName = colMapping[colNumber as keyof typeof colMapping];
        const mappedFieldName = resolveFieldName(fieldName, fieldMapping);
        const fieldMetadata = metadata.fields[mappedFieldName];
        
        let value: string | number | Date | null = record[mappedFieldName] as string | number | Date | null;

        if (fieldMetadata) {
          switch (fieldMetadata.type) {
            case 'date':
            case 'datetime':
              if (value) {
                const timezone = fieldMetadata.timezoneField 
                  ? (record[fieldMetadata.timezoneField] as string)
                  : undefined;
                value = applyTimezone(value as Date | string, timezone, defaultTimezone);
              }
              break;
          }
        }

        // Use 0-based index for rowData array
        rowData[index] = value !== undefined && value !== null ? value : '';
      });

      logger.info('Row data:', { tags: ["export"], error: rowData });
      
      let newRow;
      if (firstRecord) {
        // Modify the template row in place for the first record
        newRow = sheet.getRow(dataStartRow);
        newRow.values = rowData;
        firstRecord = false;
      } else {
        // Insert new row for subsequent records
        newRow = sheet.addRow(rowData);
        rowCount++;
      }
      recordCount++;
      
      // Copy styles from template row
      const templateRow = sheet.getRow(dataStartRow);
      templateRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (cell.style) {
          const newCell = newRow.getCell(colNumber);
          if (newCell) {
            newCell.style = extJsonParse(extJsonStringify(cell.style));
          }
        }
      });
    }

    // Calculate the actual last data row
    const actualLastRow = firstRecord ? dataStartRow - 1 : rowCount;

    // Create table after data is inserted with correct ref if table existed in template
    if (tableExists && tableColumns.length > 0 && actualLastRow >= dataStartRow) {
      const maxColNumber = Math.max(...Object.keys(colMapping).map(Number));
      
      // Convert column number to letter (1 = A, 2 = B, etc.)
      const columnNumberToLetter = (num: number): string => {
        let letters = '';
        while (num > 0) {
          const remainder = (num - 1) % 26;
          letters = String.fromCharCode(65 + remainder) + letters;
          num = Math.floor((num - 1) / 26);
        }
        return letters;
      };
      
      const endColumnLetter = columnNumberToLetter(maxColNumber);
      const headerRow = dataStartRow - 1;
      const tableRef = `A${headerRow}:${endColumnLetter}${actualLastRow}`;
      logger.info('Creating table with ref:', { tags: ["export"], error: tableRef });
      
      // Create fake rows array to force ExcelJS to calculate correct table height
      const fakeRows = Array.from({ length: actualLastRow - headerRow }, () => []);
      
      const exportTable = sheet.addTable({
        name: tableConfig.name || 'ExportTable',
        ref: tableRef,
        headerRow: true,
        style: {
          theme: tableConfig.style || 'TableStyleMedium9',
          showRowStripes: tableConfig.showRowStripes !== false,
          showColumnStripes: tableConfig.showColumnStripes || false,
        },
        columns: tableColumns,
        rows: fakeRows,
      });
      
      // Commit to force XML metadata save
      exportTable.commit();
      
      // Restore original column names in header cells for display
      // const headerRowObj = sheet.getRow(headerRow);
      // originalColumnNames.forEach((originalName, index) => {
      //   headerRowObj.getCell(index + 1).value = originalName;
      // });
      // headerRowObj.commit();
    }

    // Write to buffer and then to stream
    const buffer = await workbook.xlsx.writeBuffer();
    outputStream.write(Buffer.from(buffer));
    outputStream.end();
  } else {
    // CSV export - scan template to get static rows
    const readerWorkbook = new ExcelJS.Workbook();
    await readerWorkbook.xlsx.readFile(templatePath);
    const originalSheet = readerWorkbook.getWorksheet(1);
    if (!originalSheet) {
      throw new Error('Template must have at least one worksheet');
    }

    let dataStartRow = -1;
    const staticRows: Record<number, (string | number | null | undefined)[]> = [];
    const colMapping: Record<number, string> = {};

    originalSheet.eachRow((row, rowNumber) => {
      let isDataRow = false;
      const rowValues: (string | number | null | undefined)[] = [];

      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const val = cell.value?.toString() || '';
        
        if (val.startsWith('{#')) {
          isDataRow = true;
          const fieldName = val.replace('{#', '').replace('}', '');
          colMapping[colNumber] = fieldName;
          rowValues[colNumber] = '';
        } 
        else if (val.startsWith('{?')) {
          const translationKey = val.replace('{?', '').replace('}', '');
          rowValues[colNumber] = resolveTranslation(translationKey, fieldMapping, translations);
        } 
        else {
          rowValues[colNumber] = cell.value as string | number | null | undefined;
        }
      });

      if (isDataRow) {
        dataStartRow = rowNumber;
      } else if (dataStartRow === -1) {
        staticRows[rowNumber] = rowValues;
      }
    });

    if (dataStartRow === -1) {
      throw new Error('Invalid template: no vertical loop tag {#field} found');
    }

    // Write static rows to CSV
    for (let i = 1; i < dataStartRow; i++) {
      const rowValues = staticRows[i] || [];
      const cleanCsvRow = rowValues.slice(1);
      outputStream.write(convertToCsvRow(cleanCsvRow));
    }

    // Write data rows to CSV
    for await (const record of data) {
      const rowData: (string | number | Date | null)[] = [];
      
      Object.keys(colMapping).forEach(colNum => {
        const colNumber = parseInt(colNum, 10);
        const fieldName = colMapping[colNumber];
        const mappedFieldName = resolveFieldName(fieldName, fieldMapping);
        const fieldMetadata = metadata.fields[mappedFieldName];
        
        let value: string | number | Date | null = record[mappedFieldName] as string | number | Date | null;

        if (fieldMetadata) {
          switch (fieldMetadata.type) {
            case 'date':
            case 'datetime':
              if (value) {
                const timezone = fieldMetadata.timezoneField 
                  ? (record[fieldMetadata.timezoneField] as string)
                  : undefined;
                value = applyTimezone(value as Date | string, timezone, defaultTimezone);
              }
              break;
          }
        }

        rowData[colNumber] = value !== undefined && value !== null ? value : '';
      });

      const cleanCsvDataRow = rowData.slice(1);
      outputStream.write(convertToCsvRow(cleanCsvDataRow));
    }

    outputStream.end();
  }
}
