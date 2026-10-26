export interface ExportFieldMapping {
  [key: string]: string;
}

export type ExportFileType = 'xlsx' | 'csv' | 'html';

export interface ExportFieldMetadata {
  type: 'string' | 'number' | 'date' | 'datetime' | 'currency' | 'percentage';
  precision?: number | 'seconds';
  timezoneField?: string;
  currencyField?: string;
}

export interface ExportMetadata {
  fields: {
    [fieldName: string]: ExportFieldMetadata;
  };
}

export interface ExportTranslations {
  [key: string]: string;
}

export interface ExportEntity {
  singular: string;
  plural: string;
}

export interface ExportConfig {
  locale: string;
  defaultTimezone: string;
  entity: ExportEntity;
  translations: ExportTranslations;
  fieldMapping: ExportFieldMapping;
  metadata: ExportMetadata;
  data: AsyncIterable<Record<string, unknown>> | Array<Record<string, unknown>>;
}

export interface ExportOutputPaths {
  excelOutputPath: string;
  csvOutputPath: string;
}

export interface ExportOutputStreams {
  excelStream: NodeJS.WritableStream;
  csvStream: NodeJS.WritableStream;
}
