/**
 * RBAC registry — single source of truth for permissions and role mappings.
 *
 * Design:
 *   - Each HTTP action declares the EXACT permission(s) it requires
 *     (e.g. `customer.read.all`, `emailsender.provider.create.single`). The endpoint,
 *     not the role, determines what is needed.
 *   - Role → Permission mappings are stored in the `role_mappings` table (database).
 *     The auth middleware loads these mappings at startup and expands a user's
 *     roles into a flat `Set<Permission>` once per request.
 *   - The RBAC middleware evaluates the array with **OR** semantics by default
 *     (any-of). Use `rbacHandler.all([...])` for AND semantics.
 *   - Roles marked with `is_admin=true` in the database grant ALL permissions
 *     (super-user wildcard).
 *   - API keys marked with `is_system=true` bypass all permission checks
 *     and set the actor to "system" for audit fields.
 *
 * Three pseudo-permissions exist as sentinels handled directly by the middleware
 * (they are NOT stored in `role_mappings`):
 *
 *   - `Permission.PUBLIC`             → endpoint reachable without a JWT.
 *   - `Permission.AUTHENTICATED_USER` → any caller with a valid identity
 *                                       passes, regardless of roles.
 *   - `Permission.AUTHENTICATED_ADMIN`→ only callers with `isAdmin === true`
 *                                       pass. Use for high-risk non-CRUD
 *                                       operations (e.g. admin change-password).
 */

