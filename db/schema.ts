import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable("jobs", {
  jobId: text("job_id").primaryKey(),
  title: text("title").notNull(),
  company: text("company").notNull(),
  location: text("location").notNull().default(""),
  source: text("source").notNull().default("manual"),
  url: text("url"),
  description: text("description").notNull().default(""),
  foundDate: text("found_date").notNull(),
  postedAt: text("posted_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  laneHint: text("lane_hint"),
  status: text("status").notNull().default("new"),
  appliedAt: text("applied_at"),
  dedupeKey: text("dedupe_key").notNull().unique(),
  companyKey: text("company_key"),
  titleKey: text("title_key"),
  descriptionFingerprint: text("description_fingerprint"),
  opportunityKey: text("opportunity_key"),
  opportunityGroupingVersion: integer("opportunity_grouping_version"),
  discoveryUrl: text("discovery_url"),
  sourceTier: text("source_tier").notNull().default("unverified"),
  sourceStatus: text("source_status").notNull().default("unresolved"),
  sourceCheckedAt: text("source_checked_at"),
  sourceResolutionJson: text("source_resolution_json"),
}, (table) => [
  index("idx_jobs_found_created").on(table.foundDate, table.createdAt),
  index("idx_jobs_status_found").on(table.status, table.foundDate),
  index("idx_jobs_company_status").on(table.companyKey, table.status, table.foundDate),
  index("idx_jobs_opportunity_key").on(table.opportunityKey),
]);

export const jobStatusEvents = sqliteTable("job_status_events", {
  eventId: integer("event_id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull().references(() => jobs.jobId, { onDelete: "cascade" }),
  previousStatus: text("previous_status").notNull(),
  status: text("status").notNull(),
  source: text("source").notNull(),
  changedAt: text("changed_at").notNull(),
}, (table) => [index("idx_job_status_events_job_changed").on(table.jobId, table.changedAt)]);

export const jobSources = sqliteTable("job_sources", {
  jobId: text("job_id").notNull().references(() => jobs.jobId, { onDelete: "cascade" }),
  label: text("label").notNull().default(""),
  url: text("url").notNull(),
  sourceTier: text("source_tier").notNull(),
  candidateOrder: integer("candidate_order").notNull().default(0),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.url] }),
  index("idx_job_sources_job").on(table.jobId, table.candidateOrder),
]);

