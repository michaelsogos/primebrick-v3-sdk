# Excel/CSV Export Library

Template-based export library for generating Excel (XLSX) and CSV files with streaming support for large datasets.

## Features

- **Streaming architecture**: Constant RAM usage even with millions of records
- **Template-based**: Use Excel templates with placeholders for layout control
- **Locale-aware**: Dynamic date/number/currency formatting based on locale
- **Timezone support**: IANA timezone handling for date/datetime fields
- **Multi-format**: Generates both XLSX and CSV simultaneously
- **Metadata-driven**: Field formatting based on entity metadata

## Placeholders

### Scalar Values `{?field}`

Injects a single scalar value from translations or data.

**Example:**
```
{?report_title} → "Customer Report"
{?col_name} → "Name"
```

### Array Loops `{#field}`

Injects values from an array of objects in a vertical loop.

**Example:**
```
{#id} → Loops through all record.id values
{#name} → Loops through all record.name values
```

## Usage

```typescript
import { exportDataWithTemplate } from './lib/export/index.js';

// Configuration
const config = {
  locale: 'en-GB',
  defaultTimezone: 'Europe/Rome',
  entity: {
    singular: 'Customer',
    plural: 'Customers'
  },
  translations: {
    'report_title': 'Customer Report',
    'col_id': 'ID',
    'col_name': 'Name'
  },
  fieldMapping: {
    'codice_cliente': 'id',
    'nome_cliente': 'name'
  },
  metadata: {
    fields: {
      id: { type: 'number', precision: 0 },
      name: { type: 'string' },
      created_at: { type: 'date' },
      updated_at: { 
        type: 'datetime',
        precision: 'seconds',
        timezoneField: 'updated_at_tz'
      },
      price: { 
        type: 'currency',
        precision: 2,
        currencyField: 'price_currency'
      },
      tax_rate: { 
        type: 'percentage',
        precision: 2
      }
    }
  },
  data: async function* () {
    // Your data source (DB cursor, stream, etc.)
    for await (const record of dbCursor) {
      yield record;
    }
  }()
};

// Export
await exportDataWithTemplate(
  './template.xlsx',
  {
    excelOutputPath: './output.xlsx',
    csvOutputPath: './output.csv'
  },
  config
);
```

## Field Types

### `string`
Plain text values.

### `number`
Numeric values with configurable precision.

```typescript
{ type: 'number', precision: 2 }  // #,##0.00
{ type: 'number', precision: 0 }  // #,##0
```

### `date`
Date values formatted according to locale.

```typescript
{ type: 'date' }  // dd/mm/yyyy (it-IT)
```

Optional timezone field for IANA timezone support:
```typescript
{ 
  type: 'date',
  timezoneField: 'created_at_tz'
}
```

### `datetime`
Datetime values with time up to seconds.

```typescript
{ 
  type: 'datetime',
  precision: 'seconds'
}  // dd/mm/yyyy hh:mm:ss
```

Optional timezone field:
```typescript
{ 
  type: 'datetime',
  precision: 'seconds',
  timezoneField: 'updated_at_tz'
}
```

### `currency`
Currency values with locale-aware symbol placement.

```typescript
{ 
  type: 'currency',
  precision: 2,
  currencyField: 'price_currency'
}
```

The `currencyField` should contain ISO currency codes (EUR, USD, GBP, etc.).

### `percentage`
Percentage values (0.2 = 20%).

```typescript
{ 
  type: 'percentage',
  precision: 2
}  // 0.00%
```

## Translation Files

Translation files are located in `src/i18n/{locale}.json`.

**Example `en-GB.json`:**
```json
{
  "Customer": "Customer",
  "Customers": "Customers",
  "report_title": "Customer Report",
  "col_id": "ID",
  "col_name": "Name"
}
```

**Example `it-IT.json`:**
```json
{
  "Customer": "Cliente",
  "Customers": "Clienti",
  "report_title": "Report Clienti",
  "col_id": "ID",
  "col_name": "Nome"
}
```

## Field Mapping

The `fieldMapping` object maps template placeholder names to actual JSON property names:

```typescript
fieldMapping: {
  'codice_cliente': 'id',        // Template uses {#codice_cliente}, JSON has id
  'nome_cliente': 'name',        // Template uses {#nome_cliente}, JSON has name
  'email_cliente': 'email'        // Template uses {?email_cliente}, JSON has email
}
```

## Timezone Handling

- **Fields with `timezoneField`**: Use the timezone from the specified field in each record
- **Fields without `timezoneField`**: Use the `defaultTimezone` from the config (typically the user's browser timezone)

## Performance

The library uses streaming architecture:
- Excel: `ExcelJS.stream.xlsx.WorkbookWriter` for constant RAM
- CSV: Node.js streams for constant RAM
- Can handle millions of records without memory issues

## Template Requirements

- Must be a valid `.xlsx` file
- Must contain at least one worksheet
- Must have at least one `{#field}` placeholder for data loop
- Sheet name will be replaced by `entity.plural`
- Invalid Excel characters in sheet name are automatically removed

## Locale Support

The library uses `Intl` API for locale-aware formatting:
- Date patterns derived from locale
- Currency symbol position derived from locale
- Number separators handled by Excel (always use `#,##0.00` in code)

Supported locales include: `en-GB`, `it-IT`, `en-US`, `de-DE`, etc.