export const Permission = {
  // --- Sentinels (not mapped to any role; handled by rbac middleware) ---
  /** Endpoint reachable anonymously. STILL requires client-shield-secret in GATEWAY mode. */
  PUBLIC: "_public",
  /** Any caller whose identity has been authenticated, regardless of roles. */
  AUTHENTICATED_USER: "_authenticated_user",
  /** Only callers with `isAdmin === true` pass. Use for high-risk non-CRUD admin-only operations. */
  AUTHENTICATED_ADMIN: "_authenticated_admin",

  // --- Core / non-entity namespaces ---
  // Modules service-registry (not entity CRUD — populated by NATS registration).
  MODULES_READ_ALL: "modules.read.all",
  MODULES_READ_SINGLE: "modules.read.single",
  MODULES_UPDATE_SINGLE: "modules.update.single",
  MODULES_DELETE_SINGLE: "modules.delete.single",
  // Module config_entry sub-entity (core concept shared by every module).
  // Scope `modules.config` — per-module config object → single cardinality.
  MODULES_CONFIG_READ_SINGLE: "modules.config.read.single",
  MODULES_CONFIG_UPDATE_SINGLE: "modules.config.update.single",

  // --- Entity permission sets ---
  // Grammar: {scope}.{action}.{cardinality}
  //   scope       = entity path segment, snake_case SINGULAR (the object granted
  //                 on, never the collection). Microservice entities are
  //                 module-prefixed: {module}.{entity}.
  //   ROPs (read) = read.single | read.all | read.audit | export (no qualifier)
  //   WOPs (write)= create|update|delete|restore|duplicate . single|bulk
  // Every CRUD entity owns the canonical 14-permission set — permissions exist
  // in the registry even when no endpoint uses them yet (admin-gating is a
  // temporary enforcement posture, not a reason to skip the permission).
  // Const names are mechanical: CONST = string.toUpperCase().replaceAll(".", "_").

  // --- auth_event (audit log entity) ---
  AUTH_EVENT_READ_ALL: "auth_event.read.all",
  AUTH_EVENT_READ_SINGLE: "auth_event.read.single",
  AUTH_EVENT_READ_AUDIT: "auth_event.read.audit",
  AUTH_EVENT_EXPORT: "auth_event.export",
  AUTH_EVENT_CREATE_SINGLE: "auth_event.create.single",
  AUTH_EVENT_CREATE_BULK: "auth_event.create.bulk",
  AUTH_EVENT_UPDATE_SINGLE: "auth_event.update.single",
  AUTH_EVENT_UPDATE_BULK: "auth_event.update.bulk",
  AUTH_EVENT_DELETE_SINGLE: "auth_event.delete.single",
  AUTH_EVENT_DELETE_BULK: "auth_event.delete.bulk",
  AUTH_EVENT_RESTORE_SINGLE: "auth_event.restore.single",
  AUTH_EVENT_RESTORE_BULK: "auth_event.restore.bulk",
  AUTH_EVENT_DUPLICATE_SINGLE: "auth_event.duplicate.single",
  AUTH_EVENT_DUPLICATE_BULK: "auth_event.duplicate.bulk",

  // --- client_registry (service-identity allowlist — source='manual' rows are admin-managed) ---
  CLIENT_REGISTRY_READ_ALL: "client_registry.read.all",
  CLIENT_REGISTRY_READ_SINGLE: "client_registry.read.single",
  CLIENT_REGISTRY_READ_AUDIT: "client_registry.read.audit",
  CLIENT_REGISTRY_EXPORT: "client_registry.export",
  CLIENT_REGISTRY_CREATE_SINGLE: "client_registry.create.single",
  CLIENT_REGISTRY_CREATE_BULK: "client_registry.create.bulk",
  CLIENT_REGISTRY_UPDATE_SINGLE: "client_registry.update.single",
  CLIENT_REGISTRY_UPDATE_BULK: "client_registry.update.bulk",
  CLIENT_REGISTRY_DELETE_SINGLE: "client_registry.delete.single",
  CLIENT_REGISTRY_DELETE_BULK: "client_registry.delete.bulk",
  CLIENT_REGISTRY_RESTORE_SINGLE: "client_registry.restore.single",
  CLIENT_REGISTRY_RESTORE_BULK: "client_registry.restore.bulk",
  CLIENT_REGISTRY_DUPLICATE_SINGLE: "client_registry.duplicate.single",
  CLIENT_REGISTRY_DUPLICATE_BULK: "client_registry.duplicate.bulk",

  // --- customer ---
  CUSTOMER_READ_ALL: "customer.read.all",
  CUSTOMER_READ_SINGLE: "customer.read.single",
  CUSTOMER_READ_AUDIT: "customer.read.audit",
  CUSTOMER_EXPORT: "customer.export",
  CUSTOMER_CREATE_SINGLE: "customer.create.single",
  CUSTOMER_CREATE_BULK: "customer.create.bulk",
  CUSTOMER_UPDATE_SINGLE: "customer.update.single",
  CUSTOMER_UPDATE_BULK: "customer.update.bulk",
  CUSTOMER_DELETE_SINGLE: "customer.delete.single",
  CUSTOMER_DELETE_BULK: "customer.delete.bulk",
  CUSTOMER_RESTORE_SINGLE: "customer.restore.single",
  CUSTOMER_RESTORE_BULK: "customer.restore.bulk",
  CUSTOMER_DUPLICATE_SINGLE: "customer.duplicate.single",
  CUSTOMER_DUPLICATE_BULK: "customer.duplicate.bulk",

  // --- crm.customer_type (dictionary) ---
  CRM_CUSTOMER_TYPE_READ_ALL: "crm.customer_type.read.all",
  CRM_CUSTOMER_TYPE_READ_SINGLE: "crm.customer_type.read.single",
  CRM_CUSTOMER_TYPE_READ_AUDIT: "crm.customer_type.read.audit",
  CRM_CUSTOMER_TYPE_EXPORT: "crm.customer_type.export",
  CRM_CUSTOMER_TYPE_CREATE_SINGLE: "crm.customer_type.create.single",
  CRM_CUSTOMER_TYPE_CREATE_BULK: "crm.customer_type.create.bulk",
  CRM_CUSTOMER_TYPE_UPDATE_SINGLE: "crm.customer_type.update.single",
  CRM_CUSTOMER_TYPE_UPDATE_BULK: "crm.customer_type.update.bulk",
  CRM_CUSTOMER_TYPE_DELETE_SINGLE: "crm.customer_type.delete.single",
  CRM_CUSTOMER_TYPE_DELETE_BULK: "crm.customer_type.delete.bulk",
  CRM_CUSTOMER_TYPE_RESTORE_SINGLE: "crm.customer_type.restore.single",
  CRM_CUSTOMER_TYPE_RESTORE_BULK: "crm.customer_type.restore.bulk",
  CRM_CUSTOMER_TYPE_DUPLICATE_SINGLE: "crm.customer_type.duplicate.single",
  CRM_CUSTOMER_TYPE_DUPLICATE_BULK: "crm.customer_type.duplicate.bulk",

  // --- crm.company_dimension (dictionary) ---
  CRM_COMPANY_DIMENSION_READ_ALL: "crm.company_dimension.read.all",
  CRM_COMPANY_DIMENSION_READ_SINGLE: "crm.company_dimension.read.single",
  CRM_COMPANY_DIMENSION_READ_AUDIT: "crm.company_dimension.read.audit",
  CRM_COMPANY_DIMENSION_EXPORT: "crm.company_dimension.export",
  CRM_COMPANY_DIMENSION_CREATE_SINGLE: "crm.company_dimension.create.single",
  CRM_COMPANY_DIMENSION_CREATE_BULK: "crm.company_dimension.create.bulk",
  CRM_COMPANY_DIMENSION_UPDATE_SINGLE: "crm.company_dimension.update.single",
  CRM_COMPANY_DIMENSION_UPDATE_BULK: "crm.company_dimension.update.bulk",
  CRM_COMPANY_DIMENSION_DELETE_SINGLE: "crm.company_dimension.delete.single",
  CRM_COMPANY_DIMENSION_DELETE_BULK: "crm.company_dimension.delete.bulk",
  CRM_COMPANY_DIMENSION_RESTORE_SINGLE: "crm.company_dimension.restore.single",
  CRM_COMPANY_DIMENSION_RESTORE_BULK: "crm.company_dimension.restore.bulk",
  CRM_COMPANY_DIMENSION_DUPLICATE_SINGLE: "crm.company_dimension.duplicate.single",
  CRM_COMPANY_DIMENSION_DUPLICATE_BULK: "crm.company_dimension.duplicate.bulk",

  // --- crm.legal_form (ISO 20275 dictionary) ---
  CRM_LEGAL_FORM_READ_ALL: "crm.legal_form.read.all",
  CRM_LEGAL_FORM_READ_SINGLE: "crm.legal_form.read.single",
  CRM_LEGAL_FORM_READ_AUDIT: "crm.legal_form.read.audit",
  CRM_LEGAL_FORM_EXPORT: "crm.legal_form.export",
  CRM_LEGAL_FORM_CREATE_SINGLE: "crm.legal_form.create.single",
  CRM_LEGAL_FORM_CREATE_BULK: "crm.legal_form.create.bulk",
  CRM_LEGAL_FORM_UPDATE_SINGLE: "crm.legal_form.update.single",
  CRM_LEGAL_FORM_UPDATE_BULK: "crm.legal_form.update.bulk",
  CRM_LEGAL_FORM_DELETE_SINGLE: "crm.legal_form.delete.single",
  CRM_LEGAL_FORM_DELETE_BULK: "crm.legal_form.delete.bulk",
  CRM_LEGAL_FORM_RESTORE_SINGLE: "crm.legal_form.restore.single",
  CRM_LEGAL_FORM_RESTORE_BULK: "crm.legal_form.restore.bulk",
  CRM_LEGAL_FORM_DUPLICATE_SINGLE: "crm.legal_form.duplicate.single",
  CRM_LEGAL_FORM_DUPLICATE_BULK: "crm.legal_form.duplicate.bulk",

  // --- crm.local_address_type (dictionary) ---
  CRM_LOCAL_ADDRESS_TYPE_READ_ALL: "crm.local_address_type.read.all",
  CRM_LOCAL_ADDRESS_TYPE_READ_SINGLE: "crm.local_address_type.read.single",
  CRM_LOCAL_ADDRESS_TYPE_READ_AUDIT: "crm.local_address_type.read.audit",
  CRM_LOCAL_ADDRESS_TYPE_EXPORT: "crm.local_address_type.export",
  CRM_LOCAL_ADDRESS_TYPE_CREATE_SINGLE: "crm.local_address_type.create.single",
  CRM_LOCAL_ADDRESS_TYPE_CREATE_BULK: "crm.local_address_type.create.bulk",
  CRM_LOCAL_ADDRESS_TYPE_UPDATE_SINGLE: "crm.local_address_type.update.single",
  CRM_LOCAL_ADDRESS_TYPE_UPDATE_BULK: "crm.local_address_type.update.bulk",
  CRM_LOCAL_ADDRESS_TYPE_DELETE_SINGLE: "crm.local_address_type.delete.single",
  CRM_LOCAL_ADDRESS_TYPE_DELETE_BULK: "crm.local_address_type.delete.bulk",
  CRM_LOCAL_ADDRESS_TYPE_RESTORE_SINGLE: "crm.local_address_type.restore.single",
  CRM_LOCAL_ADDRESS_TYPE_RESTORE_BULK: "crm.local_address_type.restore.bulk",
  CRM_LOCAL_ADDRESS_TYPE_DUPLICATE_SINGLE: "crm.local_address_type.duplicate.single",
  CRM_LOCAL_ADDRESS_TYPE_DUPLICATE_BULK: "crm.local_address_type.duplicate.bulk",

  // --- crm.qualification (dictionary) ---
  CRM_QUALIFICATION_READ_ALL: "crm.qualification.read.all",
  CRM_QUALIFICATION_READ_SINGLE: "crm.qualification.read.single",
  CRM_QUALIFICATION_READ_AUDIT: "crm.qualification.read.audit",
  CRM_QUALIFICATION_EXPORT: "crm.qualification.export",
  CRM_QUALIFICATION_CREATE_SINGLE: "crm.qualification.create.single",
  CRM_QUALIFICATION_CREATE_BULK: "crm.qualification.create.bulk",
  CRM_QUALIFICATION_UPDATE_SINGLE: "crm.qualification.update.single",
  CRM_QUALIFICATION_UPDATE_BULK: "crm.qualification.update.bulk",
  CRM_QUALIFICATION_DELETE_SINGLE: "crm.qualification.delete.single",
  CRM_QUALIFICATION_DELETE_BULK: "crm.qualification.delete.bulk",
  CRM_QUALIFICATION_RESTORE_SINGLE: "crm.qualification.restore.single",
  CRM_QUALIFICATION_RESTORE_BULK: "crm.qualification.restore.bulk",
  CRM_QUALIFICATION_DUPLICATE_SINGLE: "crm.qualification.duplicate.single",
  CRM_QUALIFICATION_DUPLICATE_BULK: "crm.qualification.duplicate.bulk",

  // --- crm.marketing_qualification (dictionary) ---
  CRM_MARKETING_QUALIFICATION_READ_ALL: "crm.marketing_qualification.read.all",
  CRM_MARKETING_QUALIFICATION_READ_SINGLE: "crm.marketing_qualification.read.single",
  CRM_MARKETING_QUALIFICATION_READ_AUDIT: "crm.marketing_qualification.read.audit",
  CRM_MARKETING_QUALIFICATION_EXPORT: "crm.marketing_qualification.export",
  CRM_MARKETING_QUALIFICATION_CREATE_SINGLE: "crm.marketing_qualification.create.single",
  CRM_MARKETING_QUALIFICATION_CREATE_BULK: "crm.marketing_qualification.create.bulk",
  CRM_MARKETING_QUALIFICATION_UPDATE_SINGLE: "crm.marketing_qualification.update.single",
  CRM_MARKETING_QUALIFICATION_UPDATE_BULK: "crm.marketing_qualification.update.bulk",
  CRM_MARKETING_QUALIFICATION_DELETE_SINGLE: "crm.marketing_qualification.delete.single",
  CRM_MARKETING_QUALIFICATION_DELETE_BULK: "crm.marketing_qualification.delete.bulk",
  CRM_MARKETING_QUALIFICATION_RESTORE_SINGLE: "crm.marketing_qualification.restore.single",
  CRM_MARKETING_QUALIFICATION_RESTORE_BULK: "crm.marketing_qualification.restore.bulk",
  CRM_MARKETING_QUALIFICATION_DUPLICATE_SINGLE: "crm.marketing_qualification.duplicate.single",
  CRM_MARKETING_QUALIFICATION_DUPLICATE_BULK: "crm.marketing_qualification.duplicate.bulk",

  // --- crm.contact_type (dictionary) ---
  CRM_CONTACT_TYPE_READ_ALL: "crm.contact_type.read.all",
  CRM_CONTACT_TYPE_READ_SINGLE: "crm.contact_type.read.single",
  CRM_CONTACT_TYPE_READ_AUDIT: "crm.contact_type.read.audit",
  CRM_CONTACT_TYPE_EXPORT: "crm.contact_type.export",
  CRM_CONTACT_TYPE_CREATE_SINGLE: "crm.contact_type.create.single",
  CRM_CONTACT_TYPE_CREATE_BULK: "crm.contact_type.create.bulk",
  CRM_CONTACT_TYPE_UPDATE_SINGLE: "crm.contact_type.update.single",
  CRM_CONTACT_TYPE_UPDATE_BULK: "crm.contact_type.update.bulk",
  CRM_CONTACT_TYPE_DELETE_SINGLE: "crm.contact_type.delete.single",
  CRM_CONTACT_TYPE_DELETE_BULK: "crm.contact_type.delete.bulk",
  CRM_CONTACT_TYPE_RESTORE_SINGLE: "crm.contact_type.restore.single",
  CRM_CONTACT_TYPE_RESTORE_BULK: "crm.contact_type.restore.bulk",
  CRM_CONTACT_TYPE_DUPLICATE_SINGLE: "crm.contact_type.duplicate.single",
  CRM_CONTACT_TYPE_DUPLICATE_BULK: "crm.contact_type.duplicate.bulk",

  // --- crm.account_kind (dictionary) ---
  CRM_ACCOUNT_KIND_READ_ALL: "crm.account_kind.read.all",
  CRM_ACCOUNT_KIND_READ_SINGLE: "crm.account_kind.read.single",
  CRM_ACCOUNT_KIND_READ_AUDIT: "crm.account_kind.read.audit",
  CRM_ACCOUNT_KIND_EXPORT: "crm.account_kind.export",
  CRM_ACCOUNT_KIND_CREATE_SINGLE: "crm.account_kind.create.single",
  CRM_ACCOUNT_KIND_CREATE_BULK: "crm.account_kind.create.bulk",
  CRM_ACCOUNT_KIND_UPDATE_SINGLE: "crm.account_kind.update.single",
  CRM_ACCOUNT_KIND_UPDATE_BULK: "crm.account_kind.update.bulk",
  CRM_ACCOUNT_KIND_DELETE_SINGLE: "crm.account_kind.delete.single",
  CRM_ACCOUNT_KIND_DELETE_BULK: "crm.account_kind.delete.bulk",
  CRM_ACCOUNT_KIND_RESTORE_SINGLE: "crm.account_kind.restore.single",
  CRM_ACCOUNT_KIND_RESTORE_BULK: "crm.account_kind.restore.bulk",
  CRM_ACCOUNT_KIND_DUPLICATE_SINGLE: "crm.account_kind.duplicate.single",
  CRM_ACCOUNT_KIND_DUPLICATE_BULK: "crm.account_kind.duplicate.bulk",

  // --- crm.customer_link_type (dictionary) ---
  CRM_CUSTOMER_LINK_TYPE_READ_ALL: "crm.customer_link_type.read.all",
  CRM_CUSTOMER_LINK_TYPE_READ_SINGLE: "crm.customer_link_type.read.single",
  CRM_CUSTOMER_LINK_TYPE_READ_AUDIT: "crm.customer_link_type.read.audit",
  CRM_CUSTOMER_LINK_TYPE_EXPORT: "crm.customer_link_type.export",
  CRM_CUSTOMER_LINK_TYPE_CREATE_SINGLE: "crm.customer_link_type.create.single",
  CRM_CUSTOMER_LINK_TYPE_CREATE_BULK: "crm.customer_link_type.create.bulk",
  CRM_CUSTOMER_LINK_TYPE_UPDATE_SINGLE: "crm.customer_link_type.update.single",
  CRM_CUSTOMER_LINK_TYPE_UPDATE_BULK: "crm.customer_link_type.update.bulk",
  CRM_CUSTOMER_LINK_TYPE_DELETE_SINGLE: "crm.customer_link_type.delete.single",
  CRM_CUSTOMER_LINK_TYPE_DELETE_BULK: "crm.customer_link_type.delete.bulk",
  CRM_CUSTOMER_LINK_TYPE_RESTORE_SINGLE: "crm.customer_link_type.restore.single",
  CRM_CUSTOMER_LINK_TYPE_RESTORE_BULK: "crm.customer_link_type.restore.bulk",
  CRM_CUSTOMER_LINK_TYPE_DUPLICATE_SINGLE: "crm.customer_link_type.duplicate.single",
  CRM_CUSTOMER_LINK_TYPE_DUPLICATE_BULK: "crm.customer_link_type.duplicate.bulk",

  // --- crm.consent_type (dictionary) ---
  CRM_CONSENT_TYPE_READ_ALL: "crm.consent_type.read.all",
  CRM_CONSENT_TYPE_READ_SINGLE: "crm.consent_type.read.single",
  CRM_CONSENT_TYPE_READ_AUDIT: "crm.consent_type.read.audit",
  CRM_CONSENT_TYPE_EXPORT: "crm.consent_type.export",
  CRM_CONSENT_TYPE_CREATE_SINGLE: "crm.consent_type.create.single",
  CRM_CONSENT_TYPE_CREATE_BULK: "crm.consent_type.create.bulk",
  CRM_CONSENT_TYPE_UPDATE_SINGLE: "crm.consent_type.update.single",
  CRM_CONSENT_TYPE_UPDATE_BULK: "crm.consent_type.update.bulk",
  CRM_CONSENT_TYPE_DELETE_SINGLE: "crm.consent_type.delete.single",
  CRM_CONSENT_TYPE_DELETE_BULK: "crm.consent_type.delete.bulk",
  CRM_CONSENT_TYPE_RESTORE_SINGLE: "crm.consent_type.restore.single",
  CRM_CONSENT_TYPE_RESTORE_BULK: "crm.consent_type.restore.bulk",
  CRM_CONSENT_TYPE_DUPLICATE_SINGLE: "crm.consent_type.duplicate.single",
  CRM_CONSENT_TYPE_DUPLICATE_BULK: "crm.consent_type.duplicate.bulk",

  // --- crm.local_address ---
  CRM_LOCAL_ADDRESS_READ_ALL: "crm.local_address.read.all",
  CRM_LOCAL_ADDRESS_READ_SINGLE: "crm.local_address.read.single",
  CRM_LOCAL_ADDRESS_READ_AUDIT: "crm.local_address.read.audit",
  CRM_LOCAL_ADDRESS_EXPORT: "crm.local_address.export",
  CRM_LOCAL_ADDRESS_CREATE_SINGLE: "crm.local_address.create.single",
  CRM_LOCAL_ADDRESS_CREATE_BULK: "crm.local_address.create.bulk",
  CRM_LOCAL_ADDRESS_UPDATE_SINGLE: "crm.local_address.update.single",
  CRM_LOCAL_ADDRESS_UPDATE_BULK: "crm.local_address.update.bulk",
  CRM_LOCAL_ADDRESS_DELETE_SINGLE: "crm.local_address.delete.single",
  CRM_LOCAL_ADDRESS_DELETE_BULK: "crm.local_address.delete.bulk",
  CRM_LOCAL_ADDRESS_RESTORE_SINGLE: "crm.local_address.restore.single",
  CRM_LOCAL_ADDRESS_RESTORE_BULK: "crm.local_address.restore.bulk",
  CRM_LOCAL_ADDRESS_DUPLICATE_SINGLE: "crm.local_address.duplicate.single",
  CRM_LOCAL_ADDRESS_DUPLICATE_BULK: "crm.local_address.duplicate.bulk",

  // --- crm.customer_account ---
  CRM_CUSTOMER_ACCOUNT_READ_ALL: "crm.customer_account.read.all",
  CRM_CUSTOMER_ACCOUNT_READ_SINGLE: "crm.customer_account.read.single",
  CRM_CUSTOMER_ACCOUNT_READ_AUDIT: "crm.customer_account.read.audit",
  CRM_CUSTOMER_ACCOUNT_EXPORT: "crm.customer_account.export",
  CRM_CUSTOMER_ACCOUNT_CREATE_SINGLE: "crm.customer_account.create.single",
  CRM_CUSTOMER_ACCOUNT_CREATE_BULK: "crm.customer_account.create.bulk",
  CRM_CUSTOMER_ACCOUNT_UPDATE_SINGLE: "crm.customer_account.update.single",
  CRM_CUSTOMER_ACCOUNT_UPDATE_BULK: "crm.customer_account.update.bulk",
  CRM_CUSTOMER_ACCOUNT_DELETE_SINGLE: "crm.customer_account.delete.single",
  CRM_CUSTOMER_ACCOUNT_DELETE_BULK: "crm.customer_account.delete.bulk",
  CRM_CUSTOMER_ACCOUNT_RESTORE_SINGLE: "crm.customer_account.restore.single",
  CRM_CUSTOMER_ACCOUNT_RESTORE_BULK: "crm.customer_account.restore.bulk",
  CRM_CUSTOMER_ACCOUNT_DUPLICATE_SINGLE: "crm.customer_account.duplicate.single",
  CRM_CUSTOMER_ACCOUNT_DUPLICATE_BULK: "crm.customer_account.duplicate.bulk",

  // --- crm.customer_contact ---
  CRM_CUSTOMER_CONTACT_READ_ALL: "crm.customer_contact.read.all",
  CRM_CUSTOMER_CONTACT_READ_SINGLE: "crm.customer_contact.read.single",
  CRM_CUSTOMER_CONTACT_READ_AUDIT: "crm.customer_contact.read.audit",
  CRM_CUSTOMER_CONTACT_EXPORT: "crm.customer_contact.export",
  CRM_CUSTOMER_CONTACT_CREATE_SINGLE: "crm.customer_contact.create.single",
  CRM_CUSTOMER_CONTACT_CREATE_BULK: "crm.customer_contact.create.bulk",
  CRM_CUSTOMER_CONTACT_UPDATE_SINGLE: "crm.customer_contact.update.single",
  CRM_CUSTOMER_CONTACT_UPDATE_BULK: "crm.customer_contact.update.bulk",
  CRM_CUSTOMER_CONTACT_DELETE_SINGLE: "crm.customer_contact.delete.single",
  CRM_CUSTOMER_CONTACT_DELETE_BULK: "crm.customer_contact.delete.bulk",
  CRM_CUSTOMER_CONTACT_RESTORE_SINGLE: "crm.customer_contact.restore.single",
  CRM_CUSTOMER_CONTACT_RESTORE_BULK: "crm.customer_contact.restore.bulk",
  CRM_CUSTOMER_CONTACT_DUPLICATE_SINGLE: "crm.customer_contact.duplicate.single",
  CRM_CUSTOMER_CONTACT_DUPLICATE_BULK: "crm.customer_contact.duplicate.bulk",

  // --- crm.customer_consent ---
  CRM_CUSTOMER_CONSENT_READ_ALL: "crm.customer_consent.read.all",
  CRM_CUSTOMER_CONSENT_READ_SINGLE: "crm.customer_consent.read.single",
  CRM_CUSTOMER_CONSENT_READ_AUDIT: "crm.customer_consent.read.audit",
  CRM_CUSTOMER_CONSENT_EXPORT: "crm.customer_consent.export",
  CRM_CUSTOMER_CONSENT_CREATE_SINGLE: "crm.customer_consent.create.single",
  CRM_CUSTOMER_CONSENT_CREATE_BULK: "crm.customer_consent.create.bulk",
  CRM_CUSTOMER_CONSENT_UPDATE_SINGLE: "crm.customer_consent.update.single",
  CRM_CUSTOMER_CONSENT_UPDATE_BULK: "crm.customer_consent.update.bulk",
  CRM_CUSTOMER_CONSENT_DELETE_SINGLE: "crm.customer_consent.delete.single",
  CRM_CUSTOMER_CONSENT_DELETE_BULK: "crm.customer_consent.delete.bulk",
  CRM_CUSTOMER_CONSENT_RESTORE_SINGLE: "crm.customer_consent.restore.single",
  CRM_CUSTOMER_CONSENT_RESTORE_BULK: "crm.customer_consent.restore.bulk",
  CRM_CUSTOMER_CONSENT_DUPLICATE_SINGLE: "crm.customer_consent.duplicate.single",
  CRM_CUSTOMER_CONSENT_DUPLICATE_BULK: "crm.customer_consent.duplicate.bulk",

  // --- crm.customer_link ---
  CRM_CUSTOMER_LINK_READ_ALL: "crm.customer_link.read.all",
  CRM_CUSTOMER_LINK_READ_SINGLE: "crm.customer_link.read.single",
  CRM_CUSTOMER_LINK_READ_AUDIT: "crm.customer_link.read.audit",
  CRM_CUSTOMER_LINK_EXPORT: "crm.customer_link.export",
  CRM_CUSTOMER_LINK_CREATE_SINGLE: "crm.customer_link.create.single",
  CRM_CUSTOMER_LINK_CREATE_BULK: "crm.customer_link.create.bulk",
  CRM_CUSTOMER_LINK_UPDATE_SINGLE: "crm.customer_link.update.single",
  CRM_CUSTOMER_LINK_UPDATE_BULK: "crm.customer_link.update.bulk",
  CRM_CUSTOMER_LINK_DELETE_SINGLE: "crm.customer_link.delete.single",
  CRM_CUSTOMER_LINK_DELETE_BULK: "crm.customer_link.delete.bulk",
  CRM_CUSTOMER_LINK_RESTORE_SINGLE: "crm.customer_link.restore.single",
  CRM_CUSTOMER_LINK_RESTORE_BULK: "crm.customer_link.restore.bulk",
  CRM_CUSTOMER_LINK_DUPLICATE_SINGLE: "crm.customer_link.duplicate.single",
  CRM_CUSTOMER_LINK_DUPLICATE_BULK: "crm.customer_link.duplicate.bulk",

  // --- organization ---
  ORGANIZATION_READ_ALL: "organization.read.all",
  ORGANIZATION_READ_SINGLE: "organization.read.single",
  ORGANIZATION_READ_AUDIT: "organization.read.audit",
  ORGANIZATION_EXPORT: "organization.export",
  ORGANIZATION_CREATE_SINGLE: "organization.create.single",
  ORGANIZATION_CREATE_BULK: "organization.create.bulk",
  ORGANIZATION_UPDATE_SINGLE: "organization.update.single",
  ORGANIZATION_UPDATE_BULK: "organization.update.bulk",
  ORGANIZATION_DELETE_SINGLE: "organization.delete.single",
  ORGANIZATION_DELETE_BULK: "organization.delete.bulk",
  ORGANIZATION_RESTORE_SINGLE: "organization.restore.single",
  ORGANIZATION_RESTORE_BULK: "organization.restore.bulk",
  ORGANIZATION_DUPLICATE_SINGLE: "organization.duplicate.single",
  ORGANIZATION_DUPLICATE_BULK: "organization.duplicate.bulk",

  // --- role_mapping (admin) ---
  ROLE_MAPPING_READ_ALL: "role_mapping.read.all",
  ROLE_MAPPING_READ_SINGLE: "role_mapping.read.single",
  ROLE_MAPPING_READ_AUDIT: "role_mapping.read.audit",
  ROLE_MAPPING_EXPORT: "role_mapping.export",
  ROLE_MAPPING_CREATE_SINGLE: "role_mapping.create.single",
  ROLE_MAPPING_CREATE_BULK: "role_mapping.create.bulk",
  ROLE_MAPPING_UPDATE_SINGLE: "role_mapping.update.single",
  ROLE_MAPPING_UPDATE_BULK: "role_mapping.update.bulk",
  ROLE_MAPPING_DELETE_SINGLE: "role_mapping.delete.single",
  ROLE_MAPPING_DELETE_BULK: "role_mapping.delete.bulk",
  ROLE_MAPPING_RESTORE_SINGLE: "role_mapping.restore.single",
  ROLE_MAPPING_RESTORE_BULK: "role_mapping.restore.bulk",
  ROLE_MAPPING_DUPLICATE_SINGLE: "role_mapping.duplicate.single",
  ROLE_MAPPING_DUPLICATE_BULK: "role_mapping.duplicate.bulk",

  // --- translation (admin, per-module schemas via ?module= query param) ---
  TRANSLATION_READ_ALL: "translation.read.all",
  TRANSLATION_READ_SINGLE: "translation.read.single",
  TRANSLATION_READ_AUDIT: "translation.read.audit",
  TRANSLATION_EXPORT: "translation.export",
  TRANSLATION_CREATE_SINGLE: "translation.create.single",
  TRANSLATION_CREATE_BULK: "translation.create.bulk",
  TRANSLATION_UPDATE_SINGLE: "translation.update.single",
  TRANSLATION_UPDATE_BULK: "translation.update.bulk",
  TRANSLATION_DELETE_SINGLE: "translation.delete.single",
  TRANSLATION_DELETE_BULK: "translation.delete.bulk",
  TRANSLATION_RESTORE_SINGLE: "translation.restore.single",
  TRANSLATION_RESTORE_BULK: "translation.restore.bulk",
  TRANSLATION_DUPLICATE_SINGLE: "translation.duplicate.single",
  TRANSLATION_DUPLICATE_BULK: "translation.duplicate.bulk",

  // --- user_profile ---
  USER_PROFILE_READ_ALL: "user_profile.read.all",
  USER_PROFILE_READ_SINGLE: "user_profile.read.single",
  USER_PROFILE_READ_AUDIT: "user_profile.read.audit",
  USER_PROFILE_EXPORT: "user_profile.export",
  USER_PROFILE_CREATE_SINGLE: "user_profile.create.single",
  USER_PROFILE_CREATE_BULK: "user_profile.create.bulk",
  USER_PROFILE_UPDATE_SINGLE: "user_profile.update.single",
  USER_PROFILE_UPDATE_BULK: "user_profile.update.bulk",
  USER_PROFILE_DELETE_SINGLE: "user_profile.delete.single",
  USER_PROFILE_DELETE_BULK: "user_profile.delete.bulk",
  USER_PROFILE_RESTORE_SINGLE: "user_profile.restore.single",
  USER_PROFILE_RESTORE_BULK: "user_profile.restore.bulk",
  USER_PROFILE_DUPLICATE_SINGLE: "user_profile.duplicate.single",
  USER_PROFILE_DUPLICATE_BULK: "user_profile.duplicate.bulk",

  // --- emailsender.provider (microservice entity — module-prefixed scope) ---
  EMAILSENDER_PROVIDER_READ_ALL: "emailsender.provider.read.all",
  EMAILSENDER_PROVIDER_READ_SINGLE: "emailsender.provider.read.single",
  EMAILSENDER_PROVIDER_READ_AUDIT: "emailsender.provider.read.audit",
  EMAILSENDER_PROVIDER_EXPORT: "emailsender.provider.export",
  EMAILSENDER_PROVIDER_CREATE_SINGLE: "emailsender.provider.create.single",
  EMAILSENDER_PROVIDER_CREATE_BULK: "emailsender.provider.create.bulk",
  EMAILSENDER_PROVIDER_UPDATE_SINGLE: "emailsender.provider.update.single",
  EMAILSENDER_PROVIDER_UPDATE_BULK: "emailsender.provider.update.bulk",
  EMAILSENDER_PROVIDER_DELETE_SINGLE: "emailsender.provider.delete.single",
  EMAILSENDER_PROVIDER_DELETE_BULK: "emailsender.provider.delete.bulk",
  EMAILSENDER_PROVIDER_RESTORE_SINGLE: "emailsender.provider.restore.single",
  EMAILSENDER_PROVIDER_RESTORE_BULK: "emailsender.provider.restore.bulk",
  EMAILSENDER_PROVIDER_DUPLICATE_SINGLE: "emailsender.provider.duplicate.single",
  EMAILSENDER_PROVIDER_DUPLICATE_BULK: "emailsender.provider.duplicate.bulk",

  // --- emailsender.email_template (microservice entity — module-prefixed scope) ---
  EMAILSENDER_EMAIL_TEMPLATE_READ_ALL: "emailsender.email_template.read.all",
  EMAILSENDER_EMAIL_TEMPLATE_READ_SINGLE: "emailsender.email_template.read.single",
  EMAILSENDER_EMAIL_TEMPLATE_READ_AUDIT: "emailsender.email_template.read.audit",
  EMAILSENDER_EMAIL_TEMPLATE_EXPORT: "emailsender.email_template.export",
  EMAILSENDER_EMAIL_TEMPLATE_CREATE_SINGLE: "emailsender.email_template.create.single",
  EMAILSENDER_EMAIL_TEMPLATE_CREATE_BULK: "emailsender.email_template.create.bulk",
  EMAILSENDER_EMAIL_TEMPLATE_UPDATE_SINGLE: "emailsender.email_template.update.single",
  EMAILSENDER_EMAIL_TEMPLATE_UPDATE_BULK: "emailsender.email_template.update.bulk",
  EMAILSENDER_EMAIL_TEMPLATE_DELETE_SINGLE: "emailsender.email_template.delete.single",
  EMAILSENDER_EMAIL_TEMPLATE_DELETE_BULK: "emailsender.email_template.delete.bulk",
  EMAILSENDER_EMAIL_TEMPLATE_RESTORE_SINGLE: "emailsender.email_template.restore.single",
  EMAILSENDER_EMAIL_TEMPLATE_RESTORE_BULK: "emailsender.email_template.restore.bulk",
  EMAILSENDER_EMAIL_TEMPLATE_DUPLICATE_SINGLE: "emailsender.email_template.duplicate.single",
  EMAILSENDER_EMAIL_TEMPLATE_DUPLICATE_BULK: "emailsender.email_template.duplicate.bulk",

  // --- Action permissions (non-entity, module-scoped verbs) ---
  // Service action (Category-2 endpoint) — verb-form scope, qualifier-free
  // by grammar extension: a bare `{scope}.{action}` is legal only when
  // `action` is NOT a reserved entity op (read/create/update/delete/restore/
  // duplicate/export) — those always require a qualifier.
  EMAILSENDER_SEND: "emailsender.send",
  EMAILSENDER_LOG_CREATE_SINGLE: "emailsender.log.create.single",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

/**
 * `true` when the given permission is a sentinel (PUBLIC / AUTHENTICATED_USER /
 * AUTHENTICATED_ADMIN) handled directly by the rbac middleware rather than by
 * role expansion.
 */
export function isPermissionSentinel(p: string): boolean {
  return (
    p === Permission.PUBLIC ||
    p === Permission.AUTHENTICATED_USER ||
    p === Permission.AUTHENTICATED_ADMIN
  );
}

/**
 * Returns all non-sentinel permission strings (i.e. the real RBAC permissions,
 * excluding PUBLIC / AUTHENTICATED_USER / AUTHENTICATED_ADMIN).
 * Used by the BE to build the permissions catalog for the FE role-management UI.
 */
export function listNonSentinelPermissions(): string[] {
  return Object.values(Permission).filter((p) => !isPermissionSentinel(p));
}

/**
 * Convert a wildcard pattern to a regex for matching.
 * Supports * wildcard only (no ? or character classes for simplicity).
 * Example: "customer.read.*" → /^customer\.read\..*$/
 */
function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const wildcardPattern = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${wildcardPattern}$`);
}

/**
 * Check if a permission string matches a pattern (supports * wildcard).
 * @param pattern - Pattern with optional * wildcard (e.g., "customer.read.*")
 * @param permission - Permission string to match (e.g., "customer.read.single")
 * @returns true if permission matches pattern
 */
export function matchesWildcard(pattern: string, permission: string): boolean {
  if (!pattern.includes("*")) {
    // No wildcard - exact match
    return pattern === permission;
  }
  const regex = wildcardToRegex(pattern);
  return regex.test(permission);
}

/**
 * Check if a permission is granted given a set of user permissions.
 * Supports wildcard patterns in user permissions.
 * @param userPermissions - Set of permissions granted to user (may contain wildcards)
 * @param requiredPermission - Permission required by the endpoint
 * @returns true if permission is granted
 */
export function isPermissionGranted(userPermissions: Set<string>, requiredPermission: string): boolean {
  // Check exact match first (fast path)
  if (userPermissions.has(requiredPermission)) {
    return true;
  }

  // Check wildcard patterns
  for (const userPerm of userPermissions) {
    if (userPerm.includes("*") && matchesWildcard(userPerm, requiredPermission)) {
      return true;
    }
  }

  return false;
}

/**
 * Expand a list of role names into patterns and admin status.
 * This function queries the `role_mappings` table to resolve roles to permissions.
 * Roles marked with `is_admin=true` bypass all permission checks.
 *
 * @param roles - Role names from the IDP (as extracted from JWT via roles_path)
 * @param getRoleMappingFn - Function that returns the mapping for a specific role
 * @returns Object with patterns array and isAdmin flag
 */
export async function expandPermissions(
  roles: readonly string[],
  getRoleMappingFn: (role: string) => Promise<{ permissions: string[]; is_admin: boolean } | null>,
): Promise<{ patterns: string[]; isAdmin: boolean }> {
  const patterns = new Set<string>();
  let isAdmin = false;

  for (const r of roles) {
    const mapping = await getRoleMappingFn(r);
    if (!mapping) continue;

    // If any role is admin, set isAdmin flag
    if (mapping.is_admin) {
      isAdmin = true;
    }

    // Add all patterns from this role (ignored if isAdmin=true, but we collect them anyway)
    for (const p of mapping.permissions) patterns.add(p);
  }

  return { patterns: Array.from(patterns), isAdmin };
}