export const jobSourceResolutionEvents = sqliteTable("job_source_resolution_events", {
  resolutionId: integer("resolution_id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull().references(() => jobs.jobId, { onDelete: "cascade" }),
  resolutionStatus: text("resolution_status").notNull(),
  sourceTier: text("source_tier").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_job_source_events_job").on(table.jobId, table.createdAt)]);

export const analyses = sqliteTable("analyses", {
  jobId: text("job_id").primaryKey().references(() => jobs.jobId, { onDelete: "cascade" }),
  decisionMemoJson: text("decision_memo_json").notNull(),
  decision: text("decision").notNull(),
  fitTier: text("fit_tier").notNull(),
  sponsorshipTier: text("sponsorship_tier").notNull(),
  lane: text("lane").notNull(),
  resumeStrategy: text("resume_strategy").notNull(),
  confidence: text("confidence").notNull(),
  createdAt: text("created_at").notNull(),
});

export const storedObjects = sqliteTable("stored_objects", {
  objectKey: text("object_key").primaryKey(),
  category: text("category").notNull(),
  ownerKey: text("owner_key").notNull(),
  logicalName: text("logical_name").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  etag: text("etag"),
  sha256: text("sha256"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_stored_objects_unique_logical").on(table.category, table.ownerKey, table.logicalName),
  index("idx_stored_objects_owner").on(table.category, table.ownerKey),
]);

export const applications = sqliteTable("applications", {
  jobId: text("job_id").primaryKey().references(() => jobs.jobId, { onDelete: "cascade" }),
  packetOwnerKey: text("packet_owner_key").notNull(),
  resumeStrategy: text("resume_strategy").notNull(),
  status: text("status").notNull(),
  packetDate: text("packet_date").notNull(),
  appliedDate: text("applied_date"),
  notes: text("notes").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
});

export const dailyReports = sqliteTable("daily_reports", {
  reportDate: text("report_date").primaryKey(),
  objectKey: text("object_key").notNull().references(() => storedObjects.objectKey),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const runs = sqliteTable("runs", {
  runId: integer("run_id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id"),
  runType: text("run_type").notNull(),
  promptObjectKey: text("prompt_object_key").references(() => storedObjects.objectKey),
  outputObjectKey: text("output_object_key").references(() => storedObjects.objectKey),
  status: text("status").notNull(),
  error: text("error").notNull().default(""),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_runs_job_created").on(table.jobId, table.createdAt),
  index("idx_runs_type_created").on(table.runType, table.createdAt),
]);

export const operations = sqliteTable("operations", {
  operationId: text("operation_id").primaryKey(),
  operationType: text("operation_type").notNull(),
  resourceKey: text("resource_key").notNull(),
  executionTarget: text("execution_target").notNull().default("workstation"),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull(),
  resultJson: text("result_json"),
  error: text("error").notNull().default(""),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_operations_status_created").on(table.status, table.createdAt),
  index("idx_operations_type_status_created").on(table.operationType, table.status, table.createdAt),
  uniqueIndex("idx_operations_active_resource").on(table.operationType, table.resourceKey).where(sql`${table.status} in ('starting','queued','running')`),
]);

export const operationLeases = sqliteTable("operation_leases", {
  operationId: text("operation_id").primaryKey().references(() => operations.operationId, { onDelete: "cascade" }),
  workerId: text("worker_id"),
  instanceId: text("instance_id"),
  lastHeartbeatAt: text("last_heartbeat_at"),
  expiresAt: text("expires_at").notNull(),
  completionHash: text("completion_hash"),
  completionValid: integer("completion_valid"),
}, (table) => [
  index("idx_operation_leases_expiry").on(table.expiresAt),
  check("operation_completion_valid", sql`${table.completionValid} is null or ${table.completionValid} = 1`),
]);

export const networkingCompanies = sqliteTable("networking_companies", {
  companyKey: text("company_key").primaryKey(),
  displayName: text("display_name").notNull(),
  paused: integer("paused").notNull().default(0),
  researchJson: text("research_json"),
  researchedAt: text("researched_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const networkingContacts = sqliteTable("networking_contacts", {
  contactId: integer("contact_id").primaryKey({ autoIncrement: true }),
  companyKey: text("company_key").notNull().references(() => networkingCompanies.companyKey, { onDelete: "cascade" }),
  name: text("name").notNull(),
  linkedinUrl: text("linkedin_url").notNull().default(""),
  requestAccepted: integer("request_accepted").notNull().default(0),
  responded: integer("responded").notNull().default(0),
  coffeeChat: integer("coffee_chat").notNull().default(0),
  referral: integer("referral").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_networking_contacts_company_name").on(table.companyKey, table.name),
  index("idx_networking_contacts_company").on(table.companyKey),
]);

export const networkingEvents = sqliteTable("networking_events", {
  eventId: integer("event_id").primaryKey({ autoIncrement: true }),
  companyKey: text("company_key").notNull().references(() => networkingCompanies.companyKey, { onDelete: "cascade" }),
  contactId: integer("contact_id").references(() => networkingContacts.contactId, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  occurredAt: text("occurred_at").notNull(),
}, (table) => [index("idx_networking_events_company").on(table.companyKey, table.occurredAt)]);

export const networkingRoleResearch = sqliteTable("networking_role_research", {
  companyKey: text("company_key").notNull().references(() => networkingCompanies.companyKey, { onDelete: "cascade" }),
  opportunityKey: text("opportunity_key").notNull(),
  jobId: text("job_id").notNull().references(() => jobs.jobId),
  title: text("title").notNull(),
  location: text("location").notNull().default(""),
  jdFingerprint: text("jd_fingerprint").notNull(),
  companyResearchedAt: text("company_researched_at").notNull().default(""),
  researchJson: text("research_json").notNull(),
  researchedAt: text("researched_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.companyKey, table.opportunityKey] }),
  index("idx_networking_role_research_company").on(table.companyKey),
]);

export const profileVersions = sqliteTable("profile_versions", {
  contextVersion: text("context_version").primaryKey(),
  resumeParser: text("resume_parser").notNull(),
  resumeStrategiesJson: text("resume_strategies_json").notNull(),
  isActive: integer("is_active").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

export const searchRuns = sqliteTable("search_runs", {
  runId: text("run_id").primaryKey(),
  operationId: text("operation_id").notNull().unique().references(() => operations.operationId, { onDelete: "cascade" }),
  status: text("status").notNull(),
  requestJson: text("request_json").notNull(),
  plannedRequestsJson: text("planned_requests_json").notNull(),
  resultJson: text("result_json"),
  rawObjectPrefix: text("raw_object_prefix").notNull(),
  normalizedObjectKey: text("normalized_object_key"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  updatedAt: text("updated_at").notNull(),
});

export const searchRequests = sqliteTable("search_requests", {
  runId: text("run_id").notNull().references(() => searchRuns.runId, { onDelete: "cascade" }),
  requestKey: text("request_key").notNull(),
  sequence: integer("sequence").notNull(),
  lane: text("lane").notNull(),
  query: text("query").notNull(),
  location: text("location").notNull(),
  locationSource: text("location_source").notNull(),
  page: integer("page").notNull(),
  nextPageToken: text("next_page_token"),
  status: text("status").notNull(),
  serpapiSearchId: text("serpapi_search_id"),
  pollCount: integer("poll_count").notNull().default(0),
  fetched: integer("fetched").notNull().default(0),
  created: integer("created").notNull().default(0),
  uniqueJobs: integer("unique_jobs").notNull().default(0),
  newOpportunities: integer("new_opportunities").notNull().default(0),
  cached: integer("cached").notNull().default(0),
  durationMs: integer("duration_ms"),
  errorType: text("error_type"),
  errorMessage: text("error_message"),
  rawObjectKey: text("raw_object_key"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runId, table.requestKey] }),
  index("idx_search_requests_run_sequence").on(table.runId, table.sequence),
]);

export const migrationBatches = sqliteTable("migration_batches", {
  importId: text("import_id").notNull(),
  tableName: text("table_name").notNull(),
  sequence: integer("sequence").notNull(),
  payloadSha256: text("payload_sha256").notNull(),
  rowCount: integer("row_count").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.importId, table.tableName, table.sequence] })]);
