/**
 * docs-gen — shared user-guide page generator types.
 *
 * The engine is dependency-free: the Svelte compiler and the TypeScript
 * module are injected by the calling repo (each service/FE resolves them
 * from its own node_modules). Facts are plain data — the renderer is a
 * pure function over them.
 */

/** Minimal injected Svelte compiler surface (svelte/compiler `parse`). */
export interface SvelteCompilerPort {
  parse: (source: string, options?: { modern?: boolean }) => unknown;
}

/**
 * Extracted facts for one page/component source file — the same fact set
 * the historical `pages.json` carried, extended with remote-source facts.
 */
export interface SveltePageFacts {
  route: string;
  /** Form/state fields: name → {type, required, constraints, default, fromState}. */
  fields: Record<string, ExtractedField>;
  /** Outbound API calls seen in source. */
  endpoints: ExtractedEndpoint[];
  /** goto/window.open/href CTAs. */
  navigations: ExtractedNavigation[];
  /** use* composable names referenced. */
  composables: string[];
  schemaVar: string | null;
  superRefines: number;
  /** customActionHandlers keys on EntityTablePage/EntityFormPage. */
  customActions: string[];
  constUrls: Record<string, string>;
  /** Template widgets (FormField/Button/EntityTablePage/…) with attrs. */
  widgets: ExtractedWidget[];
  /** $t()/ctx.i18n.t() translation keys referenced. */
  i18nKeys: string[];
  /** EntityTablePage/EntityFormPage shell declaration facts. */
  entityDecl?: ShellEntityDecl;
  /** RemotePageMount present on the page. */
  remoteMount?: boolean;
  /** Remote-source facts — `ctx.sheet.props.*` keys consumed by a sheet. */
  sheetProps?: string[];
  /** Remote-source facts — `openSheet('<key>')` targets called by the source. */
  sheetOpenings?: string[];
}

export interface ExtractedField {
  type: string;
  required: boolean;
  constraints: string[];
  default?: string;
  fromState?: boolean;
}

export interface ExtractedEndpoint {
  method: string;
  path: string;
}

export interface ExtractedNavigation {
  kind: "same-tab" | "new-tab";
  target: string;
}

export interface ExtractedWidget {
  tag: string;
  attrs: Record<string, unknown>;
}

/** EntityTablePage/EntityFormPage shell declaration extracted from the page. */
export interface ShellEntityDecl {
  component: string;
  entity?: string;
  basePath?: string;
  createAction: boolean;
  editAction: boolean;
  navStrategy?: string;
}

/**
 * Route→source-file resolution for remote module chunks: the `PAGES`/
 * `PANELS` record literals (or a fixed mountPage/mountSheet body) in the
 * chunk entry tell which `.svelte` owns which declared route/sheet key.
 */
export interface RemoteDispatchMap {
  /** route path → fe-src-relative .svelte file. */
  pages: Record<string, string>;
  /** sheet key (`<module>.<name>`) → fe-src-relative .svelte file. */
  sheets: Record<string, string>;
}

/** One documentable route — normalized union of declared + static facts. */
export interface DocRoute {
  route: string;
  kind: "list" | "detail" | "create" | "page";
  entity?: string;
  label_key?: string;
  description_key?: string;
  icon?: string;
  component_url?: string;
  presentation?: "page" | "sheet";
  /** `page_props.form` — the entity-form archetype declaration. */
  form?: { fields: Record<string, unknown>[]; validators?: string[] };
  /** AST facts when a source file exists (host static or remote). */
  facts?: SveltePageFacts;
  /** How this route is delivered. */
  delivery: "host-static" | "archetype" | "remote";
}

/** A declared sheet surface — own doc page, referenced by parent pages. */
export interface DocSheet {
  key: string;
  label_key?: string;
  component_url: string;
  default_options?: { side?: "left" | "right"; modal?: boolean; content_class?: string };
  facts?: SveltePageFacts;
  /** Routes/pages that open this sheet (openSheet('<key>') call sites). */
  opened_by?: string[];
}

/** Entity capability context the renderer needs (perms, stepUp, duplicate). */
export interface EntityCaps {
  perms: Record<string, string[]>;
  extraScans: string[];
  duplicate?: boolean;
  stepUp: Record<string, boolean>;
  auditable?: boolean;
}
