import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractHostFacts,
  extractRemoteFacts,
  parseRemoteDispatch,
  routeFromHostFile,
} from "../extract-svelte.js";
import type { SvelteCompilerPort } from "../types.js";

const req = createRequire(import.meta.url);
const ts = req("typescript") as typeof import("typescript");

// The SDK has no svelte dep — tests resolve the compiler from a consumer
// repo when available, else from a vendored path. For CI the engine tests
// use the fe repo checkout through PRIMEBRICK_FE env or skip.
const FE_DIR = process.env.PRIMEBRICK_FE ?? join(import.meta.dirname, "..", "..", "..", "..", "primebrick-fe-v3");

async function loadSvelte(): Promise<SvelteCompilerPort | null> {
  try {
    const { pathToFileURL } = await import("node:url");
    const mod = await import(pathToFileURL(join(FE_DIR, "node_modules/svelte/compiler/index.js")).href);
    return mod.default as SvelteCompilerPort;
  } catch {
    return null;
  }
}

const HOST_PAGE = `
<script lang="ts">
  import { z } from 'zod';
  import { apiFetch, goto } from '$lib/api';
  const schema = z.object({
    email: z.string().email(),
    display_name: z.string().min(1).max(200),
    is_admin: z.boolean().default(false),
  });
  let extra_note = $state('');
  const listPath = '/system/settings/users';
  async function save() {
    await apiFetch('/api/v1/auth/users', { method: 'POST', body: '{}' });
    goto(resolve(listPath));
  }
</script>
<EntityFormPage basePath={entityApiBase('user_profile')} onEditAction={onEdit} customActionHandlers={{ change_password: changePw }}>
  <FormField id="email" bind:value={form.data.email} />
  <FormField id="extra_note" bind:value={extra_note} />
  <Button href="/system/settings/users">{$t('common.cancel')}</Button>
</EntityFormPage>
`;

const REMOTE_PAGE = `
<script lang="ts">
  import { notifyParentAndClose } from '@primebrick/ui';
  let { ctx } = $props();
  const t = (key: string) => ctx.i18n.t(key);
  let name = $state('');
  let spec = $state('@every 1h');
  async function submit() {
    await ctx.api('/api/v1/actions/schedule-job', { method: 'POST' });
    openSheet('job.runDetail');
    notifyParentAndClose();
  }
</script>
<TextInput id="name" bind:value={name} />
<TextInput id="spec" bind:value={spec} />
<h1>{t('job.jobs.scheduleDialog.title')}</h1>
`;

const REMOTE_SHEET = `
<script lang="ts">
  let { ctx } = $props();
  const t = (key: string) => ctx.i18n.t(key);
  const run = $derived(ctx.sheet.props.run_uuid);
  const status = $derived(ctx.sheet.props.status);
  async function load() { await ctx.api('/api/v1/entities/job_run/' + ctx.sheet.props.run_uuid); }
</script>
<h2>{t('job.jobs.runDetail.title')}</h2>
`;

const DISPATCH_ENTRY = `
import SchedulePage from './SchedulePage.svelte';
import RunDetailSheet from './RunDetailSheet.svelte';
export function mountPage(el, ctx) { return mountModuleContent(el, ctx, SchedulePage); }
export function mountSheet(el, ctx) { return mountModuleContent(el, ctx, RunDetailSheet); }
`;

const DISPATCH_ENTRY_MAP = `
import AiSettingsPage from './AiSettingsPage.svelte';
import ModelCacheSheet from './ModelCacheSheet.svelte';
const PAGES: Record<string, Component> = { '/system/ai/console': AiSettingsPage };
const PANELS: Record<string, Component> = { 'ai.modelCache': ModelCacheSheet };
`;

describe("extract-svelte", () => {
  it("extracts host facts: zod fields, endpoints, navigations, entity decl, i18n", async () => {
    const svelte = await loadSvelte();
    if (!svelte) return; // compiler not resolvable in this env
    const f = extractHostFacts(HOST_PAGE, "/system/settings/users/create", { svelte, ts });
    expect(f.fields.email.type).toContain("z.string");
    expect(f.fields.email.required).toBe(true);
    expect(f.fields.is_admin.required).toBe(false);
    expect(f.fields.is_admin.default).toBe("false");
    // zod schema wins over $state guesses (parity with legacy extractor)
    expect(f.fields.extra_note).toBeUndefined();
    expect(f.endpoints).toContainEqual({ method: "POST", path: "/api/v1/auth/users" });
    expect(f.navigations).toContainEqual({ kind: "same-tab", target: "/system/settings/users" });
    expect(f.entityDecl?.component).toBe("EntityFormPage");
    expect(f.entityDecl?.entity).toBe("user_profile");
    expect(f.entityDecl?.editAction).toBe(true);
    expect(f.customActions).toContain("change_password");
    expect(f.i18nKeys).toContain("common.cancel");
  });

  it("extracts remote facts: ctx.api, t() keys, openSheet, sheet props", async () => {
    const svelte = await loadSvelte();
    if (!svelte) return;
    const f = extractRemoteFacts(REMOTE_PAGE, "/system/job/job-schedules/create", { svelte, ts });
    expect(f.endpoints).toContainEqual({ method: "POST", path: "/api/v1/actions/schedule-job" });
    expect(f.fields.name).toBeDefined();
    expect(f.fields.spec?.default).toBe("'@every 1h'");
    expect(f.sheetOpenings).toContain("job.runDetail");
    expect(f.i18nKeys).toContain("job.jobs.scheduleDialog.title");
    const s = extractRemoteFacts(REMOTE_SHEET, "sheet:job.runDetail", { svelte, ts });
    expect(s.sheetProps).toContain("run_uuid");
    expect(s.sheetProps).toContain("status");
  });

  it("parses fixed-mount dispatch → all declared routes/keys map to the component", () => {
    const d = parseRemoteDispatch(DISPATCH_ENTRY, {
      component_url_routes: ["/system/job/job-schedules/create"],
      sheet_keys: ["job.runDetail"],
    }, ts);
    expect(d.pages["/system/job/job-schedules/create"]).toBe("SchedulePage.svelte");
    expect(d.sheets["job.runDetail"]).toBe("RunDetailSheet.svelte");
  });

  it("parses record-literal dispatch (PAGES/PANELS maps)", () => {
    const d = parseRemoteDispatch(DISPATCH_ENTRY_MAP, {}, ts);
    expect(d.pages["/system/ai/console"]).toBe("AiSettingsPage.svelte");
    expect(d.sheets["ai.modelCache"]).toBe("ModelCacheSheet.svelte");
  });

  it("derives routes from host file paths", () => {
    expect(routeFromHostFile("D:/x/src/routes/(app)/system/job/rules/+page.svelte", "D:/x/src/routes/(app)"))
      .toBe("/system/job/rules");
    expect(routeFromHostFile("D:/x/src/routes/(app)/system/settings/users/{uuid}/+page.svelte", "D:/x/src/routes/(app)"))
      .toBe("/system/settings/users/{uuid}");
  });
});
