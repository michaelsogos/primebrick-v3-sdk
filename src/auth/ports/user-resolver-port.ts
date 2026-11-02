/**
 * Port for resolving IDP subject to internal Primebrick UUID.
 *
 * BE-ONLY port. Microservices do NOT implement this — they use
 * GATEWAY-RESOLVED mode where the BE already resolved the user and
 * forwards the full AuthUser in headers.
 */

export interface ResolveInput {
  idp_code: string;
  email: string | null;
  display_name: string | null;
  idp_org?: string | null;
  idp_username?: string | null;
}

export interface UserResolverPort {
  /**
   * Resolve an IDP subject (JWT `sub`) to the internal Primebrick UUID.
   * Just-in-time provisions a `user_profiles` row on first encounter.
   */
  resolveInternalUuid(input: ResolveInput): Promise<string>;
  /**
   * Optional — the user's preferred locale (BCP-47, e.g. `it-IT`) from
   * their stored `ui_locale` preference. Feeds `AuthUser.locale` → the
   * `x-user-locale` forwarded header. Absent impl or null → no locale.
   */
  resolveUserLocale?(internalUuid: string): Promise<string | null>;
}
