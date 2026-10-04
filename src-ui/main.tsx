import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, Briefcase, CalendarDays, Check, ChevronDown, Coffee, Copy, ExternalLink, FileText, GripVertical, Handshake, Info, Link as LinkIcon, MessageCircle, MoreHorizontal, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Pencil, Pin, PinOff, RefreshCw, Search, Send, Table2, Trash2, UserCheck, X } from "lucide-react";
import "./styles.css";
import "./responsive.css";
import { DEMO, demoRequest } from "./demo-api";
import { DemoBanner, SetupPage, type Capabilities } from "./onboarding";
import { JobDetailSurface, useCompactLayout } from "./job-detail-surface";
import { CompanyExplainer, EVIDENCE_LABELS, type CompanyExplainerData } from "./company-explainer";
import { filterJobs, createLatestLoader, type FiltersState, type LoadStatus } from "./job-list";

type Job = {
  job_id: string;
  title: string;
  company: string;
  location: string;
  source: string;
  url?: string;
  description: string;
  found_date: string;
  posted_at?: string;
  lane_hint?: string;
  status: string;
  applied_at?: string | null;
  decision?: string;
  fit_tier?: string;
  sponsorship_tier?: string;
  lane?: string;
  resume_strategy?: string;
  confidence?: string;
  packet_available?: boolean;
  application_status?: string;
  opportunity_key?: string;
  opportunity_listing_count?: number;
  opportunity_source_count?: number;
  opportunity_location_count?: number;
  discovery_url?: string;
  source_tier?: "employer" | "ats" | "linkedin" | "manual" | "aggregator" | "discovery" | "unverified";
  source_status?: "preferred" | "unresolved" | "promoted" | "reused" | "refreshed" | "replaced" | "unavailable" | "ambiguous";
  source_checked_at?: string;
  source_resolution?: SourceResolution | null;
};

type SourceResolution = {
  status: string;
  source_tier: string;
  reason: string;
  confidence?: string;
  evidence_urls?: string[];
  original_title?: string;
  original_url?: string;
  resolved_title?: string;
  resolved_url?: string;
  checked_at?: string;
};

type JobDetail = Job & {
  analysis?: {
    decision_memo?: Record<string, unknown>;
    decision: string;
    fit_tier: string;
    sponsorship_tier: string;
    lane: string;
    resume_strategy: string;
    confidence: string;
  } | null;
  application?: {
    status: string;
    resume_strategy: string;
    packet_date: string;
  } | null;
  opportunity_variants?: Job[];
};

type JobGroup = {
  key: string;
  canonical: Job;
  variants: Job[];
  locations: string[];
  sources: string[];
  listingCount: number;
};

type Application = {
  files: Record<string, { url: string; exists: boolean }>;
};

type Operation<T = Record<string, unknown>> = {
  operation_id: string;
  operation_type: string;
  status: "starting" | "queued" | "running" | "succeeded" | "failed" | "interrupted";
  payload: Record<string, unknown>;
  result: T | null;
  error: string;
};

type OperationResponse<T = Record<string, unknown>> = {
  operation: Operation<T>;
  created: boolean;
};

type AnalyzeBatchResponse = {
  operations: Operation[];
  created_count: number;
  existing_count: number;
};

type ManualIngestFormState = {
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  lane_hint: string;
  status: "new" | "needs_review" | "ready_to_apply" | "applied" | "skipped";
  analyze: boolean;
};

type IngestJobResponse = {
  job_id: string;
  created: boolean;
  job: Job;
  analysis_operation: Operation | null;
  analysis_created: boolean;
};

type LaneOption = {
  id: string;
  label: string;
  target_titles: string[];
  queries: string[];
  positioning: string;
};

type MetroOption = {
  id: string;
  label: string;
  description: string;
  locations: string[];
  search_locations: string[];
  edge_locations: string[];
};

type SearchOptions = {
  lanes: LaneOption[];
  metros: MetroOption[];
  serpapi: {
    engine: string;
    location_guidance: string;
    fixed_params: Record<string, string>;
    results_per_page: number;
    max_pages: number;
    page3_min_new_opportunities: number;
  };
};

type SearchFormState = {
  lanes: string[];
  metro_ids: string[];
  manualLocation: string;
  limit: number;
  includeEdgeCheck: boolean;
};

type SearchResult = {
  run_id: string;
  status: "complete" | "partial" | "failed";
  lanes: string[];
  locations: string[];
  limit_per_query_location: number;
  limit_per_lane_location: number;
  max_pages: number;
  edge_check_included: boolean;
  fetched: number;
  created: number;
  unique_jobs: number;
  unique_opportunities: number;
  existing_jobs: number;
  cached_requests: number;
  pagination_requests: number;
  search_requests: number;
  matched_job_ids: string[];
  created_job_ids: string[];
  successful_requests: number;
  failed_requests: number;
  searches: Array<{
    lane: string;
    query: string;
    location: string;
    location_source: string;
    page: number;
    status: "success" | "failed";
    fetched: number;
    created?: number;
    unique_jobs?: number;
    cached?: boolean;
    duration_ms: number;
    type?: string;
    message?: string;
    search_id?: string | null;
    poll_count?: number;
    new_opportunities_in_run?: number;
    has_next_page?: boolean;
  }>;
  errors: Array<{
    lane: string;
    query: string;
    location: string;
    location_source: string;
    page: number;
    next_page_token?: string | null;
    type: string;
    message: string;
    duration_ms: number;
    search_id?: string | null;
    poll_count?: number;
  }>;
};

type DecisionMemo = {
  decision?: string;
  fit_tier?: string;
  sponsorship_tier?: string;
  lane?: string;
  resume_strategy?: string;
  confidence?: string;
  interview_chance_reasoning?: string;
  why_apply?: string[];
  risks?: string[];
  jd_evidence?: string[];
  profile_evidence?: string[];
  recommended_next_step?: string;
};

type NetworkingRole = {
  job_id: string;
  opportunity_key: string;
  title: string;
  location: string;
  url?: string;
  status: string;
  fit_tier?: string;
  decision?: string;
  research?: RoleResearch | LegacyRoleResearch | null;
  researched_at?: string | null;
  research_stale?: boolean;
};

type NetworkingContact = {
  contact_id: number;
  name: string;
  linkedin_url: string;
  request_accepted: boolean;
  responded: boolean;
  coffee_chat: boolean;
  referral: boolean;
};

type NetworkingEvent = {
  event_id: number;
  event_type: string;
  label: string;
  contact_name?: string;
  occurred_at: string;
};

type ResearchSource = {
  url: string;
  title: string;
  publisher: string;
  published_at: string;
};

type CompanyFinding = {
  headline: string;
  detail: string;
  as_of: string;
  confidence: "verified" | "likely" | "unknown";
  evidence_type?: "company_reported" | "independently_supported" | "analysis" | "unknown";
  source_urls: string[];
};

type CompanyEditorial = {
  schema_version: number;
  headline: string;
  dek: string;
  lede: string;
  executive_takeaways?: Array<{
    label: string;
    detail: string;
  }>;
  business_at_a_glance?: {
    customer: string;
    buyer: string;
    problem: string;
    product: string;
    value: string;
    growth_path: string;
    strategic_question: string;
  };
  sections: Array<{
    heading: string;
    paragraphs: string[];
    source_urls: string[];
  }>;
  closing: string;
};

type RoleFinding = {
  headline: string;
  detail: string;
  evidence_type: "verified" | "inferred" | "unknown";
  source_urls: string[];
};

type CompanyResearch = {
  visual_review?: {
    outcome: "images_selected" | "no_relevant_images" | "sources_unavailable";
    summary: string;
    pages_checked: Array<{ url: string; status: string; notes: string }>;
    candidates: Array<{ url: string; source_url: string; visual_inspected: boolean; decision: string; reason: string }>;
  };
  explainer?: CompanyExplainerData;
  schema_version?: number;
  official_name: string;
  website: string;
  careers_url: string;
  industry: string;
  headquarters: string;
  size_and_stage?: string;
  ownership?: string;
  business_model?: string;
  executive_summary?: string;
  editorial?: CompanyEditorial;
  sections?: {
    products_and_services: CompanyFinding[];
    customers_and_use_cases: CompanyFinding[];
    traction_and_strategy: CompanyFinding[];
    market_and_competitors: CompanyFinding[];
    recent_developments: CompanyFinding[];
    culture_and_hiring: CompanyFinding[];
    risks_and_unknowns: CompanyFinding[];
  };
  sources?: ResearchSource[];
  description?: string;
  source_urls?: string[];
};

type RoleResearch = {
  schema_version: number;
  role_thesis: string;
  responsibilities: Array<{
    responsibility: string;
    detail: string;
    stakeholders: Array<{ group: string; relationship: string }>;
    source_urls: string[];
  }>;
  success_outcomes: Array<{ outcome: string; basis: string }>;
  fit_thesis: string;
  proof_points: Array<{ label: string; evidence: string; role_connection: string }>;
  gaps: Array<{ gap: string; implication: string }>;
  interview_preparation: Array<{
    theme: string;
    likely_question: string;
    story_to_use: string;
    question_to_ask: string;
  }>;
  networking_targets: Array<{ target: string; function: string; reason: string }>;
  sources: ResearchSource[];
};

type LegacyRoleResearch = {
  schema_version: number;
  executive_summary: string;
  role_mandate: string;
  why_now: RoleFinding[];
  relevant_company_context: RoleFinding[];
  stakeholders: Array<{ group: string; relationship: string; evidence_type: "verified" | "inferred" | "unknown" }>;
  success_outcomes: Array<{ timeframe: string; outcome: string; basis: string }>;
  jd_to_company: Array<{ jd_requirement: string; company_context: string; implication: string }>;
  interview_themes: Array<{ theme: string; what_to_prepare: string }>;
  questions_to_ask: string[];
  networking_targets: Array<{ target: string; function: string; reason: string }>;
  positioning: {
    headline: string;
    opening_pitch: string;
    proof_points: string[];
    story_angles: Array<{ angle: string; candidate_evidence: string; role_connection: string }>;
    gaps_and_mitigations: Array<{ gap: string; mitigation: string }>;
  };
  risks_and_unknowns: RoleFinding[];
  sources: ResearchSource[];
};

type NetworkingCompany = {
  company_key: string;
  display_name: string;
  active: boolean;
  status: "not_started" | "outreach_active" | "conversation_active" | "referral_received" | "paused";
  paused: boolean;
  roles: NetworkingRole[];
  contacts: NetworkingContact[];
  events: NetworkingEvent[];
  research: CompanyResearch | null;
  researched_at?: string;
};

const API = import.meta.env.VITE_API_URL || "";
const JOBS_PAGE_SIZE = 25;
const INSPECTOR_WIDTH_MIN = 320;
const INSPECTOR_WIDTH_MAX = 820;
const INSPECTOR_WIDTH_DEFAULT = 560;
const INSPECTOR_WIDTH_KEY = "careerAutomation.inspectorWidth";
const RESEARCH_RAIL_COLLAPSED_KEY = "careerAutomation.researchRailCollapsed";
const EMPTY_FILTERS: FiltersState = { query: "", date: "", analyzed: "", status: "", lane: "", location: "", fit: "", confidence: "", decision: "", sponsorship: "" };
const EMPTY_MANUAL_INGEST_FORM: ManualIngestFormState = {
  title: "",
  company: "",
  location: "",
  url: "",
  description: "",
  lane_hint: "",
  status: "needs_review",
  analyze: true
};
const APP_VIEW_IDS = new Set(["today", "days", "jobs", "networking", "packets", "search", "setup"]);

function appViewFromLocation() {
  const requestedView = new URLSearchParams(window.location.search).get("view");
  return requestedView && APP_VIEW_IDS.has(requestedView) ? requestedView : DEMO ? "jobs" : "today";
}

function selectedCompanyFromLocation() {
  return new URLSearchParams(window.location.search).get("company");
}

function researchPath(companyKey: string, roleKey?: string) {
  const path = `/research/${encodeURIComponent(companyKey)}`;
  if (!roleKey) return path;
  const params = new URLSearchParams({ role: roleKey });
  return `${path}?${params.toString()}`;
}

function researchRouteFromLocation() {
  const match = window.location.pathname.match(/^\/research\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return {
      companyKey: decodeURIComponent(match[1]),
      roleKey: new URLSearchParams(window.location.search).get("role")
    };
  } catch {
    return null;
  }
}

const FILTER_OPTIONS: Record<Exclude<keyof FiltersState, "location" | "query" | "analyzed">, Array<{ value: string; label: string }>> = {
  date: [
    { value: "", label: "All search dates" }
  ],
  status: [
    { value: "", label: "All decisions" },
    { value: "__blank__", label: "No decision yet" },
    { value: "needs_review", label: "Needs review" },
    { value: "ready_to_apply", label: "Ready to apply" },
    { value: "applied", label: "Applied" },
    { value: "skipped", label: "Skipped" }
  ],
  lane: [
    { value: "", label: "All lanes" },
    { value: "ai_solutions", label: "AI solutions" },
    { value: "product_ops", label: "Product ops" },
    { value: "bizops", label: "BizOps" },
    { value: "tpm_epm", label: "TPM/EPM" },
    { value: "ai_product", label: "AI product" },
    { value: "pmm_gtm_ai", label: "PMM/GTM AI" },
    { value: "other", label: "Other" }
  ],
  decision: [
    { value: "", label: "All AI recs" },
    { value: "apply_strong", label: "Apply strong" },
    { value: "apply", label: "Apply" },
    { value: "maybe", label: "Maybe" },
    { value: "skip", label: "Skip" },
    { value: "blocked", label: "Blocked" }
  ],
  fit: [
    { value: "", label: "All fit tiers" },
    { value: "strong", label: "Strong" },
    { value: "plausible", label: "Plausible" },
    { value: "stretch", label: "Stretch" },
    { value: "weak", label: "Weak" },
    { value: "blocked", label: "Blocked" }
  ],
  confidence: [
    { value: "", label: "All confidence" },
    { value: "high", label: "High" },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" }
  ],
  sponsorship: [
    { value: "", label: "All sponsorship" },
    { value: "friendly", label: "Friendly" },
    { value: "plausible", label: "Plausible" },
    { value: "unknown", label: "Unknown" },
    { value: "high_risk", label: "High risk" },
    { value: "blocked_explicit", label: "Blocked explicit" }
  ]
};

const STATUS_OPTIONS = ["needs_review", "ready_to_apply", "applied", "skipped"];

type JobActions = {
  codexAvailable: boolean;
  unavailableReason: string;
  pending: boolean;
  onAnalyze: (id: string) => void;
  onBuild: (id: string) => void;
  onStatus: (id: string, status: string) => void;
};

function clampInspectorWidth(width: number) {
  return Math.min(INSPECTOR_WIDTH_MAX, Math.max(INSPECTOR_WIDTH_MIN, width));
}

function listingSource(job: Job) {
  if (job.url) {
    try {
      const host = new URL(job.url).hostname.replace(/^www\./, "");
      const knownSources: Record<string, string> = {
        "indeed.com": "Indeed",
        "lensa.com": "Lensa",
        "linkedin.com": "LinkedIn",
        "ziprecruiter.com": "ZipRecruiter"
      };
      const known = Object.entries(knownSources).find(([domain]) => host === domain || host.endsWith(`.${domain}`));
      if (known) return known[1];
      return host.split(".")[0].replace(/(^|[-_])\w/g, (value) => value.replace(/[-_]/, "").toUpperCase());
    } catch {
      // Fall back to the saved source label when the URL is malformed.
    }
  }
  return humanize(job.source || "listing");
}

function sourceTierLabel(tier?: Job["source_tier"]) {
  const labels: Record<string, string> = {
    employer: "Employer site",
    ats: "Employer ATS",
    linkedin: "LinkedIn",
    manual: "User-provided",
    aggregator: "Aggregator",
    discovery: "Discovery link",
    unverified: "Unverified source"
  };
  return labels[tier || "unverified"] || humanize(tier);
}

function sourceStatusLabel(status?: Job["source_status"]) {
  const labels: Record<string, string> = {
    preferred: "Preferred source",
    unresolved: "Source check required",
    promoted: "Preferred link selected",
    reused: "Matched saved listing",
    refreshed: "Description refreshed",
    replaced: "Listing replaced",
    unavailable: "Listing unavailable",
    ambiguous: "Source needs review"
  };
  return labels[status || "unresolved"] || humanize(status);
}

function canonicalJob(variants: Job[]) {
  return [...variants].sort((left, right) => {
    const analysisDifference = Number(Boolean(right.decision || right.fit_tier)) - Number(Boolean(left.decision || left.fit_tier));
    if (analysisDifference) return analysisDifference;
    const applicationDifference = Number(Boolean(right.application_status || right.packet_available)) - Number(Boolean(left.application_status || left.packet_available));
    if (applicationDifference) return applicationDifference;
    const postedDifference = Number(Boolean(right.posted_at)) - Number(Boolean(left.posted_at));
    if (postedDifference) return postedDifference;
    return `${right.found_date}|${right.job_id}`.localeCompare(`${left.found_date}|${left.job_id}`);
  })[0];
}

function buildOpportunityGroups(jobs: Job[]): JobGroup[] {
  const grouped = new Map<string, Job[]>();
  jobs.forEach((job) => {
    const key = job.opportunity_key || job.job_id;
    grouped.set(key, [...(grouped.get(key) || []), job]);
  });
  return Array.from(grouped.entries()).map(([key, variants]) => {
    const canonical = canonicalJob(variants);
    const locations = Array.from(new Set(variants.map((job) => job.location).filter(Boolean)));
    const sources = Array.from(new Set(variants.map(listingSource)));
    return {
      key,
      canonical,
      variants,
      locations,
      sources,
      listingCount: Math.max(variants.length, canonical.opportunity_listing_count || 1)
    };
  });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (DEMO) return demoRequest(path, init);
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      ...init
    });
  } catch {
    throw new Error("The Site service is temporarily unreachable. Check your connection and try again.");
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(formatApiError(text, response.statusText));
  }
  return response.json() as Promise<T>;
}

async function apiText(path: string): Promise<string> {
  if (DEMO) return demoRequest(path);
  const response = await fetch(`${API}${path}`);
  if (response.status === 404) return "";
  if (!response.ok) throw new Error(formatApiError(await response.text(), response.statusText));
  return response.text();
}

function localDateIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function useWorkstationAvailability() {
  const [state, setState] = useState({ available: false, checking: true, detail: "Checking workstation…" });
  const refresh = async (showChecking = false) => {
    if (showChecking) {
      setState((current) => ({ ...current, checking: true, detail: "Checking workstation…" }));
    }
    try {
      const data = await api<{ ok: boolean; mode: string; error?: string; message?: string }>("/api/codex/status");
      const next = {
        available: Boolean(data.ok),
        checking: false,
        detail: data.ok ? (data.message || "Workstation worker is online.") : (data.error || "Workstation worker is offline.")
      };
      setState(next);
      return next;
    } catch (error) {
      const next = {
        available: false,
        checking: false,
        detail: error instanceof Error ? error.message : "Workstation worker is offline."
      };
      setState(next);
      return next;
    }
  };
  useEffect(() => {
    let disposed = false;
    const check = async () => {
      if (!disposed) await refresh();
    };
    void check();
    const timer = window.setInterval(check, 15000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return { ...state, refresh };
}

function pause(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForOperation<T>(operationId: string): Promise<T> {
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    const operation = await api<Operation<T>>(`/api/operations/${encodeURIComponent(operationId)}`);
    if (operation.status === "succeeded") return operation.result as T;
    if (operation.status === "failed" || operation.status === "interrupted") {
      throw new Error(operation.error || `Operation ${operation.status}.`);
    }
    await pause(1500);
  }
  throw new Error("This action is still running after 20 minutes. Its saved status remains available after a refresh.");
}

async function runOperation<T>(path: string, init: RequestInit): Promise<T> {
  const response = await api<OperationResponse<T>>(path, init);
  return waitForOperation<T>(response.operation.operation_id);
}

function formatApiError(text: string, fallback: string) {
  if (!text) return fallback;
  try {
    const payload = JSON.parse(text) as { detail?: unknown };
    if (typeof payload.detail === "string") return payload.detail;
  } catch {
    // Keep the original response text when the API did not return JSON.
  }
  return text;
}

function App() {
  const [view, setView] = useState(appViewFromLocation);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const refreshCapabilities = () => { void api<Capabilities>("/api/setup").then(setCapabilities).catch(() => setCapabilities(null)); };
  useEffect(refreshCapabilities, []);
  const compact = useCompactLayout();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filtersPinned, setFiltersPinned] = useState(false);
  const jobControlsRef = useRef<HTMLDivElement>(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(() => DEMO && !new URLSearchParams(window.location.search).has("job") && !new URLSearchParams(window.location.search).has("company"));
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = window.localStorage.getItem(INSPECTOR_WIDTH_KEY);
    const savedWidth = saved === null ? INSPECTOR_WIDTH_DEFAULT : Number(saved);
    return Number.isFinite(savedWidth) ? clampInspectorWidth(savedWidth) : INSPECTOR_WIDTH_DEFAULT;
  });
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [jobsLoadStatus, setJobsLoadStatus] = useState<LoadStatus>("loading");
  const [hasLoadedJobs, setHasLoadedJobs] = useState(false);
  const [jobLoader] = useState(() => createLatestLoader(
    async () => (await api<{ jobs: Job[] }>("/api/jobs")).jobs,
    (rows) => {
      setAllJobs(rows);
      setHasLoadedJobs(true);
    },
    setJobsLoadStatus
  ));
  const [days, setDays] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState(() => new URLSearchParams(window.location.search).get("date") || localDateIso());
  const [selectedJobId, setSelectedJobId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("job"));
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [application, setApplication] = useState<Application | null>(null);
  const [busy, setBusy] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<JobGroup[] | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteNotice, setDeleteNotice] = useState("");
  const deletePendingRef = useRef(false);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const statusSavePending = useRef(false);
  const detailRevision = useRef(0);
  const detailTarget = useRef<string | null>(null);
  const [explicitRefresh, setExplicitRefresh] = useState(false);
  const [error, setError] = useState("");
  const [analysisMonitorError, setAnalysisMonitorError] = useState("");
  const [analysisOperations, setAnalysisOperations] = useState<Record<string, Operation>>({});
  const analysisOperationsRef = useRef<Record<string, Operation>>({});
  const refreshAnalysisViewsRef = useRef<() => Promise<void>>(async () => undefined);
  const pollAnalysisOperationsRef = useRef<() => void>(() => undefined);
  const [filters, setFilters] = useState<FiltersState>(EMPTY_FILTERS);
  const [jobsPage, setJobsPage] = useState(1);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [analyzeMode, setAnalyzeMode] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  useEffect(() => {
    if (!filtersOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      if (filtersPinned || analyzeMode) return;
      if (event.target instanceof Node && !jobControlsRef.current?.contains(event.target)) setFiltersOpen(false);
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFiltersOpen(false);
      setFiltersPinned(false);
      jobControlsRef.current?.querySelector<HTMLButtonElement>(".job-controls-toggle")?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [filtersOpen, filtersPinned, analyzeMode]);
  const [excludeAnalyzed, setExcludeAnalyzed] = useState(true);
  const [ingestForm, setIngestForm] = useState<ManualIngestFormState>(EMPTY_MANUAL_INGEST_FORM);
  const [ingestResult, setIngestResult] = useState<IngestJobResponse | null>(null);
  const [searchForm, setSearchForm] = useState<SearchFormState>({
    lanes: ["ai_solutions"],
    metro_ids: ["bay_area"],
    manualLocation: "",
    limit: 20,
    includeEdgeCheck: false
  });
  const [searchOptions, setSearchOptions] = useState<SearchOptions | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [matchedSearch, setMatchedSearch] = useState<{ runId: string; jobIds: string[] } | null>(null);
  const [report, setReport] = useState("");
  const workstation = useWorkstationAvailability();
  const [networkingCompanies, setNetworkingCompanies] = useState<NetworkingCompany[]>([]);
  const [includeInactiveNetworking, setIncludeInactiveNetworking] = useState(false);

  const loadJobs = jobLoader.load;

  const loadDays = async () => {
    const data = await api<{ days: string[] }>("/api/days");
    setDays(data.days);
  };

  const loadNetworking = async () => {
    const data = await api<{ companies: NetworkingCompany[] }>(`/api/networking/companies?include_inactive=${includeInactiveNetworking}`);
    setNetworkingCompanies(data.companies);
  };

  const loadDetail = async (jobId: string) => {
    const revision = ++detailRevision.current;
    detailTarget.current = jobId;
    setDetailError("");
    setDetailLoading(true);
    try {
      const data = await api<JobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`);
      const app = data.application ? await api<Application>(`/api/applications/${encodeURIComponent(jobId)}`) : null;
      if (revision !== detailRevision.current) return;
      setDetail(data);
      setApplication(app);
    } catch (err) {
      if (revision === detailRevision.current) setDetailError(err instanceof Error ? err.message : String(err));
    } finally {
      if (revision === detailRevision.current) setDetailLoading(false);
    }
  };

  const openJob = (jobId: string) => {
    const url = new URL(window.location.href);
    const wasOpen = Boolean(url.searchParams.get("job"));
    url.searchParams.set("job", jobId);
    if (view === "days" || view === "today") url.searchParams.set("date", selectedDate);
    const state = { ...window.history.state, careerJobEntry: wasOpen ? Boolean(window.history.state?.careerJobEntry) : true };
    if (wasOpen) window.history.replaceState(state, "", url);
    else window.history.pushState(state, "", url);
    setInspectorCollapsed(false);
    setSelectedJobId(jobId);
    if (selectedJobId === jobId && detailError) void loadDetail(jobId);
  };

  const closeJob = () => {
    if (window.history.state?.careerJobEntry && new URLSearchParams(window.location.search).has("job")) {
      window.history.back();
    } else {
      const url = new URL(window.location.href);
      url.searchParams.delete("job");
      window.history.replaceState({}, "", url);
      setSelectedJobId(null);
    }
    if (!compact) setInspectorCollapsed(true);
  };

  const selectJob = (jobId: string) => {
    if (selectedJobId === jobId && !inspectorCollapsed) closeJob();
    else openJob(jobId);
  };

  useEffect(() => {
    const restore = () => {
      setView(appViewFromLocation());
      const params = new URLSearchParams(window.location.search);
      setSelectedJobId(params.get("job"));
      if (params.get("job")) setInspectorCollapsed(false);
      if (params.get("date")) setSelectedDate(params.get("date")!);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  useEffect(() => {
    setDetail(null);
    setApplication(null);
    setDetailError("");
    if (selectedJobId) void loadDetail(selectedJobId);
    else { detailTarget.current = null; setDetailLoading(false); }
    return () => { detailRevision.current += 1; };
  }, [selectedJobId]);

  refreshAnalysisViewsRef.current = async () => {
    await Promise.all([loadDays(), loadJobs()]);
    if (selectedJobId) await loadDetail(selectedJobId);
  };

  const runAction = async (label: string, action: () => Promise<unknown> = async () => undefined) => {
    setBusy(label);
    setError("");
    try {
      await action();
      await loadDays();
      await loadJobs();
      if (selectedJobId) await loadDetail(selectedJobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const refreshJobs = async () => {
    setExplicitRefresh(true);
    setError("");
    try {
      await Promise.all([loadDays(), loadJobs()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExplicitRefresh(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deletePendingRef.current) return;
    deletePendingRef.current = true;
    setDeletePending(true);
    setDeleteError("");
    try {
      const result = await api<{ deleted_job_ids: string[] }>("/api/jobs", {
        method: "DELETE",
        body: JSON.stringify({ jobs: deleteTarget.map((group) => ({ job_id: group.canonical.job_id, scope: "opportunity", expected_count: group.listingCount })) })
      });
      const removed = new Set(result.deleted_job_ids);
      jobLoader.invalidate();
      setAllJobs((current) => current.filter((job) => !removed.has(job.job_id)));
      setSelectedJobIds((current) => current.filter((id) => !removed.has(id)));
      setMatchedSearch((current) => current ? { ...current, jobIds: current.jobIds.filter((id) => !removed.has(id)) } : current);
      if (selectedJobId && removed.has(selectedJobId)) {
        detailRevision.current += 1;
        detailTarget.current = null;
        const url = new URL(window.location.href);
        url.searchParams.delete("job");
        window.history.replaceState({}, "", url);
        setSelectedJobId(null);
        setDetail(null);
        setApplication(null);
        setDetailLoading(false);
        setInspectorCollapsed(true);
      } else {
        setDetail((current) => current ? { ...current, opportunity_variants: current.opportunity_variants?.filter((job) => !removed.has(job.job_id)) } : current);
      }
      setJobsLoadStatus("ready");
      setDeleteTarget(null);
      setDeleteMode(false);
      setDeleteNotice(`Deleted ${deleteTarget.length} ${deleteTarget.length === 1 ? "job" : "jobs"} (${result.deleted_job_ids.length} saved ${result.deleted_job_ids.length === 1 ? "listing" : "listings"}).`);
      void Promise.all([loadDays(), loadNetworking()]).catch(() => undefined);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      deletePendingRef.current = false;
      setDeletePending(false);
    }
  };

  const updateJobStatus = async (jobId: string, status: string) => {
    if (statusSavePending.current) return;
    statusSavePending.current = true;
    setBusy("Updating status");
    setError("");
    try {
      const saved = await api<{ job_id: string; status: string; applied_at: string | null }>(`/api/jobs/${jobId}/status`, {
        method: "POST",
        body: JSON.stringify({ status })
      });
      // A snapshot fetched before this save must not undo the confirmed status.
      jobLoader.invalidate();
      if (detailTarget.current === saved.job_id) detailRevision.current += 1;
      setJobsLoadStatus("ready");
      setAllJobs((rows) => rows.map((row) => row.job_id === saved.job_id
        ? { ...row, status: saved.status, applied_at: saved.applied_at, application_status: row.application_status == null ? row.application_status : saved.status }
        : row));
      setDetail((current) => current ? {
        ...current,
        ...(current.job_id === saved.job_id ? {
          status: saved.status,
          applied_at: saved.applied_at,
          application: current.application ? { ...current.application, status: saved.status } : current.application
        } : {}),
        opportunity_variants: current.opportunity_variants?.map((row) => row.job_id === saved.job_id
          ? { ...row, status: saved.status, applied_at: saved.applied_at, application_status: row.application_status == null ? row.application_status : saved.status }
          : row)
      } : current);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      statusSavePending.current = false;
      setBusy("");
    }
  };

  const updateJobDetails = async (
    jobId: string,
    changes: { location: string; url: string | null; description: string }
  ) => {
    setBusy("Saving job details");
    setError("");
    try {
      await api(`/api/jobs/${jobId}`, {
        method: "PATCH",
        body: JSON.stringify(changes)
      });
      await loadDays();
      await loadJobs();
      await loadDetail(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    void Promise.all([loadDays(), loadJobs()])
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return jobLoader.invalidate;
  }, [view, jobLoader]);

  useEffect(() => {
    setJobsPage(1);
    setAnalyzeMode(false);
    setDeleteMode(false);
    setSelectedJobIds([]);
  }, [view, filters.query, filters.date, filters.analyzed, filters.status, filters.lane, filters.location, filters.fit, filters.confidence, filters.decision, filters.sponsorship, matchedSearch?.runId]);

  useEffect(() => {
    void api<SearchOptions>("/api/search/options")
      .then(setSearchOptions)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    let disposed = false;
    void apiText(`/api/reports/${encodeURIComponent(selectedDate)}`)
      .then((content) => {
        if (!disposed) setReport(content);
      })
      .catch(() => {
        if (!disposed) setReport("");
      });
    return () => {
      disposed = true;
    };
  }, [selectedDate]);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let polling = false;
    let rerunRequested = false;

    const pollAnalysisOperations = async () => {
      if (polling) {
        rerunRequested = true;
        return;
      }
      polling = true;
      let hasActiveOperations = Object.values(analysisOperationsRef.current)
        .some((operation) => ["starting", "queued", "running"].includes(operation.status));
      try {
        const data = await api<{ operations: Operation[] }>("/api/operations?limit=200&operation_type=analyze_job");
        if (disposed) return;

        const nextByJob: Record<string, Operation> = {};
        for (const operation of data.operations) {
          if (operation.operation_type !== "analyze_job") continue;
          const jobId = operation.payload?.job_id;
          if (typeof jobId !== "string" || nextByJob[jobId]) continue;
          nextByJob[jobId] = operation;
        }

        const previousByJob = analysisOperationsRef.current;
        const hasNewTerminalResult = Object.entries(previousByJob).some(([jobId, previous]) => {
          const next = nextByJob[jobId];
          return Boolean(
            next
            && next.operation_id === previous.operation_id
            && (["starting", "queued", "running"].includes(previous.status))
            && next.status !== "starting"
            && next.status !== "queued"
            && next.status !== "running"
          );
        });

        analysisOperationsRef.current = nextByJob;
        setAnalysisOperations(nextByJob);
        setAnalysisMonitorError("");
        hasActiveOperations = Object.values(nextByJob)
          .some((operation) => ["starting", "queued", "running"].includes(operation.status));

        if (hasNewTerminalResult) {
          try {
            await refreshAnalysisViewsRef.current();
          } catch {
            if (!disposed) {
              setAnalysisMonitorError("A job finished, but its saved result could not be refreshed on the dashboard yet.");
            }
          }
        }
      } catch {
        if (hasActiveOperations && !disposed) {
          setAnalysisMonitorError("Live analysis status is temporarily unavailable. Refresh to check its saved state.");
        }
      } finally {
        polling = false;
        if (!disposed) {
          const nextDelay = rerunRequested ? 0 : (hasActiveOperations ? 1500 : 5000);
          rerunRequested = false;
          timer = window.setTimeout(pollAnalysisOperations, nextDelay);
        }
      }
    };

    pollAnalysisOperationsRef.current = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      if (polling) {
        rerunRequested = true;
      } else {
        void pollAnalysisOperations();
      }
    };
    void pollAnalysisOperations();
    return () => {
      disposed = true;
      pollAnalysisOperationsRef.current = () => undefined;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (view !== "networking") return;
    void loadNetworking().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [view, includeInactiveNetworking]);

  useEffect(() => {
    window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth));
  }, [inspectorWidth]);

  useEffect(() => {
    const toggleSidebar = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      setSidebarCollapsed((collapsed) => !collapsed);
    };
    window.addEventListener("keydown", toggleSidebar);
    return () => window.removeEventListener("keydown", toggleSidebar);
  }, []);

  const jobs = useMemo(() => filterJobs(allJobs, filters, {
    date: view === "today" || view === "days" ? selectedDate : undefined,
    ids: view === "jobs" ? matchedSearch?.jobIds : undefined,
    metros: searchOptions?.metros
  }), [allJobs, filters, view, selectedDate, matchedSearch, searchOptions]);
  const opportunityGroups = useMemo(() => buildOpportunityGroups(jobs), [jobs]);
  const todayStats = useMemo(() => {
    const canonicalJobs = opportunityGroups.map((group) => group.canonical);
    return {
      total: opportunityGroups.length,
      newJobs: canonicalJobs.filter((job) => job.status === "new").length,
      packets: canonicalJobs.filter((job) => job.status === "packet_created" || job.status === "ready_to_apply").length,
      blocked: canonicalJobs.filter((job) => job.status === "blocked" || job.fit_tier === "blocked" || job.sponsorship_tier === "blocked_explicit").length
    };
  }, [opportunityGroups]);

  const nav = [
    ["today", "Today", Briefcase],
    ["days", "Days", CalendarDays],
    ["jobs", "Jobs", Table2],
    ["networking", "Networking", Send],
    ["packets", "Packets", FileText],
    ["search", "Add / search", Search],
    ["setup", "Setup", Info]
  ] as const;
  const selectView = (nextView: string) => {
    setView(nextView);
    setSelectedJobId(null);
    const nextUrl = new URL(window.location.href);
    nextUrl.pathname = "/";
    nextUrl.search = "";
    if (nextView !== "today") nextUrl.searchParams.set("view", nextView);
    window.history.replaceState({}, "", `${nextUrl.pathname}${nextUrl.search}`);
  };
  const jobActions: JobActions = {
    codexAvailable: workstation.available,
    unavailableReason: workstation.detail,
    pending: Boolean(busy),
    onAnalyze: (id) => runAction(allJobs.some((job) => job.job_id === id && (job.decision || job.fit_tier)) ? "Re-analyzing job" : "Analyzing job", () => runOperation(`/api/jobs/${id}/analyze`, { method: "POST" })),
    onBuild: (id) => runAction("Building packet", () => runOperation(`/api/jobs/${id}/build-packet`, { method: "POST" })),
    onStatus: updateJobStatus
  };
  const jobsTotalPages = Math.max(1, Math.ceil(opportunityGroups.length / JOBS_PAGE_SIZE));
  const boundedJobsPage = Math.min(jobsPage, jobsTotalPages);
  const paginatedGroups = opportunityGroups.slice((boundedJobsPage - 1) * JOBS_PAGE_SIZE, boundedJobsPage * JOBS_PAGE_SIZE);
  const canonicalJobs = opportunityGroups.map((group) => group.canonical);
  const selectedJobs = canonicalJobs.filter((job) => selectedJobIds.includes(job.job_id));
  const selectedVisibleCount = paginatedGroups.filter((group) => selectedJobIds.includes(group.canonical.job_id)).length;
  const isAnalyzed = (job: Job) => Boolean(job.decision || job.fit_tier || job.status === "analyzed" || job.status === "blocked");
  const eligibleAnalyzeJobs = selectedJobs.filter((job) => !excludeAnalyzed || !isAnalyzed(job));
  const activeAnalysisOperations = Object.values(analysisOperations)
    .filter((operation) => ["starting", "queued", "running"].includes(operation.status));
  const queuedAnalysisCount = activeAnalysisOperations.filter((operation) => ["starting", "queued"].includes(operation.status)).length;
  const runningAnalysisCount = activeAnalysisOperations.filter((operation) => operation.status === "running").length;
  const toggleSelectedJob = (jobId: string) => {
    setSelectedJobIds((ids) => ids.includes(jobId) ? ids.filter((id) => id !== jobId) : [...ids, jobId]);
  };
  const toggleVisibleJobs = () => {
    const visibleIds = paginatedGroups.map((group) => group.canonical.job_id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedJobIds.includes(id));
    setSelectedJobIds((ids) => allVisibleSelected ? ids.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...ids, ...visibleIds])));
  };
  const analyzeSelectedJobs = async () => {
    if (!eligibleAnalyzeJobs.length) return;
    const submittedJobIds = eligibleAnalyzeJobs.map((job) => job.job_id);
    setBusy(`Queueing ${submittedJobIds.length} ${submittedJobIds.length === 1 ? "job" : "jobs"} on the workstation`);
    setError("");
    try {
      const response = await api<AnalyzeBatchResponse>("/api/jobs/analyze-batch", {
        method: "POST",
        body: JSON.stringify({ job_ids: submittedJobIds })
      });
      const nextOperations = { ...analysisOperationsRef.current };
      for (const operation of response.operations) {
        const jobId = operation.payload?.job_id;
        if (typeof jobId === "string") nextOperations[jobId] = operation;
      }
      analysisOperationsRef.current = nextOperations;
      setAnalysisOperations(nextOperations);
      pollAnalysisOperationsRef.current();
      setSelectedJobIds((ids) => ids.filter((id) => !submittedJobIds.includes(id)));
      setAnalyzeMode(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };
  const startInspectorResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (window.innerWidth <= 980) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = inspectorWidth;
    const onPointerMove = (moveEvent: PointerEvent) => {
      setInspectorWidth(clampInspectorWidth(startWidth - (moveEvent.clientX - startX)));
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  };
  const splitStyle = { "--inspector-width": `${inspectorWidth}px` } as React.CSSProperties;
  const workstationState = workstation.checking ? "checking" : workstation.available ? "online" : "offline";
  const workstationLabel = workstation.checking ? "Codex checking" : workstation.available ? "Codex online" : "Codex offline";
  const workstationStateLabel = workstation.checking ? "Checking" : workstation.available ? "Online" : "Offline";
  const workstationTitle = workstation.checking
    ? "Codex checking. Checking workstation availability."
    : `${workstationLabel}. ${workstation.detail} Click to check again.`;

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand">CareerAutomation</div>
          <button
            className="sidebar-toggle"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-keyshortcuts="Control+B"
            title={`${sidebarCollapsed ? "Expand" : "Collapse"} sidebar (Ctrl+B)`}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        </div>
        <nav aria-label="Main navigation">
          {nav.map(([id, label, Icon]) => (
            <button key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} title={label} onClick={() => selectView(id)}>
              <Icon size={17} />
              <span className="nav-label">{label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main>
        {DEMO && <DemoBanner />}
        <header className="topbar">
          <div>
            <h1>{nav.find(([id]) => id === view)?.[1]}</h1>
            <p>{view === "networking" ? `${networkingCompanies.filter((company) => company.active).length} active companies` : selectedDate}</p>
          </div>
          <div className="topbar-actions">
            <button onClick={() => view === "networking"
              ? loadNetworking().catch((err) => setError(err instanceof Error ? err.message : String(err)))
              : refreshJobs()}>
              <RefreshCw size={16} />
              Refresh
            </button>
            <button
              className={`codex-status-button ${workstationState}`}
              title={workstationTitle}
              aria-label={`${workstationLabel}. Check availability`}
              aria-busy={workstation.checking}
              onClick={() => { void workstation.refresh(true); }}
            >
              <span>Codex</span>
              <span className="codex-status-state" role="status">
                <span className="codex-status-light" aria-hidden="true" />
                {workstationStateLabel}
              </span>
            </button>
            <button
              disabled={!workstation.available}
              title={workstation.available ? "Generate today's report with Codex" : workstation.detail}
              onClick={() => runAction("Daily report", async () => {
              const data = await runOperation<{ content: string }>("/api/daily-report", {
                method: "POST",
                body: JSON.stringify({ date: selectedDate })
              });
              setReport(data.content);
            })}>
              <Send size={16} />
              Daily Report
            </button>
          </div>
        </header>

        <div className="activity-notifications" aria-label="Activity notifications">
          {busy && (
            <div className="activity-toast" role="status">
              <RefreshCw size={17} className="activity-spinner" aria-hidden="true" />
              <span>{busy}…</span>
            </div>
          )}
          {activeAnalysisOperations.length > 0 && (
            <div className="activity-toast" role="status">
              <RefreshCw size={17} className={runningAnalysisCount ? "activity-spinner" : ""} aria-hidden="true" />
              <span>
                <strong>Job analysis</strong>
                <small>{runningAnalysisCount ? `${runningAnalysisCount} running` : "Waiting to start"}{queuedAnalysisCount ? ` · ${queuedAnalysisCount} waiting` : ""}</small>
              </span>
            </div>
          )}
          {analysisMonitorError && (
            <div className="activity-toast activity-toast-error" role="alert">
              <Info size={17} aria-hidden="true" />
              <span>{analysisMonitorError}</span>
              <button type="button" aria-label="Dismiss analysis notification" onClick={() => setAnalysisMonitorError("")}><X size={16} /></button>
            </div>
          )}
          {error && (
            <div className="activity-toast activity-toast-error" role="alert">
              <Info size={17} aria-hidden="true" />
              <span>{error}</span>
              <button type="button" aria-label="Dismiss error notification" onClick={() => setError("")}><X size={16} /></button>
            </div>
          )}
        </div>

        {["today", "days", "jobs", "packets"].includes(view) && ((!hasLoadedJobs && jobsLoadStatus !== "ready") || explicitRefresh || jobsLoadStatus === "error") && (
          <div className="jobs-loading-panel" role="status" aria-live="polite">
            {jobsLoadStatus === "loading" || explicitRefresh ? (
              <>
                <RefreshCw size={18} className="jobs-throbber" aria-hidden="true" />
                <span>{hasLoadedJobs ? "Refreshing jobs…" : "Loading your jobs…"}</span>
              </>
            ) : (
              <>
                <strong>{hasLoadedJobs ? "Jobs could not be refreshed." : "Jobs could not be loaded."}</strong>
                <span>{hasLoadedJobs ? "Showing the last loaded results." : "Check your connection to the Site, then try again."}</span>
                <button type="button" onClick={refreshJobs}>Try again</button>
              </>
            )}
          </div>
        )}

        {view === "setup" && <SetupPage api={api} capabilities={capabilities} refresh={refreshCapabilities} onAdd={() => selectView("search")} />}
        {hasLoadedJobs && allJobs.length === 0 && ["today", "jobs"].includes(view) && <section className="tracker-welcome"><h2>Your job tracker is ready.</h2><p>Add a job now. You can connect AI analysis and optional search later; your tracker works without either.</p><div className="button-row"><button className="primary" onClick={() => selectView("search")}>Add a job</button><button onClick={() => selectView("setup")}>Set up my workspace</button></div></section>}
        {hasLoadedJobs && ["today", "days", "jobs", "packets"].includes(view) && (
          <section className={`workspace job-workspace ${view === "jobs" ? "jobs-table-workspace" : ""} split resizable ${inspectorCollapsed ? "details-collapsed" : ""}`} style={splitStyle}>
            <div className="job-list-pane">
            {(view === "today" || view === "days") && <>
              <div className="summary-strip">
                <Metric label="Total" value={todayStats.total} />
                <Metric label="New" value={todayStats.newJobs} />
                <Metric label="Packets" value={todayStats.packets} />
                <Metric label="Blocked" value={todayStats.blocked} />
              </div>
              {view === "days" && <DayTabs days={days} selected={selectedDate} onSelect={setSelectedDate} />}
              <JobTable groups={opportunityGroups} actions={jobActions} onSelect={selectJob} selectedJobId={selectedJobId} analysisOperations={analysisOperations} />
              {report && <MarkdownPanel title="Daily Report" content={report} />}
            </>}
            {view === "jobs" && (
            <div className="jobs-view">
              <div className="jobs-toolbar">
              {matchedSearch && (
                <div className="matched-search-banner">
                  <div>
                    <strong>Latest search matches</strong>
                    <span>{opportunityGroups.length} opportunities across {jobs.length} saved listings</span>
                  </div>
                  <button type="button" onClick={() => setMatchedSearch(null)}>Show all jobs</button>
                </div>
              )}
              <div ref={jobControlsRef} className={`job-controls ${filtersOpen ? "is-open" : ""}`}>
              <button type="button" className="job-controls-toggle" aria-label={filtersOpen ? "Collapse filters and bulk actions" : undefined} title={filtersOpen ? "Collapse filters and bulk actions" : undefined} aria-expanded={filtersOpen} aria-controls="job-filters" onClick={() => { setFiltersOpen(!filtersOpen); setFiltersPinned(false); }}>
                <ChevronDown size={16} /><span>Filters &amp; bulk actions{Object.values(filters).filter(Boolean).length ? ` (${Object.values(filters).filter(Boolean).length} active)` : ""}{analyzeMode ? ` · ${selectedJobIds.length} selected` : ""}</span>
              </button>
              {filtersOpen && <button type="button" className="job-controls-pin" aria-label={filtersPinned ? "Unpin and collapse filters" : "Pin filters open"} title={filtersPinned ? "Unpin and collapse filters" : "Pin filters open"} aria-pressed={filtersPinned} onClick={() => {
                setFiltersPinned(!filtersPinned);
                if (filtersPinned) setFiltersOpen(false);
              }}>{filtersPinned ? <PinOff size={14} /> : <Pin size={14} />}</button>}
              <div id="job-filters" className={`job-filters ${filtersOpen ? "is-open" : ""}`}>
              <Filters
                filters={filters}
                setFilters={setFilters}
                metros={searchOptions?.metros || []}
                days={days}
                hasActiveFilters={Boolean(matchedSearch) || Object.values(filters).some(Boolean)}
                onClearAll={() => {
                  setFilters(EMPTY_FILTERS);
                  setMatchedSearch(null);
                }}
              />
              <BulkActionBar
                codexAvailable={workstation.available}
                unavailableReason={workstation.detail}
                analyzeMode={analyzeMode}
                selectedCount={selectedJobIds.length}
                selectedVisibleCount={selectedVisibleCount}
                eligibleAnalyzeCount={eligibleAnalyzeJobs.length}
                excludeAnalyzed={excludeAnalyzed}
                setExcludeAnalyzed={setExcludeAnalyzed}
                onEnterAnalyzeMode={() => { setDeleteMode(false); setSelectedJobIds([]); setAnalyzeMode(true); }}
                onAnalyze={analyzeSelectedJobs}
                onClear={() => {
                  setSelectedJobIds([]);
                  setAnalyzeMode(false);
                }}
              />
              </div>
              </div>
              <PaginationBar
                total={opportunityGroups.length}
                page={boundedJobsPage}
                pageSize={JOBS_PAGE_SIZE}
                unitLabel="opportunities"
                onPageChange={setJobsPage}
                searchValue={filters.query}
                onSearchChange={(query) => setFilters({ ...filters, query })}
                analysisFilter={filters.analyzed as "" | "no" | "yes"}
                onAnalysisFilterChange={(analyzed) => setFilters({ ...filters, analyzed })}
                deleteMode={deleteMode}
                deleteCount={selectedJobIds.length}
                deleteDisabled={Boolean(busy) || deletePending || !opportunityGroups.length}
                onDelete={() => {
                  if (!deleteMode) {
                    setAnalyzeMode(false);
                    setSelectedJobIds([]);
                    setDeleteMode(true);
                    return;
                  }
                  const groups = opportunityGroups.filter((group) => selectedJobIds.includes(group.canonical.job_id));
                  if (!groups.length) return;
                  deleteTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  setDeleteError("");
                  setDeleteTarget(groups);
                }}
                onCancelDelete={() => { setDeleteMode(false); setSelectedJobIds([]); }}
              />
              </div>
              <div className="jobs-results">
              <JobTable
                groups={paginatedGroups}
                actions={jobActions}
                onSelect={deleteMode ? toggleSelectedJob : selectJob}
                selectedJobId={selectedJobId}
                selectedJobIds={selectedJobIds}
                selectionMode={analyzeMode || deleteMode}
                startIndex={(boundedJobsPage - 1) * JOBS_PAGE_SIZE}
                onToggleJob={analyzeMode || deleteMode ? toggleSelectedJob : undefined}
                onToggleVisible={analyzeMode || deleteMode ? toggleVisibleJobs : undefined}
                analysisOperations={analysisOperations}
              />
              <PaginationBar
                total={opportunityGroups.length}
                page={boundedJobsPage}
                pageSize={JOBS_PAGE_SIZE}
                unitLabel="opportunities"
                onPageChange={setJobsPage}
              />
              </div>
            </div>
            )}
            {view === "packets" && <JobTable groups={buildOpportunityGroups(jobs.filter((job) => Boolean(job.packet_available)))} actions={jobActions} onSelect={selectJob} selectedJobId={selectedJobId} analysisOperations={analysisOperations} />}
            </div>
            {inspectorCollapsed && !compact && <InspectorToggleRail onExpand={() => setInspectorCollapsed(false)} />}
            {!inspectorCollapsed && !compact && <SplitResizeHandle onPointerDown={startInspectorResize} />}
            <JobDetailSurface compact={compact} open={!inspectorCollapsed} selectedId={selectedJobId} onBack={closeJob}>
              {compact && (busy || error) && <div className="detail-feedback" role={error ? "alert" : "status"}>{error || `${busy}…`}{error && <button aria-label="Dismiss error" onClick={() => setError("")}><X size={16} /></button>}</div>}
              {detailError ? <div className="detail-message" role="alert"><h2>Could not load this job</h2><p>{detailError}</p><button onClick={() => selectedJobId && void loadDetail(selectedJobId)}>Try again</button> <button onClick={closeJob}>Close details</button></div>
                : selectedJobId && (detail?.job_id !== selectedJobId || (detailLoading && !detail)) ? <div className="detail-message" role="status"><span>Loading job details…</span><div className="detail-skeleton" /><div className="detail-skeleton" /><button onClick={closeJob}>Close details</button></div>
                : <JobInspector
                  codexAvailable={workstation.available}
                  unavailableReason={workstation.detail}
                  detail={detail}
                  application={application}
                  onAnalyze={jobActions.onAnalyze}
                  onBuild={jobActions.onBuild}
                  onUpdate={updateJobDetails}
                  onStatus={updateJobStatus}
                  onCollapse={closeJob}
                />}
            </JobDetailSurface>
          </section>
        )}

        {view === "networking" && (
          <NetworkingWorkspace
            codexAvailable={workstation.available}
            unavailableReason={workstation.detail}
            companies={networkingCompanies}
            includeInactive={includeInactiveNetworking}
            setIncludeInactive={setIncludeInactiveNetworking}
            onReload={loadNetworking}
            inspectorCollapsed={inspectorCollapsed}
            onInspectorCollapse={() => setInspectorCollapsed(true)}
            onInspectorExpand={() => setInspectorCollapsed(false)}
            onInspectorResize={startInspectorResize}
            splitStyle={splitStyle}
          />
        )}

        {view === "search" && (
          <section className="workspace split">
            <div className="panel">
              <h2>Run Search</h2>
              {capabilities?.search && searchOptions ? (
                <SearchBuilder
                  form={searchForm}
                  setForm={setSearchForm}
                  options={searchOptions}
                  result={searchResult}
                  running={busy === "Searching" || busy === "Retrying failed queries"}
                  onViewMatches={() => {
                    if (!searchResult?.matched_job_ids.length) return;
                    setFilters(EMPTY_FILTERS);
                    setMatchedSearch({ runId: searchResult.run_id, jobIds: searchResult.matched_job_ids });
                    setJobsPage(1);
                    selectView("jobs");
                  }}
                  onRun={() => runAction("Searching", async () => {
                    const locations = searchForm.manualLocation
                      .split("\n")
                      .map((location) => location.trim())
                      .filter(Boolean);
                    const data = await runOperation<SearchResult>("/api/search", {
                      method: "POST",
                      body: JSON.stringify({
                        lanes: searchForm.lanes,
                        metro_ids: searchForm.metro_ids,
                        locations,
                        limit: searchForm.limit,
                        include_edge_check: searchForm.includeEdgeCheck
                      })
                    });
                    setSearchResult(data);
                  })}
                  onRetry={() => runAction("Retrying failed queries", async () => {
                    if (!searchResult?.errors.length) return;
                    const data = await runOperation<SearchResult>("/api/search/retry", {
                      method: "POST",
                      body: JSON.stringify({
                        requests: searchResult.errors.map((error) => ({
                          lane: error.lane,
                          query: error.query,
                          location: error.location,
                          location_source: error.location_source,
                          page: error.page,
                          next_page_token: error.next_page_token
                        })),
                        limit: searchForm.limit
                      })
                    });
                    setSearchResult(data);
                  })}
                />
              ) : (
                <div className="empty"><h3>Integrated search is optional.</h3><p>Save a listing using the form, or ask Codex to ingest selected job links. SerpAPI is only needed to search inside this dashboard.</p><button onClick={() => selectView("setup")}>View setup options</button></div>
              )}
            </div>
            <ManualJobForm
              codexAvailable={workstation.available}
              unavailableReason={workstation.detail}
              form={ingestForm}
              setForm={setIngestForm}
              lanes={searchOptions?.lanes || []}
              result={ingestResult}
              running={busy === "Adding job" || busy === "Adding and analyzing job"}
              onSubmit={() => runAction(ingestForm.analyze && workstation.available ? "Adding and analyzing job" : "Adding job", async () => {
                const response = await api<IngestJobResponse>("/api/jobs/ingest", {
                  method: "POST",
                  body: JSON.stringify({ ...ingestForm, analyze: ingestForm.analyze && workstation.available })
                });
                if (response.analysis_operation) {
                  const nextOperations = {
                    ...analysisOperationsRef.current,
                    [response.job_id]: response.analysis_operation
                  };
                  analysisOperationsRef.current = nextOperations;
                  setAnalysisOperations(nextOperations);
                  pollAnalysisOperationsRef.current();
                }
                setIngestResult(response);
                setIngestForm(EMPTY_MANUAL_INGEST_FORM);
              })}
              onViewJob={(jobId) => {
                setFilters(EMPTY_FILTERS);
                setMatchedSearch({ runId: `manual-${jobId}`, jobIds: [jobId] });
                setJobsPage(1);
                selectView("jobs");
                openJob(jobId);
              }}
            />
          </section>
        )}
        {deleteNotice && <div className="delete-notice" role="status"><Check size={17} /><span>{deleteNotice}</span><button type="button" aria-label="Dismiss deletion message" onClick={() => setDeleteNotice("")}><X size={16} /></button></div>}
        {deleteTarget && <DeleteJobDialog target={deleteTarget} pending={deletePending} error={deleteError} trigger={deleteTriggerRef.current} onCancel={() => { if (!deletePendingRef.current) setDeleteTarget(null); }} onConfirm={confirmDelete} />}
      </main>
    </div>
  );
}

function ManualJobForm({
  codexAvailable,
  unavailableReason,
  form,
  setForm,
  lanes,
  result,
  running,
  onSubmit,
  onViewJob
}: {
  codexAvailable: boolean;
  unavailableReason: string;
  form: ManualIngestFormState;
  setForm: (form: ManualIngestFormState) => void;
  lanes: LaneOption[];
  result: IngestJobResponse | null;
  running: boolean;
  onSubmit: () => Promise<void>;
  onViewJob: (jobId: string) => void;
}) {
  const canSubmit = Boolean(
    form.title.trim()
    && form.company.trim()
    && form.description.trim()
    && form.lane_hint
  );
  return (
    <form
      className="panel manual-job-panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !running) void onSubmit();
      }}
    >
      <header className="manual-job-head">
        <div>
          <h2>Add a job</h2>
          <p>Save a pasted listing with the same lane and review workflow as a search result.</p>
        </div>
        <span>Manual source</span>
      </header>

      <div className="manual-job-grid">
        <label>
          Title
          <input required value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
        </label>
        <label>
          Company
          <input required value={form.company} onChange={(event) => setForm({ ...form, company: event.target.value })} />
        </label>
        <label>
          Location <small>optional</small>
          <input value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} />
        </label>
        <label>
          Lane
          <select required value={form.lane_hint} onChange={(event) => setForm({ ...form, lane_hint: event.target.value })}>
            <option value="">Select a lane</option>
            {lanes.map((lane) => <option key={lane.id} value={lane.id}>{lane.label}</option>)}
            <option value="other">Other</option>
          </select>
        </label>
      </div>

      <label>
        Apply URL <small>optional</small>
        <input type="url" value={form.url} placeholder="https://…" onChange={(event) => setForm({ ...form, url: event.target.value })} />
      </label>
      <label>
        Job description
        <textarea required value={form.description} placeholder="Paste the complete job description" onChange={(event) => setForm({ ...form, description: event.target.value })} />
      </label>

      <div className="manual-intake-options">
        <label>
          Decision
          <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as ManualIngestFormState["status"] })}>
            <option value="new">No decision yet</option>
            <option value="needs_review">Needs review</option>
            <option value="ready_to_apply">Ready to apply</option>
            <option value="applied">Applied</option>
            <option value="skipped">Skipped</option>
          </select>
        </label>
        <label className="manual-analyze-option">
          <input
            type="checkbox"
            checked={form.analyze && codexAvailable}
            disabled={!codexAvailable}
            title={codexAvailable ? "Analyze with Codex after saving" : unavailableReason}
            onChange={(event) => setForm({ ...form, analyze: event.target.checked })}
          />
          <span>
            <strong>Analyze after adding</strong>
            <small>{codexAvailable ? "Run AI Rec and Fit on the workstation." : "Available when your workstation worker is online."}</small>
          </span>
        </label>
      </div>

      <button className="manual-ingest-button" type="submit" disabled={!canSubmit || running}>
        {running ? <RefreshCw size={15} className="spin" /> : <Check size={16} />}
        {form.analyze && codexAvailable ? "Add & analyze" : "Add job"}
      </button>

      {result && (
        <div className="manual-ingest-result" role="status" aria-live="polite">
          <div>
            <strong>{result.created ? "Job added" : "Existing job updated"}</strong>
            <span>
              {result.analysis_operation
                ? (result.analysis_created ? "Analysis was accepted." : "Analysis is already in progress.")
                : `Decision set to ${result.job.status.replace(/_/g, " ")}.`}
            </span>
          </div>
          <button type="button" onClick={() => onViewJob(result.job_id)}>View job</button>
        </div>
      )}
    </form>
  );
}

function NetworkingWorkspace({
  codexAvailable,
  unavailableReason,
  companies,
  includeInactive,
  setIncludeInactive,
  onReload,
  inspectorCollapsed,
  onInspectorCollapse,
  onInspectorExpand,
  onInspectorResize,
  splitStyle
}: {
  codexAvailable: boolean;
  unavailableReason: string;
  companies: NetworkingCompany[];
  includeInactive: boolean;
  setIncludeInactive: (value: boolean) => void;
  onReload: () => Promise<void>;
  inspectorCollapsed: boolean;
  onInspectorCollapse: () => void;
  onInspectorExpand: () => void;
  onInspectorResize: (event: React.PointerEvent<HTMLButtonElement>) => void;
  splitStyle: React.CSSProperties;
}) {
  const compact = useCompactLayout();
  const [selectedCompanyKey, setSelectedCompanyKey] = useState<string | null>(selectedCompanyFromLocation);
  const [researchMode, setResearchMode] = useState(false);
  const [selectedResearch, setSelectedResearch] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [localError, setLocalError] = useState("");
  const [researchProgress, setResearchProgress] = useState<{ current: number; total: number; name: string } | null>(null);
  const visibleCompanies = companies.filter((company) => {
    const matchesQuery = !query || company.display_name.toLowerCase().includes(query.toLowerCase()) || company.roles.some((role) => role.title.toLowerCase().includes(query.toLowerCase()));
    return matchesQuery && (!status || company.status === status);
  });
  const visibleUnresearched = visibleCompanies.filter((company) => !company.research);
  const selectedEligible = selectedResearch.filter((key) => companies.some((company) => company.company_key === key && !company.research));
  const selectedCompany = companies.find((company) => company.company_key === selectedCompanyKey) || null;
  const stats = {
    total: companies.filter((company) => company.active).length,
    notStarted: companies.filter((company) => company.status === "not_started").length,
    active: companies.filter((company) => company.status === "outreach_active" || company.status === "conversation_active").length,
    referrals: companies.filter((company) => company.status === "referral_received").length
  };
  const researchCompanies = async (keys: string[], includeResearched = false) => {
    if (!codexAvailable) {
      setLocalError(unavailableReason);
      return;
    }
    const targets = keys.map((key) => companies.find((company) => company.company_key === key)).filter((company): company is NetworkingCompany => Boolean(company && (includeResearched || !company.research)));
    if (!targets.length) return;
    setLocalError("");
    const failures: string[] = [];
    for (let index = 0; index < targets.length; index += 1) {
      const company = targets[index];
      setResearchProgress({ current: index + 1, total: targets.length, name: company.display_name });
      try {
        await runOperation(`/api/networking/companies/${encodeURIComponent(company.company_key)}/research`, { method: "POST" });
        setSelectedResearch((current) => current.filter((key) => key !== company.company_key));
      } catch (err) {
        failures.push(`${company.display_name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await onReload();
    }
    setResearchProgress(null);
    setResearchMode(false);
    setSelectedResearch([]);
    if (failures.length) setLocalError(failures.join(" "));
  };
  const selectCompany = (companyKey: string) => {
    setSelectedCompanyKey(companyKey);
    const params = new URLSearchParams({ view: "networking", company: companyKey });
    const alreadyOpen = Boolean(selectedCompanyFromLocation());
    const state = { ...window.history.state, careerCompanyEntry: alreadyOpen ? Boolean(window.history.state?.careerCompanyEntry) : true };
    if (alreadyOpen) window.history.replaceState(state, "", `/?${params.toString()}`);
    else window.history.pushState(state, "", `/?${params.toString()}`);
    onInspectorExpand();
  };
  const closeCompany = () => {
    if (window.history.state?.careerCompanyEntry && selectedCompanyFromLocation()) window.history.back();
    else {
      window.history.replaceState({}, "", "/?view=networking");
      setSelectedCompanyKey(null);
    }
    if (!compact) onInspectorCollapse();
  };
  useEffect(() => {
    const restore = () => { const key = selectedCompanyFromLocation(); setSelectedCompanyKey(key); if (key) onInspectorExpand(); };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const leaveResearchMode = () => {
    setResearchMode(false);
    setSelectedResearch([]);
  };
  return (
    <section className={`workspace networking-workspace split resizable ${inspectorCollapsed ? "details-collapsed" : ""}`} style={splitStyle}>
      <div className="networking-main">
        <div className="summary-strip networking-summary">
          <Metric label="Active companies" value={stats.total} />
          <Metric label="Not started" value={stats.notStarted} />
          <Metric label="Outreach / conversations" value={stats.active} />
          <Metric label="Referrals" value={stats.referrals} />
        </div>

        <div className="networking-toolbar">
          <label className="networking-search">
            <span>Find a company or role</span>
            <div><Search size={15} /><input value={query} placeholder="Company or role" onChange={(event) => setQuery(event.target.value)} /></div>
          </label>
          <label>
            <span>Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">All statuses</option>
              <option value="not_started">Not started</option>
              <option value="outreach_active">Outreach active</option>
              <option value="conversation_active">Conversation active</option>
              <option value="referral_received">Referral received</option>
              <option value="paused">Paused</option>
            </select>
          </label>
          <label className="networking-inactive-toggle">
            <input type="checkbox" checked={includeInactive} onChange={(event) => setIncludeInactive(event.target.checked)} />
            Include inactive companies
          </label>
        </div>

        <div className="bulk-action-bar networking-bulk-bar">
          <strong>Bulk actions</strong>
          {researchMode ? (
            <>
              <span>{selectedEligible.length} selected</span>
              <button
                disabled={!visibleUnresearched.length || Boolean(researchProgress)}
                onClick={() => setSelectedResearch(visibleUnresearched.map((company) => company.company_key))}
              >
                Select visible unresearched ({visibleUnresearched.length})
              </button>
              <button title={codexAvailable ? undefined : unavailableReason} disabled={!codexAvailable || !selectedEligible.length || Boolean(researchProgress)} onClick={() => researchCompanies(selectedEligible)}>
                Research selected ({selectedEligible.length})
              </button>
              <button disabled={Boolean(researchProgress)} onClick={leaveResearchMode}>Cancel</button>
            </>
          ) : (
            <>
              <span>Enter Research mode to select companies</span>
              <button title={codexAvailable ? undefined : unavailableReason} disabled={!codexAvailable || Boolean(researchProgress)} onClick={() => setResearchMode(true)}>Research</button>
              <button title={codexAvailable ? undefined : unavailableReason} disabled={!codexAvailable || !visibleUnresearched.length || Boolean(researchProgress)} onClick={() => researchCompanies(visibleUnresearched.map((company) => company.company_key))}>
                Research all unresearched ({visibleUnresearched.length})
              </button>
            </>
          )}
        </div>

        {researchProgress && (
          <div className="networking-progress" role="status">
            <span>Researching {researchProgress.current} of {researchProgress.total}</span>
            <strong>{researchProgress.name}</strong>
            <div><i style={{ transform: `scaleX(${researchProgress.current / researchProgress.total})` }} /></div>
          </div>
        )}
        {localError && <div className="error networking-error">{localError}</div>}

        {compact ? <div className="job-cards" aria-label="Companies">
          {visibleCompanies.map((company) => <article className="job-card" key={company.company_key}>
            {researchMode && !company.research && <label className="mobile-job-selection"><input type="checkbox" aria-label={`Select ${company.display_name} for research`} checked={selectedEligible.includes(company.company_key)} disabled={Boolean(researchProgress)} onChange={() => setSelectedResearch((current) => current.includes(company.company_key) ? current.filter((key) => key !== company.company_key) : [...current, company.company_key])} /> Select company</label>}
            <button type="button" className="job-card-open" aria-label={`View ${company.display_name}`} onClick={() => selectCompany(company.company_key)}>
              <strong>{company.display_name}</strong>
              <span className="job-card-location">{company.roles.length} roles · {company.contacts.length} contacts{!company.active ? " · Inactive" : ""}</span>
              <span className="job-card-facts"><span>{humanize(company.status)}</span><span>{company.research ? "Researched" : "Not researched"}</span></span>
              <span className="job-card-footer"><span>{company.contacts.filter((contact) => contact.referral).length} referrals</span><span>View details →</span></span>
            </button>
          </article>)}
          {!visibleCompanies.length && <div className="empty">No companies match this view.</div>}
        </div> : <div className="networking-table-wrap">
          <table className="networking-table">
            <thead>
              <tr>
                {researchMode && <th className="select-col" aria-label="Research selection" />}
                <th className="networking-company-column">Company / roles</th>
                <th className="networking-people-column">LinkedIn requests</th>
                <th className="networking-people-column">Conversation</th>
                <th>Referral</th>
                <th>Status</th>
                <th>Research</th>
              </tr>
            </thead>
            <tbody>
              {visibleCompanies.map((company) => {
                const selected = selectedCompanyKey === company.company_key;
                const responded = company.contacts.filter((contact) => contact.responded);
                const chats = company.contacts.filter((contact) => contact.coffee_chat);
                const referrals = company.contacts.filter((contact) => contact.referral);
                return (
                  <tr
                    className={`networking-company-row ${selected ? "selected" : ""} ${!company.active ? "inactive" : ""}`}
                    key={company.company_key}
                    onClick={() => selectCompany(company.company_key)}
                  >
                    {researchMode && (
                      <td className="select-col">
                        {!company.research && (
                          <input
                            aria-label={`Select ${company.display_name} for research`}
                            type="checkbox"
                            checked={selectedEligible.includes(company.company_key)}
                            disabled={Boolean(researchProgress)}
                            onClick={(event) => event.stopPropagation()}
                            onChange={() => setSelectedResearch((current) => current.includes(company.company_key) ? current.filter((key) => key !== company.company_key) : [...current, company.company_key])}
                          />
                        )}
                      </td>
                    )}
                    <td>
                      <strong>{company.display_name}</strong>
                      <span>{company.roles.length} {company.roles.length === 1 ? "role" : "roles"}{!company.active ? " · inactive" : ""}</span>
                    </td>
                    <td><NetworkPeopleSummary contacts={company.contacts} empty="No requests" suffix="sent" /></td>
                    <td>
                      <strong>{responded.length} responded · {chats.length} {chats.length === 1 ? "chat" : "chats"}</strong>
                      <span>{summaryNames(Array.from(new Map([...responded, ...chats].map((contact) => [contact.contact_id, contact])).values()))}</span>
                    </td>
                    <td><NetworkPeopleSummary contacts={referrals} empty="No referrals" /></td>
                    <td><Badge value={company.status} /></td>
                    <td>
                      {company.research ? <span className="researched-marker">Researched</span> : <span className="unresearched-marker">Not researched</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!visibleCompanies.length && <div className="empty networking-empty">No companies match this view. Companies appear here when a role is Needs Review, Ready to Apply, or Applied.</div>}
        </div>}
      </div>

      {inspectorCollapsed && !compact && <InspectorToggleRail onExpand={onInspectorExpand} />}
      {!inspectorCollapsed && !compact && <SplitResizeHandle onPointerDown={onInspectorResize} />}
      <JobDetailSurface label="Company details" compact={compact} open={!inspectorCollapsed} selectedId={selectedCompanyKey} onBack={closeCompany}>
        {localError && <div className="detail-feedback" role="alert">{localError}</div>}
        <NetworkingInspector
          codexAvailable={codexAvailable}
          unavailableReason={unavailableReason}
          company={selectedCompany}
          onCollapse={closeCompany}
          onReload={onReload}
          onResearch={(company) => researchCompanies([company.company_key], true)}
          researching={Boolean(researchProgress)}
        />
      </JobDetailSurface>
    </section>
  );
}

function NetworkingInspector({
  codexAvailable,
  unavailableReason,
  company,
  onCollapse,
  onReload,
  onResearch,
  researching
}: {
  codexAvailable: boolean;
  unavailableReason: string;
  company: NetworkingCompany | null;
  onCollapse: () => void;
  onReload: () => Promise<void>;
  onResearch: (company: NetworkingCompany) => void;
  researching: boolean;
}) {
  if (!company) {
    return (
      <aside className="inspector empty inspector-empty">
        <button className="inspector-collapse-button" aria-label="Hide company details panel" title="Hide company details panel" onClick={onCollapse}>
          <PanelRightClose size={17} />
        </button>
        <span>Select a company.</span>
      </aside>
    );
  }
  return (
    <aside className="inspector networking-inspector">
      <div className="networking-inspector-top">
        <button className="inspector-collapse-button" aria-label="Hide company details panel" title="Hide company details panel" onClick={onCollapse}>
          <PanelRightClose size={17} />
        </button>
      </div>
      <NetworkingCompanyDetail
        codexAvailable={codexAvailable}
        unavailableReason={unavailableReason}
        key={company.company_key}
        company={company}
        onReload={onReload}
        onResearch={() => onResearch(company)}
        researching={researching}
      />
    </aside>
  );
}

function NetworkPeopleSummary({ contacts, empty, suffix }: { contacts: NetworkingContact[]; empty: string; suffix?: string }) {
  if (!contacts.length) return <span className="networking-cell-empty">{empty}</span>;
  return (
    <>
      <strong>{contacts.length}{suffix ? ` ${suffix}` : ""}</strong>
      <span>{summaryNames(contacts)}</span>
    </>
  );
}

function summaryNames(contacts: NetworkingContact[]) {
  if (!contacts.length) return "No activity";
  const visible = contacts.slice(0, 2).map((contact) => contact.name);
  return `${visible.join(", ")}${contacts.length > 2 ? `, +${contacts.length - 2}` : ""}`;
}

function NetworkingCompanyDetail({
  codexAvailable,
  unavailableReason,
  company,
  onReload,
  onResearch,
  researching
}: {
  codexAvailable: boolean;
  unavailableReason: string;
  company: NetworkingCompany;
  onReload: () => Promise<void>;
  onResearch: () => void;
  researching: boolean;
}) {
  const blankContact = () => ({ name: "", linkedin_url: "" });
  const [draftContacts, setDraftContacts] = useState<Array<{ name: string; linkedin_url: string }>>([]);
  const [editingContacts, setEditingContacts] = useState<Record<number, { name: string; linkedin_url: string }>>({});
  const [working, setWorking] = useState("");
  const [detailError, setDetailError] = useState("");
  const mutate = async (label: string, action: () => Promise<unknown>) => {
    setWorking(label);
    setDetailError("");
    try {
      await action();
      await onReload();
      return true;
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setWorking("");
    }
  };
  const updateMilestone = (contact: NetworkingContact, field: "request_accepted" | "responded" | "coffee_chat" | "referral", value: boolean) => mutate(
    `Updating ${contact.name}`,
    () => api(`/api/networking/contacts/${contact.contact_id}`, { method: "PATCH", body: JSON.stringify({ [field]: value }) })
  );
  const saveContacts = () => {
    const contacts = draftContacts.filter((contact) => contact.name.trim());
    if (!contacts.length) {
      setDetailError("Add at least one name before saving.");
      return;
    }
    void mutate("Saving LinkedIn requests", async () => {
      await api(`/api/networking/companies/${encodeURIComponent(company.company_key)}/contacts`, {
        method: "POST",
        body: JSON.stringify({ display_name: company.display_name, contacts })
      });
      setDraftContacts([]);
    });
  };
  const stopEditingContact = (contactId: number) => {
    setEditingContacts((current) => {
      const next = { ...current };
      delete next[contactId];
      return next;
    });
  };
  const saveContact = async (contact: NetworkingContact) => {
    const draft = editingContacts[contact.contact_id];
    if (!draft) return;
    const saved = await mutate(
      `Saving ${contact.name}`,
      () => api(`/api/networking/contacts/${contact.contact_id}`, { method: "PATCH", body: JSON.stringify(draft) })
    );
    if (saved) stopEditingContact(contact.contact_id);
  };
  return (
    <div className="networking-detail">
      <div className="networking-detail-head">
        <div>
          <span>Company networking</span>
          <h2>{company.display_name}</h2>
        </div>
        <div>
          <button disabled={Boolean(working)} onClick={() => mutate(company.paused ? "Resuming company" : "Pausing company", () => api(`/api/networking/companies/${encodeURIComponent(company.company_key)}/pause`, {
            method: "PATCH",
            body: JSON.stringify({ display_name: company.display_name, paused: !company.paused })
          }))}>{company.paused ? "Resume" : "Pause"}</button>
          <button title={codexAvailable ? undefined : unavailableReason} disabled={!codexAvailable || researching} onClick={onResearch}>{company.research ? "Research again" : "Research company"}</button>
        </div>
      </div>
      {working && <div className="networking-inline-notice">{working}</div>}
      {detailError && <div className="networking-inline-error">{detailError}</div>}

      <div className="networking-detail-grid">
        <section className="networking-section networking-roles">
          <header><span>Available roles</span><strong>{company.roles.length}</strong></header>
          {company.roles.map((role) => (
            <div className="networking-role" key={role.job_id}>
              <div>
                <strong>{role.title}</strong>
                <span>{role.location || "Location not provided"}</span>
                <small className={`role-research-state ${role.research_stale ? "stale" : role.researched_at ? "ready" : ""}`}>
                  {role.research_stale ? "Research needs refreshing" : role.researched_at ? "Position report ready" : "No position report"}
                </small>
              </div>
              <Badge value={role.status} />
              {role.url && <a href={role.url} target="_blank" rel="noreferrer"><LinkIcon size={14} /> Open</a>}
            </div>
          ))}
          {!company.roles.length && <p className="networking-cell-empty">No currently eligible roles.</p>}
        </section>

        <CompanyResearchQuickView company={company} />
      </div>

      <section className="networking-section networking-requests">
        <header><span>LinkedIn requests</span><strong>{company.contacts.length} sent</strong></header>
        {company.contacts.length > 0 && (
          <div className="networking-contact-list" role="table" aria-label="Sent LinkedIn requests">
            <div className="networking-contact-table-head" role="row">
              <span role="columnheader">Person</span>
              <span role="columnheader">LinkedIn</span>
              <span role="columnheader">Actions</span>
            </div>
            {company.contacts.map((contact) => {
              const isEditing = Boolean(editingContacts[contact.contact_id]);
              const draft = editingContacts[contact.contact_id] || { name: contact.name, linkedin_url: contact.linkedin_url };
              if (isEditing) {
                return (
                  <div className="networking-contact-edit-row" role="row" key={contact.contact_id}>
                    <label role="cell"><span>Name</span><input value={draft.name} onChange={(event) => setEditingContacts({ ...editingContacts, [contact.contact_id]: { ...draft, name: event.target.value } })} /></label>
                    <label role="cell"><span>LinkedIn URL</span><input value={draft.linkedin_url} onChange={(event) => setEditingContacts({ ...editingContacts, [contact.contact_id]: { ...draft, linkedin_url: event.target.value } })} /></label>
                    <div className="networking-contact-actions" role="cell">
                      <button disabled={Boolean(working) || !draft.name.trim()} onClick={() => void saveContact(contact)}>Save</button>
                      <button disabled={Boolean(working)} onClick={() => stopEditingContact(contact.contact_id)}>Cancel</button>
                    </div>
                  </div>
                );
              }
              return (
                <div className="networking-contact-row" role="row" key={contact.contact_id}>
                  <strong role="cell">{contact.name}</strong>
                  <div className="networking-contact-profile" role="cell">
                    {contact.linkedin_url
                      ? <a href={contact.linkedin_url} target="_blank" rel="noreferrer"><LinkIcon size={13} /> Open profile</a>
                      : <span>No profile URL</span>}
                  </div>
                  <div className="networking-contact-actions" role="cell">
                    <button className="networking-icon-button" aria-label={`Edit ${contact.name}`} title={`Edit ${contact.name}`} disabled={Boolean(working)} onClick={() => setEditingContacts({ ...editingContacts, [contact.contact_id]: { name: contact.name, linkedin_url: contact.linkedin_url } })}><Pencil size={14} /></button>
                    <button className="networking-icon-button danger-button" aria-label={`Remove ${contact.name}`} title={`Remove ${contact.name}`} disabled={Boolean(working)} onClick={() => void mutate(`Removing ${contact.name}`, () => api(`/api/networking/contacts/${contact.contact_id}`, { method: "DELETE" }))}><Trash2 size={14} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="networking-add-people">
          <div className="networking-add-head"><strong>Add sent requests</strong>{draftContacts.length > 0 && <span>Add one or several people before saving.</span>}</div>
          {draftContacts.map((contact, index) => (
            <div className="networking-contact-draft" key={index}>
              <label><span>Name</span><input value={contact.name} placeholder="Contact name" onChange={(event) => setDraftContacts(draftContacts.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} /></label>
              <label><span>LinkedIn URL (optional)</span><input value={contact.linkedin_url} placeholder="https://www.linkedin.com/in/..." onChange={(event) => setDraftContacts(draftContacts.map((item, itemIndex) => itemIndex === index ? { ...item, linkedin_url: event.target.value } : item))} /></label>
              <button aria-label={`Remove row ${index + 1}`} onClick={() => setDraftContacts(draftContacts.filter((_, itemIndex) => itemIndex !== index))}><X size={15} /></button>
            </div>
          ))}
          <div className="networking-add-actions">
            <button onClick={() => setDraftContacts([...draftContacts, blankContact()])}>Add another</button>
            {draftContacts.length > 0 && <button disabled={Boolean(working)} onClick={saveContacts}>Save {draftContacts.filter((contact) => contact.name.trim()).length || ""} requests</button>}
          </div>
        </div>
      </section>

      <section className="networking-section networking-milestones">
        <header>
          <div>
            <span>Relationship progress</span>
            <small>Update each person as the conversation advances.</small>
          </div>
          <strong>{company.contacts.filter((contact) => contact.referral).length} referrals</strong>
        </header>
        <div className="networking-milestone-list">
          {company.contacts.map((contact) => (
            <div className="networking-milestone-person" key={contact.contact_id}>
              <div className="networking-milestone-person-head">
                <strong>{contact.name}</strong>
                <span>{contact.referral ? "Referral received" : contact.coffee_chat ? "Coffee chat complete" : contact.responded ? "Conversation active" : contact.request_accepted ? "Request accepted · awaiting reply" : "Awaiting response"}</span>
              </div>
              <div className="networking-milestone-track" role="group" aria-label={`${contact.name} relationship milestones`}>
                <div className="networking-milestone-step request complete">
                  <span className="networking-milestone-icon"><Send size={15} /></span>
                  <span>Request sent</span>
                  <Check className="networking-milestone-check" size={14} />
                </div>
                <MilestoneButton
                  active={contact.request_accepted}
                  disabled={Boolean(working)}
                  icon={<UserCheck size={15} />}
                  label="Request accepted"
                  tone="accepted"
                  onClick={() => updateMilestone(contact, "request_accepted", !contact.request_accepted)}
                />
                <MilestoneButton
                  active={contact.responded}
                  disabled={Boolean(working)}
                  icon={<MessageCircle size={15} />}
                  label="Responded"
                  onClick={() => updateMilestone(contact, "responded", !contact.responded)}
                />
                <MilestoneButton
                  active={contact.coffee_chat}
                  disabled={Boolean(working)}
                  icon={<Coffee size={15} />}
                  label="Coffee chat"
                  onClick={() => updateMilestone(contact, "coffee_chat", !contact.coffee_chat)}
                />
                <MilestoneButton
                  active={contact.referral}
                  disabled={Boolean(working)}
                  icon={<Handshake size={15} />}
                  label="Referral"
                  onClick={() => updateMilestone(contact, "referral", !contact.referral)}
                />
              </div>
            </div>
          ))}
          {!company.contacts.length && <p className="networking-cell-empty">Add LinkedIn requests first.</p>}
        </div>
      </section>

      <section className="networking-section networking-timeline">
        <header><span>Timeline</span><strong>{company.events.length} events</strong></header>
        <div>
          {company.events.map((event) => (
            <div className="networking-event" key={event.event_id}>
              <time>{formatNetworkingDate(event.occurred_at)}</time>
              <span>{event.label}{event.contact_name ? ` · ${event.contact_name}` : ""}</span>
            </div>
          ))}
          {!company.events.length && <p className="networking-cell-empty">Activity appears automatically as you update this company.</p>}
        </div>
      </section>
    </div>
  );
}

function ResearchPage({ companyKey, initialRoleKey }: { companyKey: string; initialRoleKey: string | null }) {
  const workstation = useWorkstationAvailability();
  const [company, setCompany] = useState<NetworkingCompany | null>(null);
  const [activeTab, setActiveTab] = useState(initialRoleKey || "company");
  const [railCollapsed, setRailCollapsed] = useState(() => window.localStorage.getItem(RESEARCH_RAIL_COLLAPSED_KEY) === "true");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");

  const loadCompany = async () => {
    const data = await api<NetworkingCompany>(`/api/networking/companies/${encodeURIComponent(companyKey)}`);
    setCompany(data);
    return data;
  };

  useEffect(() => {
    setLoading(true);
    setError("");
    void loadCompany()
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [companyKey]);

  useEffect(() => {
    if (!company || activeTab === "company") return;
    if (!company.roles.some((role) => role.opportunity_key === activeTab)) {
      setActiveTab("company");
      window.history.replaceState({}, "", researchPath(company.company_key));
    }
  }, [activeTab, company]);

  useEffect(() => {
    window.localStorage.setItem(RESEARCH_RAIL_COLLAPSED_KEY, String(railCollapsed));
  }, [railCollapsed]);

  useEffect(() => {
    const toggleResearchRail = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      setRailCollapsed((collapsed) => !collapsed);
    };
    window.addEventListener("keydown", toggleResearchRail);
    return () => window.removeEventListener("keydown", toggleResearchRail);
  }, []);

  const selectedRole = company?.roles.find((role) => role.opportunity_key === activeTab) || null;
  const selectReport = (reportKey: string) => {
    setActiveTab(reportKey);
    window.history.replaceState(
      {},
      "",
      reportKey === "company" ? researchPath(companyKey) : researchPath(companyKey, reportKey)
    );
  };
  const runResearch = async () => {
    if (!company || !workstation.available) {
      setError(workstation.detail);
      return;
    }
    setError("");
    const isCompanyReport = activeTab === "company";
    setWorking(isCompanyReport ? "Researching company" : `Researching ${selectedRole?.title || "position"}`);
    try {
      if (isCompanyReport) {
        await runOperation(`/api/networking/companies/${encodeURIComponent(company.company_key)}/research`, { method: "POST" });
      } else if (selectedRole) {
        await runOperation(
          `/api/networking/companies/${encodeURIComponent(company.company_key)}/roles/${encodeURIComponent(selectedRole.opportunity_key)}/research`,
          { method: "POST" }
        );
      }
      await loadCompany();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking("");
    }
  };

  if (loading) {
    return (
      <div className="research-page-shell">
        <header className="research-page-topbar loading">
          <div className="research-page-skeleton back" />
          <div><div className="research-page-skeleton title" /><div className="research-page-skeleton subtitle" /></div>
          <div className="research-page-skeleton action" />
        </header>
        <main className="research-page-loading" aria-label="Loading research report">
          <div className="research-page-skeleton rail" />
          <div className="research-page-skeleton document" />
        </main>
      </div>
    );
  }

  if (!company) {
    return (
      <div className="research-page-shell">
        <main className="research-page-state">
          <strong>Research report unavailable</strong>
          <p>{error || "This company is no longer available in Networking."}</p>
          <a href="/?view=networking"><ArrowLeft size={16} /> Back to Networking</a>
        </main>
      </div>
    );
  }

  const isCompanyReport = activeTab === "company";
  const activeResearchedAt = isCompanyReport ? company.researched_at : selectedRole?.researched_at;
  const activeHasResearch = isCompanyReport ? Boolean(company.research) : Boolean(selectedRole?.research);
  const researchDisabled = !workstation.available || Boolean(working) || (!isCompanyReport && !company.research);
  const researchLabel = working
    ? working
    : activeHasResearch
      ? isCompanyReport ? "Research company again" : selectedRole?.research_stale ? "Refresh position research" : "Research position again"
      : isCompanyReport ? "Research company" : "Research position";

  return (
    <div className="research-page-shell">
      <header className="research-page-topbar">
        <a className="research-page-back" href={`/?view=networking&company=${encodeURIComponent(company.company_key)}`}>
          <ArrowLeft size={17} />
          Networking
        </a>
        <div className="research-page-identity">
          <span>Research library</span>
          <div><h1>{company.display_name}</h1><Badge value={company.status} /></div>
          <p>{company.roles.length} active {company.roles.length === 1 ? "position" : "positions"} · {activeResearchedAt ? `Updated ${formatNetworkingDate(activeResearchedAt)}` : "Report not generated"}</p>
        </div>
        <div className="research-page-actions">
          {company.research?.website && <a href={company.research.website} target="_blank" rel="noreferrer">Website <ExternalLink size={14} /></a>}
          <button title={workstation.available ? undefined : workstation.detail} disabled={researchDisabled} onClick={() => void runResearch()}>
            <RefreshCw size={15} />
            {researchLabel}
          </button>
        </div>
      </header>

      {error && <div className="research-page-error">{error}</div>}

      <main className={`research-page-layout ${railCollapsed ? "rail-collapsed" : ""}`}>
        <aside className={`research-page-rail ${railCollapsed ? "collapsed" : ""}`}>
          {railCollapsed ? (
            <button
              className="research-page-rail-toggle collapsed"
              aria-label="Show report sidebar"
              aria-keyshortcuts="Control+B"
              title="Show report sidebar (Ctrl+B)"
              onClick={() => setRailCollapsed(false)}
            >
              <PanelLeftOpen size={17} />
            </button>
          ) : (
            <>
              <div className="research-page-rail-heading">
                <span>Reports</span>
                <div>
                  <strong>{1 + company.roles.length}</strong>
                  <button
                    className="research-page-rail-toggle"
                    aria-label="Hide report sidebar"
                    aria-keyshortcuts="Control+B"
                    title="Hide report sidebar (Ctrl+B)"
                    onClick={() => setRailCollapsed(true)}
                  >
                    <PanelLeftClose size={16} />
                  </button>
                </div>
              </div>
              <nav aria-label={`${company.display_name} research reports`}>
                <button className={isCompanyReport ? "active" : ""} aria-current={isCompanyReport ? "page" : undefined} onClick={() => selectReport("company")}>
                  <span>Company overview</span>
                  <small>{company.researched_at ? formatNetworkingDate(company.researched_at) : "Not researched"}</small>
                </button>
                {company.roles.map((role) => (
                  <button
                    key={role.opportunity_key}
                    className={activeTab === role.opportunity_key ? "active" : ""}
                    aria-current={activeTab === role.opportunity_key ? "page" : undefined}
                    onClick={() => selectReport(role.opportunity_key)}
                  >
                    <span>{role.title}</span>
                    <small className={role.research_stale ? "stale" : ""}>
                      {role.research_stale ? "Refresh recommended" : role.researched_at ? formatNetworkingDate(role.researched_at) : "Not researched"}
                    </small>
                  </button>
                ))}
              </nav>
              <div className="research-page-rail-note">
                <strong>Role context</strong>
                <p>Position reports combine the job description with the latest company brief.</p>
              </div>
            </>
          )}
        </aside>

        <section className="research-page-document">
          <header className="research-page-document-head">
            <div>
              <span>{isCompanyReport ? "Company intelligence" : "Position intelligence"}</span>
              <h2>{isCompanyReport ? "Company overview" : selectedRole?.title}</h2>
              {!isCompanyReport && <p>{selectedRole?.location || "Location not provided"}</p>}
            </div>
            {activeResearchedAt && <time>{formatNetworkingDate(activeResearchedAt)}</time>}
          </header>
          {isCompanyReport ? (
            <CompanyOverviewReport company={company} />
          ) : selectedRole ? (
            <PositionResearchReport company={company} role={selectedRole} />
          ) : (
            <div className="research-empty"><strong>That position is no longer active.</strong><span>Select another report.</span></div>
          )}
        </section>
      </main>
    </div>
  );
}

function CompanyResearchQuickView({ company }: { company: NetworkingCompany }) {
  const research = company.research;
  const summary = companyExecutiveSummary(company);
  const readyRoleReports = company.roles.filter((role) => Boolean(role.researched_at)).length;
  return (
    <section className="networking-section company-research-quick">
      <header>
        <span>Research quick view</span>
        {company.researched_at && <time>{formatNetworkingDate(company.researched_at)}</time>}
      </header>
      {research ? (
        <>
          <div className="company-research-quick-copy">
            <strong>{research.official_name || company.display_name}</strong>
            <p>{summary || "No executive summary was saved with this report."}</p>
          </div>
          <dl className="company-research-quick-facts">
            {research.industry && <div><dt>Industry</dt><dd>{research.industry}</dd></div>}
            {research.headquarters && <div><dt>Headquarters</dt><dd>{research.headquarters}</dd></div>}
            {research.size_and_stage && <div><dt>Stage</dt><dd>{research.size_and_stage}</dd></div>}
          </dl>
          <div className="company-research-quick-meta">
            <span>{readyRoleReports} of {company.roles.length} position reports ready</span>
            {company.roles.some((role) => role.research_stale) && <span className="stale">Some position research is stale</span>}
          </div>
        </>
      ) : (
        <div className="company-research-quick-empty">
          <strong>No company brief yet</strong>
          <span>Use “Research company” above to build the intelligence report.</span>
        </div>
      )}
      <a className="open-full-research" href={researchPath(company.company_key)}>
        <FileText size={16} />
        Open full research
        <ExternalLink size={14} />
      </a>
    </section>
  );
}

function companyExecutiveSummary(company: NetworkingCompany) {
  const research = company.research;
  const text = (research?.editorial?.lede || research?.executive_summary || research?.description || "").trim();
  if (!text) return "";
  const roleTitles = company.roles.map((role) => role.title.toLowerCase()).filter((title) => title.length > 10);
  const roleLeakMarkers = ["tracked role", "tracked position", "job listing", "application strategy", "candidate fit"];
  const normalized = text.toLowerCase();
  const leakIndexes = [...roleLeakMarkers, ...roleTitles]
    .map((marker) => normalized.indexOf(marker))
    .filter((index) => index >= 0);
  if (!leakIndexes.length) return text;
  const companyOnlyText = text.slice(0, Math.min(...leakIndexes)).trim();
  return companyOnlyText || text;
}

function CompanyOverviewReport({ company }: { company: NetworkingCompany }) {
  const research = company.research;
  if (!research) {
    return (
      <div className="research-empty">
        <strong>Build the company brief</strong>
        <span>Research products, customers, strategy, competitors, recent developments, culture, and risks.</span>
      </div>
    );
  }
  if (!research.schema_version || !research.sections) {
    return (
      <article className="research-report legacy-research">
        <div className="research-refresh-note">
          <div><strong>Brief-format research</strong><span>Run company research again to generate the full structured brief.</span></div>
        </div>
        <div className="research-hero">
          <span>Company brief</span>
          <h3>{research.official_name || company.display_name}</h3>
          <p>{research.description || "No summary was saved with this report."}</p>
          <ResearchLinkBar research={research} />
        </div>
      </article>
    );
  }
  const orderedSections: Array<[string, CompanyFinding[]]> = [
    ["Products and services", research.sections.products_and_services],
    ["Customers and use cases", research.sections.customers_and_use_cases],
    ["Traction and strategy", research.sections.traction_and_strategy],
    ["Market and competitors", research.sections.market_and_competitors],
    ["Recent developments", research.sections.recent_developments],
    ["Culture and hiring", research.sections.culture_and_hiring],
    ["Risks and unknowns", research.sections.risks_and_unknowns]
  ];
  if (research.editorial) {
    const takeawayReferenceLabels = [
      `What ${company.display_name} does`,
      "Why customers buy it",
      "Where its advantage may come from",
      "What remains uncertain"
    ];
    return (
      <article className="research-report company-editorial-report">
        <header className="company-article-hero">
          <span>Company profile</span>
          <p className="company-article-name">{research.official_name || company.display_name}</p>
          <h3>{research.editorial.headline}</h3>
          <p className="company-article-dek">{research.explainer?.plain_english || research.editorial.dek}</p>
          {research.explainer && <EditorialCitations urls={research.explainer.source_urls} sources={research.sources || []} />}
          <div className="company-article-meta">
            <span>{DEMO ? "Fictional example / no real company claims" : "Based on " + (research.sources?.length || 0) + " public sources"}</span>
            {company.researched_at && <time>Updated {formatNetworkingDate(company.researched_at)}</time>}
          </div>
          <ResearchLinkBar research={research} />
        </header>
        {research.explainer && <CompanyExplainer data={research.explainer} sources={research.sources || []} />}
        {(research.editorial.executive_takeaways?.length || research.editorial.business_at_a_glance) && (
          <section className="company-memory-brief">
            {research.editorial.executive_takeaways?.length ? (
              <div className="company-takeaways">
                <span>Executive takeaway</span>
                <p className="company-takeaway-paragraph">
                  {research.editorial.executive_takeaways.map((item, index) => (
                    <span className="company-takeaway-sentence" key={`${item.label}-${index}`}>
                      {item.detail.trim()}{/[.!?]$/.test(item.detail.trim()) ? "" : "."}
                      <sup title={takeawayReferenceLabels[index] || item.label} aria-label={`Sentence ${index + 1}: ${takeawayReferenceLabels[index] || item.label}`}>{index + 1}</sup>{" "}
                    </span>
                  ))}
                </p>
                <ol className="company-takeaway-legend">
                  {research.editorial.executive_takeaways.map((item, index) => (
                    <li key={`${item.label}-reference-${index}`}><sup>{index + 1}</sup><span>{takeawayReferenceLabels[index] || item.label}</span></li>
                  ))}
                </ol>
              </div>
            ) : null}
            {research.editorial.business_at_a_glance && (
              <div className="company-glance">
                <span>Business at a glance</span>
                <dl>
                  <ReportFact label="Customer" value={research.editorial.business_at_a_glance.customer} />
                  <ReportFact label="Buyer" value={research.editorial.business_at_a_glance.buyer} />
                  <ReportFact label="Problem" value={research.editorial.business_at_a_glance.problem} />
                  <ReportFact label="Product" value={research.editorial.business_at_a_glance.product} />
                  <ReportFact label="Value" value={research.editorial.business_at_a_glance.value} />
                  <ReportFact label="Growth path" value={research.editorial.business_at_a_glance.growth_path} />
                  <ReportFact label="Strategic question" value={research.editorial.business_at_a_glance.strategic_question} wide />
                  <ReportFact label="Headquarters" value={research.headquarters} />
                  <ReportFact label="Size and stage" value={research.size_and_stage} />
                  <ReportFact label="Business model" value={research.business_model} wide />
                </dl>
              </div>
            )}
          </section>
        )}
        <div className="company-article-body">
          <p className="company-article-lede">{research.editorial.lede}</p>
          {research.editorial.sections.map((section, index) => (
            <section key={`${section.heading}-${index}`}>
              <h4>{section.heading}</h4>
              {section.paragraphs.map((paragraph, paragraphIndex) => (
                <p key={`${section.heading}-${paragraphIndex}`}>{paragraph}</p>
              ))}
              <EditorialCitations urls={section.source_urls} sources={research.sources || []} />
            </section>
          ))}
          <p className="company-article-closing">{research.editorial.closing}</p>
        </div>
        <details className="company-evidence-appendix">
          <summary>
            <div><strong>Evidence and source notes</strong><span>Review the structured findings behind this profile.</span></div>
            <div className="research-section-meta">
              <span>{research.sources?.length || 0}</span>
              <ChevronDown className="research-section-chevron" size={17} />
            </div>
          </summary>
          <div className="company-evidence-body">
            {research.visual_review && (
              <ReportSection title="Visual research" count={research.visual_review.pages_checked.length}>
                <p>{research.visual_review.summary}</p>
                <div className="research-finding-list">
                  {research.visual_review.pages_checked.map(page => (
                    <article className="research-finding" key={page.url}>
                      <strong>{page.status === "inspected" ? "Page inspected" : "Source unavailable"}</strong>
                      <p>{page.notes}</p>
                      <FindingSources urls={[page.url]} sources={research.sources || []} />
                    </article>
                  ))}
                  {research.visual_review.candidates.map((candidate, index) => (
                    <article className="research-finding" key={`${candidate.url}-${index}`}>
                      <strong>{candidate.decision === "selected" ? "Image selected" : "Image not selected"}</strong>
                      <p>{candidate.reason}</p>
                      <FindingSources urls={[candidate.source_url]} sources={research.sources || []} />
                    </article>
                  ))}
                </div>
              </ReportSection>
            )}
            <dl className="research-facts">
              <ReportFact label="Industry" value={research.industry} />
              <ReportFact label="Headquarters" value={research.headquarters} />
              <ReportFact label="Size and stage" value={research.size_and_stage} />
              <ReportFact label="Ownership" value={research.ownership} />
              <ReportFact label="Business model" value={research.business_model} wide />
            </dl>
            {orderedSections.map(([title, findings]) => findings.length > 0 && (
              <CompanyFindingSection key={title} title={title} findings={findings} sources={research.sources || []} />
            ))}
            <ResearchSources sources={research.sources || []} />
          </div>
        </details>
      </article>
    );
  }
  return (
    <article className="research-report">
      <div className="research-refresh-note">
        <div><strong>Evidence-format report</strong><span>Research the company again to add the new editorial profile while preserving these source notes.</span></div>
      </div>
      <div className="research-hero">
        <span>Company intelligence</span>
        <h3>{research.official_name || company.display_name}</h3>
        <ExpandableSummary text={companyExecutiveSummary(company)} />
        <ResearchLinkBar research={research} />
      </div>
      <dl className="research-facts">
        <ReportFact label="Industry" value={research.industry} />
        <ReportFact label="Headquarters" value={research.headquarters} />
        <ReportFact label="Size and stage" value={research.size_and_stage} />
        <ReportFact label="Ownership" value={research.ownership} />
        <ReportFact label="Business model" value={research.business_model} wide />
      </dl>
      {orderedSections.map(([title, findings]) => findings.length > 0 && (
        <CompanyFindingSection key={title} title={title} findings={findings} sources={research.sources || []} />
      ))}
      <ResearchSources sources={research.sources || []} />
    </article>
  );
}

function EditorialCitations({ urls, sources }: { urls: string[]; sources: ResearchSource[] }) {
  if (!urls.length) return null;
  return (
    <div className="company-article-citations" aria-label="Sources for this section">
      {urls.map((url) => {
        const sourceIndex = sources.findIndex((source) => source.url === url);
        const source = sourceIndex >= 0 ? sources[sourceIndex] : null;
        return (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noreferrer"
            title={source?.title || url}
          >
            {sourceIndex >= 0 ? sourceIndex + 1 : "↗"}
          </a>
        );
      })}
    </div>
  );
}

function PositionResearchReport({ company, role }: { company: NetworkingCompany; role: NetworkingRole }) {
  const research = role.research;
  if (!research) {
    return (
      <div className="research-empty role-research-empty">
        <strong>Build this position report</strong>
        <span>Apply the full JD to {company.display_name}'s products, strategy, customers, stakeholders, and hiring context—then turn it into interview and positioning guidance.</span>
        {!company.research && <small>Research the company overview first.</small>}
      </div>
    );
  }
  if ("role_thesis" in research) {
    return <PositionResearchReportV2 role={role} research={research} />;
  }
  return (
    <article className="research-report position-report">
      {role.research_stale && (
        <div className="research-refresh-note stale">
          <div><strong>This report may be stale</strong><span>The JD or company report changed after this position report was generated.</span></div>
        </div>
      )}
      <div className="research-hero">
        <span>Position intelligence</span>
        <h3>{role.title}</h3>
        <small>{role.location || "Location not provided"}</small>
        <ExpandableSummary text={research.executive_summary} />
      </div>
      <details className="role-mandate">
        <summary><span>Likely mandate</span><ChevronDown className="research-section-chevron" size={16} /></summary>
        <div className="role-mandate-body"><p>{research.role_mandate}</p></div>
      </details>
      <RoleFindingSection title="Why this role, why now" findings={research.why_now} sources={research.sources} />
      <RoleFindingSection title="Relevant company context" findings={research.relevant_company_context} sources={research.sources} />

      {research.stakeholders.length > 0 && (
        <ReportSection title="Stakeholder map" count={research.stakeholders.length}>
          <div className="research-card-grid">
            {research.stakeholders.map((item, index) => (
              <div className="research-mini-card" key={`${item.group}-${index}`}>
                <div><strong>{item.group}</strong><EvidenceTag value={item.evidence_type} /></div>
                <p>{item.relationship}</p>
              </div>
            ))}
          </div>
        </ReportSection>
      )}

      {research.success_outcomes.length > 0 && (
        <ReportSection title="What success may look like" count={research.success_outcomes.length}>
          <div className="success-outcomes">
            {research.success_outcomes.map((item, index) => (
              <div key={`${item.timeframe}-${index}`}><strong>{item.timeframe}</strong><p>{item.outcome}</p><small>{item.basis}</small></div>
            ))}
          </div>
        </ReportSection>
      )}

      {research.jd_to_company.length > 0 && (
        <ReportSection title="JD → company context" count={research.jd_to_company.length}>
          <div className="jd-context-list">
            {research.jd_to_company.map((item, index) => (
              <div key={`${item.jd_requirement}-${index}`}>
                <strong>{item.jd_requirement}</strong>
                <p>{item.company_context}</p>
                <span>{item.implication}</span>
              </div>
            ))}
          </div>
        </ReportSection>
      )}

      <div className="research-two-column">
        {research.interview_themes.length > 0 && (
          <ReportSection title="Interview themes" count={research.interview_themes.length} compact>
            <div className="research-simple-list">{research.interview_themes.map((item, index) => <div key={`${item.theme}-${index}`}><strong>{item.theme}</strong><p>{item.what_to_prepare}</p></div>)}</div>
          </ReportSection>
        )}
        {research.networking_targets.length > 0 && (
          <ReportSection title="Networking targets" count={research.networking_targets.length} compact>
            <div className="research-simple-list">{research.networking_targets.map((item, index) => <div key={`${item.target}-${index}`}><strong>{item.target}</strong><span>{item.function}</span><p>{item.reason}</p></div>)}</div>
          </ReportSection>
        )}
      </div>

      {research.questions_to_ask.length > 0 && (
        <ReportSection title="Questions worth asking" count={research.questions_to_ask.length}>
          <ol className="research-question-list">{research.questions_to_ask.map((question, index) => <li key={`${question}-${index}`}>{question}</li>)}</ol>
        </ReportSection>
      )}

      <PositioningSection positioning={research.positioning} />
      <RoleFindingSection title="Risks and unknowns" findings={research.risks_and_unknowns} sources={research.sources} />
      <ResearchSources sources={research.sources} />
    </article>
  );
}

function PositionResearchReportV2({ role, research }: { role: NetworkingRole; research: RoleResearch }) {
  return (
    <article className="research-report position-report position-report-v2">
      {role.research_stale && (
        <div className="research-refresh-note stale">
          <div><strong>This report may be stale</strong><span>The JD or company report changed after this position report was generated.</span></div>
        </div>
      )}
      <section className="position-thesis">
        <span>Role thesis</span>
        <p>{research.role_thesis}</p>
      </section>

      <PositionChapter title="Responsibilities and stakeholders" count={research.responsibilities.length}>
        <ol className="role-responsibility-list">
          {research.responsibilities.map((item, index) => (
            <li key={`${item.responsibility}-${index}`}>
              <div>
                <h5>{item.responsibility}</h5>
                <p>{item.detail}</p>
                {item.stakeholders.length > 0 && (
                  <div className="role-stakeholders">
                    <span>Works with</span>
                    {item.stakeholders.map((stakeholder, stakeholderIndex) => (
                      <span key={`${stakeholder.group}-${stakeholderIndex}`} title={stakeholder.relationship}>{stakeholder.group}</span>
                    ))}
                  </div>
                )}
                <FindingSources urls={item.source_urls} sources={research.sources} />
              </div>
            </li>
          ))}
        </ol>
      </PositionChapter>

      <PositionChapter title="Success outcomes" count={research.success_outcomes.length}>
        <div className="role-outcome-list">
          {research.success_outcomes.map((item, index) => (
            <div key={`${item.outcome}-${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div><strong>{item.outcome}</strong><p>{item.basis}</p></div>
            </div>
          ))}
        </div>
      </PositionChapter>

      <section className="position-fit-thesis">
        <span>Fit thesis</span>
        <p>{research.fit_thesis}</p>
      </section>

      <PositionChapter title="Evidence and gaps" count={research.proof_points.length + research.gaps.length}>
        <div className="position-evidence-grid">
          <div>
            <span>Strongest proof points</span>
            {research.proof_points.map((item, index) => (
              <article key={`${item.label}-${index}`}>
                <strong>{item.label}</strong>
                <p>{item.evidence}</p>
                <small>{item.role_connection}</small>
              </article>
            ))}
          </div>
          <div className="position-gap-column">
            <span>Material gaps</span>
            {research.gaps.map((item, index) => (
              <article key={`${item.gap}-${index}`}>
                <strong>{item.gap}</strong>
                <p>{item.implication}</p>
              </article>
            ))}
          </div>
        </div>
      </PositionChapter>

      <PositionChapter title="Interview preparation" count={research.interview_preparation.length}>
        <div className="interview-preparation">
          {research.interview_preparation.map((item, index) => (
            <article key={`${item.theme}-${index}`}>
              <header><span>{String(index + 1).padStart(2, "0")}</span><h5>{item.theme}</h5></header>
              <dl>
                <div><dt>Likely question</dt><dd>{item.likely_question}</dd></div>
                <div><dt>Story to use</dt><dd>{item.story_to_use}</dd></div>
                <div><dt>Question to ask</dt><dd>{item.question_to_ask}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      </PositionChapter>

      {research.networking_targets.length > 0 && (
        <PositionChapter title="Networking targets" count={research.networking_targets.length} utility>
          <div className="networking-target-list">
            {research.networking_targets.map((item, index) => (
              <div key={`${item.target}-${index}`}>
                <strong>{item.target}</strong>
                <span>{item.function}</span>
                <p>{item.reason}</p>
              </div>
            ))}
          </div>
        </PositionChapter>
      )}
      <ResearchSources sources={research.sources} />
    </article>
  );
}

function PositionChapter({ title, count, utility = false, children }: { title: string; count: number; utility?: boolean; children: React.ReactNode }) {
  return (
    <section className={`position-chapter ${utility ? "utility" : ""}`}>
      <header><h4>{title}</h4><span>{count}</span></header>
      {children}
    </section>
  );
}

function ResearchLinkBar({ research }: { research: CompanyResearch }) {
  return (
    <div className="research-link-bar">
      {research.website && <a href={research.website} target="_blank" rel="noreferrer">Website</a>}
      {research.careers_url && <a href={research.careers_url} target="_blank" rel="noreferrer">Careers</a>}
      {(research.source_urls || []).map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer">Source {index + 1}</a>)}
    </div>
  );
}

function ExpandableSummary({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 520;
  return (
    <>
      <p className={isLong && !expanded ? "collapsed" : ""}>{text}</p>
      {isLong && <button className="research-summary-toggle" onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : "Show more"}</button>}
    </>
  );
}

function ReportFact({ label, value, wide = false }: { label: string; value?: string; wide?: boolean }) {
  if (!value) return null;
  return <div className={`research-fact ${wide ? "wide" : ""}`}><dt>{label}</dt><dd>{value}</dd></div>;
}

function ReportSection({ title, count, compact = false, children }: { title: string; count: number; compact?: boolean; children: React.ReactNode }) {
  return (
    <details className={`research-report-section ${compact ? "compact" : ""}`}>
      <summary>
        <h4>{title}</h4>
        <span className="research-section-meta"><span>{count}</span><ChevronDown className="research-section-chevron" size={16} /></span>
      </summary>
      <div className="research-section-body">{children}</div>
    </details>
  );
}

function CompanyFindingSection({ title, findings, sources }: { title: string; findings: CompanyFinding[]; sources: ResearchSource[] }) {
  return (
    <ReportSection title={title} count={findings.length}>
      <div className="research-finding-list">
        {findings.map((finding, index) => (
          <article className="research-finding" key={`${finding.headline}-${index}`}>
            <div><strong>{finding.headline}</strong><EvidenceTag value={finding.evidence_type || finding.confidence} />{finding.as_of && <time>{finding.as_of}</time>}</div>
            <p>{finding.detail}</p>
            <FindingSources urls={finding.source_urls} sources={sources} />
          </article>
        ))}
      </div>
    </ReportSection>
  );
}

function RoleFindingSection({ title, findings, sources }: { title: string; findings: RoleFinding[]; sources: ResearchSource[] }) {
  if (!findings.length) return null;
  return (
    <ReportSection title={title} count={findings.length}>
      <div className="research-finding-list">
        {findings.map((finding, index) => (
          <article className="research-finding" key={`${finding.headline}-${index}`}>
            <div><strong>{finding.headline}</strong><EvidenceTag value={finding.evidence_type} /></div>
            <p>{finding.detail}</p>
            <FindingSources urls={finding.source_urls} sources={sources} />
          </article>
        ))}
      </div>
    </ReportSection>
  );
}

function EvidenceTag({ value }: { value: string }) {
  return <span className={`evidence-tag ${value}`}>{EVIDENCE_LABELS[value] || value}</span>;
}

function FindingSources({ urls, sources }: { urls: string[]; sources: ResearchSource[] }) {
  const uniqueUrls = Array.from(new Set(urls)).filter(Boolean);
  if (!uniqueUrls.length) return null;
  return (
    <div className="finding-sources">
      {uniqueUrls.map((url) => {
        const source = sources.find((item) => item.url === url);
        return <a key={url} href={url} target="_blank" rel="noreferrer">{source?.publisher || source?.title || "Source"}</a>;
      })}
    </div>
  );
}

function ResearchSources({ sources }: { sources: ResearchSource[] }) {
  if (!sources.length) return null;
  return (
    <details className="research-sources">
      <summary>Sources <span>{sources.length}</span></summary>
      <ol>{sources.map((source, index) => <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.publisher || source.url}</a><span>{[source.publisher, source.published_at].filter(Boolean).join(" · ")}</span></li>)}</ol>
    </details>
  );
}

function PositioningSection({ positioning }: { positioning: LegacyRoleResearch["positioning"] }) {
  return (
    <details className="positioning-section">
      <summary><div className="positioning-head"><span>How to position your experience</span><h4>{positioning.headline}</h4></div><ChevronDown className="research-section-chevron" size={17} /></summary>
      <div className="positioning-body">
        <blockquote>{positioning.opening_pitch}</blockquote>
        {positioning.proof_points.length > 0 && <div className="positioning-proof"><strong>Proof points to lead with</strong><ul>{positioning.proof_points.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div>}
        {positioning.story_angles.length > 0 && (
          <div className="positioning-stories">
            {positioning.story_angles.map((item, index) => <div key={`${item.angle}-${index}`}><strong>{item.angle}</strong><p>{item.candidate_evidence}</p><span>{item.role_connection}</span></div>)}
          </div>
        )}
        {positioning.gaps_and_mitigations.length > 0 && (
          <div className="positioning-gaps"><strong>Gaps to handle directly</strong>{positioning.gaps_and_mitigations.map((item, index) => <div key={`${item.gap}-${index}`}><span>{item.gap}</span><p>{item.mitigation}</p></div>)}</div>
        )}
      </div>
    </details>
  );
}

function MilestoneButton({
  active,
  disabled,
  icon,
  label,
  tone,
  onClick
}: {
  active: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
  tone?: "accepted";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`networking-milestone-step ${tone || ""} ${active ? "complete" : ""}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="networking-milestone-icon">{icon}</span>
      <span>{label}</span>
      {active && <Check className="networking-milestone-check" size={14} />}
    </button>
  );
}

function formatNetworkingDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
}

function InspectorToggleRail({ onExpand }: { onExpand: () => void }) {
  return (
    <aside className="inspector-rail">
      <button
        className="inspector-rail-button"
        aria-label="Show details panel"
        title="Show details panel"
        onClick={onExpand}
      >
        <PanelRightOpen size={17} />
      </button>
    </aside>
  );
}

function SplitResizeHandle({ onPointerDown }: { onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void }) {
  return (
    <button
      className="split-resize-handle"
      aria-label="Resize details panel"
      title="Drag to resize details panel"
      onPointerDown={onPointerDown}
    >
      <GripVertical size={16} />
    </button>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function DayTabs({ days, selected, onSelect }: { days: string[]; selected: string; onSelect: (day: string) => void }) {
  const allDays = days.includes(selected) ? days : [selected, ...days];
  return <div className="day-tabs">{allDays.map((day) => <button key={day} className={day === selected ? "active" : ""} onClick={() => onSelect(day)}>{day}</button>)}</div>;
}

function Filters({
  filters,
  setFilters,
  metros,
  days,
  hasActiveFilters,
  onClearAll
}: {
  filters: FiltersState;
  setFilters: (filters: FiltersState) => void;
  metros: MetroOption[];
  days: string[];
  hasActiveFilters: boolean;
  onClearAll: () => void;
}) {
  type SelectFilterField = Exclude<keyof FiltersState, "location" | "query" | "analyzed">;
  type MultiFilterField = SelectFilterField | "location";
  const fields: MultiFilterField[] = ["date", "lane", "location", "fit", "confidence", "decision", "sponsorship", "status"];
  const [openFields, setOpenFields] = useState<MultiFilterField[]>([]);
  const filterAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !filterAreaRef.current?.contains(event.target)) {
        setOpenFields((current) => current.length ? [] : current);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, []);
  const labels: Partial<Record<keyof FiltersState, string>> = {
    decision: "AI Rec",
    status: "Decision"
  };
  const optionsFor = (field: MultiFilterField) => {
    if (field === "date") return days.map((day) => ({ value: day, label: day }));
    if (field === "location") return metros.map((metro) => ({ value: metro.id, label: metro.label }));
    return FILTER_OPTIONS[field].filter((option) => option.value);
  };
  const allLabelFor = (field: MultiFilterField) => {
    if (field === "date") return "All search dates";
    if (field === "location") return "All locations";
    return FILTER_OPTIONS[field].find((option) => !option.value)?.label || `All ${field}`;
  };
  return (
    <div className="filters" ref={filterAreaRef}>
      {fields.map((field) => (
        <MultiSelectFilter
          key={field}
          label={labels[field] || field}
          allLabel={allLabelFor(field)}
          value={filters[field]}
          options={optionsFor(field)}
          onChange={(value) => setFilters({ ...filters, [field]: value })}
          open={openFields.includes(field)}
          onOpenChange={(isOpen) => setOpenFields((current) => isOpen
            ? (current.includes(field) ? current : [...current, field])
            : current.filter((openField) => openField !== field))}
        />
      ))}
      <button
        type="button"
        className="clear-all-filters"
        disabled={!hasActiveFilters && openFields.length === 0}
        onClick={() => {
          setOpenFields([]);
          onClearAll();
        }}
      >
        <X size={15} />
        Clear all
      </button>
    </div>
  );
}

function MultiSelectFilter({
  label,
  allLabel,
  value,
  options,
  onChange,
  open,
  onOpenChange
}: {
  label: string;
  allLabel: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const selectedValues = splitFilterValues(value);
  const selectedLabels = options.filter((option) => selectedValues.includes(option.value)).map((option) => option.label);
  const allSelected = options.length > 0 && options.every((option) => selectedValues.includes(option.value));
  const displayLabel = selectedLabels.length === 0 ? allLabel : selectedLabels.length === 1 ? selectedLabels[0] : `${selectedLabels.length} selected`;
  const setSelectedValues = (values: string[]) => onChange(values.join(","));
  return (
    <details className="filter-control multi-filter" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
      <summary>
        <span>{label}</span>
        <div className={`multi-filter-trigger ${selectedValues.length ? "active" : ""}`}>
          <span>{displayLabel}</span>
          <ChevronDown size={16} />
        </div>
      </summary>
      <div className="multi-filter-menu">
        <div className="multi-filter-menu-head">
          <strong>{label}</strong>
          <div className="multi-filter-menu-actions">
            <button type="button" disabled={!options.length || allSelected} onClick={() => setSelectedValues(options.map((option) => option.value))}>
              Select all
            </button>
            <button type="button" disabled={!selectedValues.length} onClick={() => onChange("")}>
              <X size={14} />
              Clear
            </button>
          </div>
        </div>
        <div className="multi-filter-options">
          {options.map((option) => (
            <label key={option.value} className="multi-filter-option">
              <input
                type="checkbox"
                checked={selectedValues.includes(option.value)}
                onChange={() => setSelectedValues(toggleValue(selectedValues, option.value))}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>
    </details>
  );
}

function BulkActionBar({
  codexAvailable,
  unavailableReason,
  analyzeMode,
  selectedCount,
  selectedVisibleCount,
  eligibleAnalyzeCount,
  excludeAnalyzed,
  setExcludeAnalyzed,
  onEnterAnalyzeMode,
  onAnalyze,
  onClear
}: {
  codexAvailable: boolean;
  unavailableReason: string;
  analyzeMode: boolean;
  selectedCount: number;
  selectedVisibleCount: number;
  eligibleAnalyzeCount: number;
  excludeAnalyzed: boolean;
  setExcludeAnalyzed: (value: boolean) => void;
  onEnterAnalyzeMode: () => void;
  onAnalyze: () => void;
  onClear: () => void;
}) {
  return (
    <div className="bulk-action-bar">
      {!analyzeMode ? (
        <>
          <div>
            <strong>Bulk actions</strong>
            <span>Enter Analyze mode to select jobs</span>
          </div>
          <button title={codexAvailable ? undefined : unavailableReason} disabled={!codexAvailable} onClick={onEnterAnalyzeMode}>Analyze</button>
        </>
      ) : (
        <>
          <div>
            <strong>{selectedCount}</strong> selected
            <span>{selectedVisibleCount} on this page</span>
          </div>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={excludeAnalyzed}
              onChange={(event) => setExcludeAnalyzed(event.target.checked)}
            />
            Exclude already analyzed
          </label>
          <button title={codexAvailable ? undefined : unavailableReason} disabled={!codexAvailable || !eligibleAnalyzeCount} onClick={onAnalyze}>Analyze selected ({eligibleAnalyzeCount})</button>
          <button onClick={onClear}>Cancel</button>
        </>
      )}
    </div>
  );
}

function PaginationBar({
  total,
  page,
  pageSize,
  unitLabel = "jobs",
  onPageChange,
  searchValue,
  onSearchChange,
  analysisFilter,
  onAnalysisFilterChange,
  deleteMode = false,
  deleteCount = 0,
  deleteDisabled = false,
  onDelete,
  onCancelDelete
}: {
  total: number;
  page: number;
  pageSize: number;
  unitLabel?: string;
  onPageChange: (page: number) => void;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  analysisFilter?: "" | "no" | "yes";
  onAnalysisFilterChange?: (value: "" | "no" | "yes") => void;
  deleteMode?: boolean;
  deleteCount?: number;
  deleteDisabled?: boolean;
  onDelete?: () => void;
  onCancelDelete?: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftPage, setDraftPage] = useState(String(page));
  const searchInputRef = useRef<HTMLInputElement>(null);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(total, page * pageSize);
  useEffect(() => {
    if (!isEditing) setDraftPage(String(page));
  }, [isEditing, page]);
  const commitPage = () => {
    const parsed = Number(draftPage);
    if (Number.isFinite(parsed)) {
      onPageChange(Math.min(totalPages, Math.max(1, Math.trunc(parsed))));
    }
    setIsEditing(false);
  };
  return (
    <div className="pagination-bar">
      <div className="pagination-summary">
        <div>
          <strong>{total}</strong> total {unitLabel}
          {total > 0 && <span>Showing {start}-{end}</span>}
        </div>
        {onSearchChange && (
          <div className="pagination-tools">
            <div className="pagination-search">
              <Search size={15} />
              <input
                ref={searchInputRef}
                aria-label="Search role or company"
                value={searchValue || ""}
                placeholder="Role or company"
                onChange={(event) => onSearchChange(event.target.value)}
              />
              {searchValue && (
                <button
                  type="button"
                  className="pagination-search-clear"
                  aria-label="Clear job search"
                  title="Clear search"
                  onClick={() => {
                    onSearchChange("");
                    searchInputRef.current?.focus();
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
            {onAnalysisFilterChange && (
              <div className="analysis-filter" role="group" aria-label="Analysis status">
                {([
                  ["", "All jobs"],
                  ["no", "Needs analysis"],
                  ["yes", "Analyzed"]
                ] as const).map(([value, label]) => (
                  <button
                    key={value || "all"}
                    type="button"
                    className={(analysisFilter || "") === value ? "active" : ""}
                    aria-pressed={(analysisFilter || "") === value}
                    onClick={() => onAnalysisFilterChange(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {onDelete && <div className="bulk-delete-controls">
              <button type="button" className={`bulk-delete-button ${deleteMode ? "is-selecting" : ""}`} aria-pressed={deleteMode} disabled={deleteDisabled || (deleteMode && !deleteCount)} onClick={onDelete}><Trash2 size={15} />{deleteMode && deleteCount ? `Delete (${deleteCount})` : "Delete"}</button>
              {deleteMode && <><button type="button" className="bulk-delete-cancel" onClick={onCancelDelete}>Cancel</button>{!deleteCount && <span className="bulk-delete-hint" role="status">Select rows to delete</span>}</>}
            </div>}
          </div>
        )}
      </div>
      <div className="pagination-actions">
        <button aria-label="First page" title="First page" disabled={page <= 1} onClick={() => onPageChange(1)}>{"<<"}</button>
        <button aria-label="Previous page" title="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>{"<"}</button>
        {isEditing ? (
          <label className="page-jump">
            <span>Page</span>
            <input
              aria-label="Page number"
              type="number"
              min={1}
              max={totalPages}
              value={draftPage}
              autoFocus
              onChange={(event) => setDraftPage(event.target.value)}
              onBlur={commitPage}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitPage();
                if (event.key === "Escape") {
                  setDraftPage(String(page));
                  setIsEditing(false);
                }
              }}
            />
            <span>of {totalPages}</span>
          </label>
        ) : (
          <button
            className="page-indicator"
            aria-label="Edit page number"
            title="Double click to type a page"
            onDoubleClick={() => {
              setDraftPage(String(page));
              setIsEditing(true);
            }}
          >
            {page} / {totalPages}
          </button>
        )}
        <button aria-label="Next page" title="Next page" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>{">"}</button>
        <button aria-label="Last page" title="Last page" disabled={page >= totalPages} onClick={() => onPageChange(totalPages)}>{">>"}</button>
      </div>
    </div>
  );
}

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function splitFilterValues(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function SearchBuilder({
  form,
  setForm,
  options,
  result,
  running,
  onRun,
  onRetry,
  onViewMatches
}: {
  form: SearchFormState;
  setForm: (form: SearchFormState) => void;
  options: SearchOptions;
  result: SearchResult | null;
  running: boolean;
  onRun: () => void;
  onRetry: () => void;
  onViewMatches: () => void;
}) {
  const selectedLanes = options.lanes.filter((lane) => form.lanes.includes(lane.id));
  const selectedMetros = options.metros.filter((metro) => form.metro_ids.includes(metro.id));
  const manualLocations = form.manualLocation.split("\n").map((location) => location.trim()).filter(Boolean);
  const primaryOrigins = [...selectedMetros.flatMap((metro) => metro.search_locations), ...manualLocations];
  const edgeOriginCount = form.includeEdgeCheck
    ? selectedMetros.filter((metro) => metro.edge_locations.length > 0).length
    : 0;
  const searchOriginCount = primaryOrigins.length + edgeOriginCount;
  const configuredQueries = selectedLanes.reduce((total, lane) => total + lane.queries.length, 0);
  const pageOneRequests = configuredQueries * searchOriginCount;
  const pageLimit = Math.min(options.serpapi.max_pages, Math.ceil(form.limit / options.serpapi.results_per_page));
  const maxSearchRequests = pageOneRequests * pageLimit;
  const maxFetchedJobs = pageOneRequests * form.limit;
  return (
    <div className="search-builder">
      {result && <SearchResultSummary result={result} running={running} onRetry={onRetry} onViewMatches={onViewMatches} />}
      <div className="field-head">
        <div>
          <span>Lane</span>
          <strong>{form.lanes.length} selected</strong>
        </div>
        <div className="hint-popover">
          <button type="button" aria-label="Show lane search details"><Info size={16} /></button>
          <div className="popover-content">
            <strong>What goes to SerpAPI</strong>
            <p>Each selected lane sends its configured queries as the Google Jobs `q` parameter.</p>
            {selectedLanes.map((lane) => (
              <div key={lane.id} className="popover-section">
                <b>{lane.label}</b>
                <span>Target titles: {lane.target_titles.join(", ")}</span>
                <code>q: {lane.queries.join(" | ")}</code>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="check-grid">
        {options.lanes.map((lane) => (
          <label key={lane.id} className="check-card">
            <input
              type="checkbox"
              checked={form.lanes.includes(lane.id)}
              onChange={() => setForm({ ...form, lanes: toggleValue(form.lanes, lane.id) })}
            />
            <span>{lane.label}</span>
            <small>{lane.positioning}</small>
          </label>
        ))}
      </div>

      <div className="field-head">
        <div>
          <span>Metro Areas</span>
          <strong>{form.metro_ids.length} selected</strong>
        </div>
        <p>{options.serpapi.location_guidance}</p>
      </div>
      <div className="check-grid compact">
        {options.metros.map((metro) => (
          <label key={metro.id} className="check-card">
            <input
              type="checkbox"
              checked={form.metro_ids.includes(metro.id)}
              onChange={() => setForm({ ...form, metro_ids: toggleValue(form.metro_ids, metro.id) })}
            />
            <span>{metro.label}</span>
            <small>{metro.search_locations.length} normal origin · {metro.locations.length} cities covered</small>
          </label>
        ))}
      </div>

      <label className="edge-check-option">
        <input
          type="checkbox"
          checked={form.includeEdgeCheck}
          onChange={(event) => setForm({ ...form, includeEdgeCheck: event.target.checked })}
        />
        <span>
          <strong>Include a rotating edge check</strong>
          <small>Adds one outer-metro origin per selected metro. Leave this off for normal searches.</small>
        </span>
      </label>

      <label>
        Manual city/location
        <textarea
          className="manual-location"
          placeholder={"Austin, Texas, United States\nRemote"}
          value={form.manualLocation}
          onChange={(event) => setForm({ ...form, manualLocation: event.target.value })}
        />
      </label>

      <label>
        Max jobs per query-origin pair
        <input type="number" min={1} max={30} value={form.limit} onChange={(event) => setForm({ ...form, limit: Number(event.target.value) })} />
      </label>

      <div className="search-math">
        <strong>Page 1 comes first for every query</strong>
        <span>
          {configuredQueries} queries x {searchOriginCount} search origins = {pageOneRequests} first-page searches. Only after those finish will pagination begin.
        </span>
        <span>Page 2 runs only when Google supplies a next-page token. Page 3 also requires at least {options.serpapi.page3_min_new_opportunities} new opportunities on page 2.</span>
      </div>

      <div className="search-preview">
        <div><span>Estimated SerpAPI searches</span><strong>{pageOneRequests === maxSearchRequests ? pageOneRequests : `${pageOneRequests}–${maxSearchRequests}`}</strong></div>
        <div><span>Search origins</span><strong>{searchOriginCount}</strong></div>
        <div><span>Max jobs fetched</span><strong>{maxFetchedJobs}</strong></div>
      </div>

      <details className="location-preview">
        <summary>Show normal search origins</summary>
        <ul>
          {primaryOrigins.map((location) => <li key={location}>{location}</li>)}
        </ul>
        {form.includeEdgeCheck && selectedMetros.some((metro) => metro.edge_locations.length > 0) && (
          <p>One edge origin rotates weekly from: {selectedMetros.flatMap((metro) => metro.edge_locations).join(", ")}.</p>
        )}
      </details>

      <button className="run-search-button" disabled={running || !form.lanes.length || !primaryOrigins.length} onClick={onRun}>
        {running ? "Search in progress" : "Run Search"}
      </button>
    </div>
  );
}

function SearchResultSummary({
  result,
  running,
  onRetry,
  onViewMatches
}: {
  result: SearchResult;
  running: boolean;
  onRetry: () => void;
  onViewMatches: () => void;
}) {
  const uniqueJobs = result.unique_jobs ?? result.fetched;
  const opportunities = result.unique_opportunities ?? uniqueJobs;
  const existingJobs = result.existing_jobs ?? Math.max(0, uniqueJobs - result.created);
  const searchRequests = result.search_requests ?? result.successful_requests + result.failed_requests;
  const errorSummaries = result.errors.map((error) => {
    const successfulAtLocation = result.searches.filter((search) => search.location === error.location && search.status === "success");
    const fetchedAtLocation = successfulAtLocation.reduce((total, search) => total + search.fetched, 0);
    const createdAtLocation = successfulAtLocation.reduce((total, search) => total + (search.created || 0), 0);
    return { error, successfulQueries: successfulAtLocation.length, fetchedAtLocation, createdAtLocation };
  });
  const title = result.status === "partial" ? "Partial search completed" : result.status === "failed" ? "Search failed" : "Search completed";
  return (
    <div className={`search-result ${result.status}`} role="status" aria-live="polite">
      <div className="search-result-head">
        <div>
          <span className="search-result-eyebrow">Latest run</span>
          <strong>{title}</strong>
          <p>
            {opportunities === uniqueJobs
              ? `${uniqueJobs} unique ${uniqueJobs === 1 ? "job" : "jobs"} matched`
              : `${opportunities} ${opportunities === 1 ? "opportunity" : "opportunities"} across ${uniqueJobs} saved listings`}
          </p>
        </div>
        {uniqueJobs > 0 && <button type="button" className="view-matches-button" onClick={onViewMatches}>View matched jobs</button>}
      </div>
      <div className="search-result-metrics">
        <div><span>New saved</span><strong>{result.created}</strong></div>
        <div><span>Already tracked</span><strong>{existingJobs}</strong></div>
        <div><span>Rows returned</span><strong>{result.fetched}</strong></div>
        <div><span>SerpAPI searches</span><strong>{searchRequests}</strong></div>
      </div>
      {result.cached_requests > 0 && (
        <p className="cache-note">{result.cached_requests} {result.cached_requests === 1 ? "request reused" : "requests reused"} SerpAPI's cache and did not create new paid searches.</p>
      )}
      <span className="search-result-detail">
        {result.successful_requests} successful · {result.failed_requests} failed · {result.pagination_requests || 0} paginated · {result.locations.length} origins · limit {result.limit_per_query_location ?? result.limit_per_lane_location} per query-origin
      </span>
      {errorSummaries.length > 0 && (
        <ul className="search-errors">
          {errorSummaries.map(({ error, successfulQueries, fetchedAtLocation, createdAtLocation }, index) => (
            <li key={`${error.lane}-${error.location}-${error.query}-${index}`}>
              <b>{error.location}</b>: {successfulQueries > 0 && `${successfulQueries} other ${successfulQueries === 1 ? "request" : "requests"} succeeded (${fetchedAtLocation} fetched, ${createdAtLocation} new saved); `}
              {error.query} page {error.page || 1} did not complete: {error.message}
            </li>
          ))}
        </ul>
      )}
      {result.errors.length > 0 && (
        <button type="button" className="retry-search" disabled={running} onClick={onRetry}>
          <RefreshCw size={14} />
          Retry {result.errors.length} failed {result.errors.length === 1 ? "query" : "queries"}
        </button>
      )}
    </div>
  );
}

function RowActions({ job, actions, analysisOperation }: { job: Job; actions: JobActions; analysisOperation?: Operation }) {
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const analysisActive = Boolean(analysisOperation && ["starting", "queued", "running"].includes(analysisOperation.status));
  const analyzed = Boolean(job.decision || job.fit_tier);
  const currentStatus = job.application_status || job.status;
  const close = () => {
    popoverRef.current?.hidePopover();
    triggerRef.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && popoverRef.current?.contains(event.target)) return;
      popoverRef.current?.hidePopover();
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);
  return <>
    <button
      ref={triggerRef}
      type="button"
      className={`row-actions-trigger ${open ? "active" : ""}`}
      aria-label={`Actions for ${job.title} at ${job.company}`}
      aria-expanded={open}
      aria-controls={popoverId}
      aria-haspopup="dialog"
      title="Job actions"
      popoverTarget={popoverId}
      onClick={(event) => event.stopPropagation()}
    ><MoreHorizontal size={14} aria-hidden="true" /></button>
    <div
      ref={popoverRef}
      id={popoverId}
      popover="auto"
      role="dialog"
      aria-label={`Actions for ${job.title} at ${job.company}`}
      className="row-actions-popover"
      onClick={(event) => event.stopPropagation()}
      onToggle={(event) => {
        const isOpen = event.newState === "open";
        setOpen(isOpen);
        if (!isOpen || !triggerRef.current || !popoverRef.current) return;
        const trigger = triggerRef.current.getBoundingClientRect();
        const popover = popoverRef.current;
        const { width, height } = popover.getBoundingClientRect();
        const left = Math.max(8, Math.min(trigger.left, window.innerWidth - width - 8));
        const top = trigger.bottom + height + 6 <= window.innerHeight - 8
          ? trigger.bottom + 6 : Math.max(8, trigger.top - height - 6);
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
        popover.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
      }}
    >
      <span className="row-actions-label">Decision</span>
      {STATUS_OPTIONS.map((status) => <button
        key={status}
        type="button"
        className={currentStatus === status ? "selected-status" : ""}
        aria-pressed={currentStatus === status}
        disabled={actions.pending}
        onClick={() => { close(); actions.onStatus(job.job_id, status); }}
      ><span>{humanize(status)}</span>{currentStatus === status && <Check size={14} aria-hidden="true" />}</button>)}
      <div className="row-actions-divider" />
      <button
        type="button"
        disabled={actions.pending || !actions.codexAvailable || analysisActive}
        title={!actions.codexAvailable ? actions.unavailableReason : analysisActive ? "Analysis is already in progress" : "Analyze this job with Codex"}
        onClick={() => { close(); actions.onAnalyze(job.job_id); }}
      ><RefreshCw size={14} aria-hidden="true" />{analysisActive ? "Analyzing…" : analyzed ? "Analyze again" : "Analyze"}</button>
      <button
        type="button"
        disabled={actions.pending || !actions.codexAvailable}
        title={actions.codexAvailable ? "Build an application packet with Codex" : actions.unavailableReason}
        onClick={() => { close(); actions.onBuild(job.job_id); }}
      ><FileText size={14} aria-hidden="true" />Build packet</button>
      {job.url && job.source_status !== "unavailable" && <>
        <div className="row-actions-divider" />
        <a href={job.url} target="_blank" rel="noreferrer" onClick={close}><ExternalLink size={14} aria-hidden="true" />Open apply link</a>
      </>}
    </div>
  </>;
}

function JobTable({
  groups,
  actions,
  onSelect,
  selectedJobId,
  selectedJobIds = [],
  selectionMode = false,
  startIndex = 0,
  onToggleJob,
  onToggleVisible,
  analysisOperations = {}
}: {
  groups: JobGroup[];
  actions: JobActions;
  onSelect: (id: string) => void;
  selectedJobId: string | null;
  selectedJobIds?: string[];
  selectionMode?: boolean;
  startIndex?: number;
  onToggleJob?: (id: string) => void;
  onToggleVisible?: () => void;
  analysisOperations?: Record<string, Operation>;
}) {
  const compact = useCompactLayout();
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  const allVisibleSelected = groups.length > 0 && groups.every((group) => selectedJobIds.includes(group.canonical.job_id));
  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };
  if (compact) return (
    <div className="job-cards" aria-label="Jobs">
      {selectionMode && onToggleVisible && groups.length > 0 && <label className="mobile-select-all"><input type="checkbox" checked={allVisibleSelected} onChange={onToggleVisible} /> Select visible jobs</label>}
      {groups.map((group, index) => {
        const job = group.canonical;
        const selected = group.variants.some((variant) => variant.job_id === selectedJobId);
        return <article key={group.key} className={`job-card ${selected ? "selected" : ""} ${selectionMode && selectedJobIds.includes(job.job_id) ? "bulk-selected" : ""}`}>
          {selectionMode && onToggleJob && <label className="mobile-job-selection"><input type="checkbox" aria-label={`Select ${job.title}`} checked={selectedJobIds.includes(job.job_id)} onChange={() => onToggleJob(job.job_id)} /> Select job</label>}
          <button type="button" className="job-card-open" onClick={() => onSelect(job.job_id)} aria-label={`View ${job.title} at ${job.company}`}>
            <span className="job-card-eyebrow"><span>{startIndex + index + 1} · {job.company}</span><AnalysisIndicator analyzed={Boolean(job.decision || job.fit_tier)} status={analysisOperations[job.job_id]?.status} /></span>
            <strong>{job.title}</strong>
            <span className="job-card-location">{group.locations.length > 1 ? group.locations.join(" · ") : job.location || "Location not provided"}</span>
            <span className="job-card-facts"><span>Fit: {humanize(job.fit_tier) || "Not analyzed"}</span><span>{manualDecision(job)}</span></span>
            <span className="job-card-footer"><span>{job.decision ? `AI: ${humanize(job.decision)}` : "Awaiting analysis"}{group.listingCount > 1 ? ` · ${group.listingCount} listings` : ""}</span><span>View details →</span></span>
          </button>
          <div className="job-card-actions">
            <RowActions job={job} actions={actions} analysisOperation={analysisOperations[job.job_id]} />
            <RoleCopyButton text={job.url} kind="link" title={job.title} />
            <RoleCopyButton text={job.description} kind="description" title={job.title} />
            {job.url && <a href={job.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Apply link</a>}
          </div>
        </article>;
      })}
      {!groups.length && <div className="empty">No jobs in this view.</div>}
    </div>
  );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="number-col">#</th>
            {selectionMode && onToggleJob && (
              <th className="select-col">
                <input
                  aria-label="Select visible jobs"
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={onToggleVisible}
                />
              </th>
            )}
            <th>Role</th>
            <th>Company</th>
            <th>Location</th>
            <th title="Job posting age reported by SerpAPI, not the date it was found">Posted</th>
            <th>Fit</th>
            <th>AI Rec</th>
            <th>Sponsor</th>
            <th>Decision</th>
            <th>Apply</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group, index) => {
            const job = group.canonical;
            const analysisOperation = analysisOperations[job.job_id];
            const expanded = expandedGroups.includes(group.key);
            const selected = group.variants.some((variant) => variant.job_id === selectedJobId);
            const locationLabel = group.locations.length > 1 ? `${group.locations.length} locations` : (group.locations[0] || job.location || "-");
            return (
              <React.Fragment key={group.key}>
                <tr className={`opportunity-row ${selected ? "selected" : ""} ${selectionMode && selectedJobIds.includes(job.job_id) ? "bulk-selected" : ""}`} onClick={() => onSelect(job.job_id)}>
                  <td className="number-col"><div className="row-number-actions"><span>{startIndex + index + 1}</span><RowActions job={job} actions={actions} analysisOperation={analysisOperation} /></div></td>
                  {selectionMode && onToggleJob && (
                    <td className="select-col">
                      <input
                        aria-label={`Select ${job.title}`}
                        type="checkbox"
                        checked={selectedJobIds.includes(job.job_id)}
                        onClick={(event) => event.stopPropagation()}
                        onChange={() => onToggleJob(job.job_id)}
                      />
                    </td>
                  )}
                  <td>
                    <div className="role-cell">
                      <div className="opportunity-disclosure">
                        <div className="role-quick-copy">
                          <RoleCopyButton text={job.url} kind="link" title={job.title} />
                          <RoleCopyButton text={job.description} kind="description" title={job.title} />
                        {group.listingCount > 1 ? (
                          <button
                            type="button"
                            className={`group-toggle ${expanded ? "expanded" : ""}`}
                            aria-label={`${expanded ? "Collapse" : "Expand"} ${group.listingCount} listings for ${job.title}`}
                            aria-expanded={expanded}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleGroup(group.key);
                            }}
                          >
                            <ChevronDown size={15} />
                          </button>
                        ) : null}
                        </div>
                        <div className="role-copy">
                          <button type="button" className="job-title-button" onClick={(event) => { event.stopPropagation(); onSelect(job.job_id); }}>{job.title}</button>
                          <span className="role-meta">
                            {job.lane || job.lane_hint || "unclassified"}
                            {group.listingCount > 1 && <b>{group.listingCount} listings</b>}
                            {group.sources.length > 1 && <b>{group.sources.length} sources</b>}
                          </span>
                        </div>
                      </div>
                      <AnalysisIndicator analyzed={Boolean(job.decision || job.fit_tier)} status={analysisOperation?.status} />
                    </div>
                  </td>
                  <td>{job.company}</td>
                  <td>{locationLabel}</td>
                  <td title={job.posted_at ? `SerpAPI reported this when the job was found on ${job.found_date}` : "SerpAPI did not provide a posting age"}>
                    {job.posted_at || "-"}
                  </td>
                  <td>{humanize(job.fit_tier)}</td>
                  <td>{job.decision || "-"}</td>
                  <td><Badge value={job.sponsorship_tier || "-"} /></td>
                  <td>{manualDecision(job)}</td>
                  <td>{job.url ? <a href={job.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}><LinkIcon size={15} /> Open</a> : "-"}</td>
                </tr>
                {expanded && (
                  <tr className="variant-row">
                    <td colSpan={selectionMode ? 11 : 10}>
                      <div className="variant-list" aria-label={`Listings for ${job.title}`}>
                        <div className="variant-list-head">
                          <strong>Saved listings</strong>
                          <span>{group.locations.length} {group.locations.length === 1 ? "location" : "locations"} · {group.sources.length} {group.sources.length === 1 ? "source" : "sources"}</span>
                        </div>
                        {group.variants.map((variant) => (
                          <div key={variant.job_id} className={`listing-variant ${selectedJobId === variant.job_id ? "selected" : ""}`}>
                            <button type="button" className="variant-main" onClick={() => onSelect(variant.job_id)}>
                              <strong>{variant.title}</strong>
                              <span>{variant.company} · {variant.location || "Location not provided"}</span>
                              <small title={variant.description}>{variant.description ? `${variant.description.slice(0, 220)}${variant.description.length > 220 ? "…" : ""}` : "No description saved."}</small>
                            </button>
                            <div className="variant-facts">
                              <span>{listingSource(variant)}</span>
                              <span>{variant.posted_at || "Posted date unavailable"}</span>
                            </div>
                            {variant.url ? <a href={variant.url} target="_blank" rel="noreferrer"><LinkIcon size={15} /> Open</a> : <span className="variant-no-link">No link</span>}
                          </div>
                        ))}
                        {group.listingCount > group.variants.length && (
                          <p className="variant-scope-note">This filtered view contains {group.variants.length} of {group.listingCount} listings. Select the opportunity to see every variant in the details panel.</p>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {!groups.length && <div className="empty">No jobs in this view.</div>}
    </div>
  );
}

function DeleteJobDialog({ target, pending, error, trigger, onCancel, onConfirm }: {
  target: JobGroup[];
  pending: boolean;
  error: string;
  trigger: HTMLElement | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    cancelRef.current?.focus();
    return () => {
      dialog.close();
      if (trigger?.isConnected) trigger.focus();
      else document.querySelector<HTMLButtonElement>(".job-title-button, .job-card-open")?.focus();
    };
  }, [trigger]);
  return <dialog ref={dialogRef} className="job-delete-dialog" aria-labelledby="delete-job-heading" aria-describedby="delete-job-description" onCancel={(event) => { event.preventDefault(); if (!pending) onCancel(); }}>
    <div className="delete-dialog-heading"><span className="delete-dialog-icon"><Trash2 size={22} /></span><button type="button" className="delete-dialog-close" aria-label="Cancel deletion" disabled={pending} onClick={onCancel}><X size={19} /></button></div>
    <h2 id="delete-job-heading">Delete {target.length === 1 ? "this job" : `${target.length} jobs`}?</h2>
    <div className="delete-job-summary-list">{target.slice(0, 5).map((group) => <div key={group.key} className="delete-job-summary"><strong>{group.canonical.title}</strong><span>{group.canonical.company}{group.listingCount > 1 ? ` · ${group.listingCount} saved listings` : ""}</span></div>)}{target.length > 5 && <span className="delete-more-jobs">And {target.length - 5} more jobs</span>}</div>
    <p id="delete-job-description">This permanently removes {target.reduce((sum, group) => sum + group.listingCount, 0)} saved {target.reduce((sum, group) => sum + group.listingCount, 0) === 1 ? "listing" : "listings"} across the selected {target.length === 1 ? "row" : "rows"}, including saved analyses and packet links. This cannot be undone.</p>
    {error && <p className="delete-dialog-error" role="alert">{error}</p>}
    <div className="delete-dialog-actions"><button ref={cancelRef} type="button" disabled={pending} onClick={onCancel}>Keep {target.length === 1 ? "job" : "jobs"}</button><button type="button" className="delete-confirm-button" disabled={pending} onClick={onConfirm}>{pending ? <RefreshCw size={16} className="delete-spinner" /> : <Trash2 size={16} />}{pending ? "Deleting…" : `Delete ${target.length === 1 ? "job" : `${target.length} jobs`}`}</button></div>
  </dialog>;
}

function RoleCopyButton({ text, kind, title }: { text?: string; kind: "link" | "description"; title: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => setState("idle"), [text]);
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [state]);
  const subject = kind === "link" ? "application link" : "job description";
  const label = !text ? `No ${subject} available` : state === "copied" ? `${kind === "link" ? "Link" : "Description"} copied!` : state === "error" ? "Copy failed — try again" : `Copy ${subject}`;
  return (
    <button
      type="button"
      className={`job-copy-button role-copy-button ${state}`}
      disabled={!text}
      title={label}
      aria-label={`${label} for ${title}`}
      aria-live="polite"
      onClick={async (event) => {
        event.stopPropagation();
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("error");
        }
      }}
    >
      {state === "copied" ? <Check size={14} /> : state === "error" ? <X size={14} /> : kind === "link" ? <LinkIcon size={14} /> : <FileText size={14} />}
    </button>
  );
}

function AnalysisIndicator({
  analyzed,
  status
}: {
  analyzed: boolean;
  status?: Operation["status"];
}) {
  const activeStatus = status === "starting" ? "queued" : status === "queued" || status === "running" ? status : undefined;
  const failedStatus = status === "failed" || status === "interrupted" ? status : undefined;
  const displayStatus = activeStatus || failedStatus || (status === "succeeded" || analyzed ? "analyzed" : "idle");
  const label = displayStatus === "queued"
    ? "Starting Codex analysis"
    : displayStatus === "running"
      ? "Codex analysis in progress"
      : displayStatus === "failed" || displayStatus === "interrupted"
        ? "Codex analysis did not complete"
        : displayStatus === "analyzed"
          ? "Analyzed by Codex"
          : "Not analyzed";
  const content = displayStatus === "queued"
    ? "…"
    : displayStatus === "running"
      ? <RefreshCw size={11} />
      : displayStatus === "failed" || displayStatus === "interrupted"
        ? "!"
        : displayStatus === "analyzed"
          ? "✓"
          : "";
  return <span className={`analysis-indicator ${displayStatus}`} title={label} aria-label={label}>{content}</span>;
}

function Badge({ value }: { value: string }) {
  return <span className={`badge ${value.replace(/[^a-z_]/g, "")}`}>{humanize(value)}</span>;
}

function humanize(value?: string) {
  return (value || "-").replace(/_/g, " ");
}

function manualDecision(job: Job) {
  const status = job.application_status || job.status;
  return STATUS_OPTIONS.includes(status) ? humanize(status) : "-";
}

function jobClipboardText(detail: JobDetail) {
  return [
    `Job title: ${detail.title}`,
    `Company: ${detail.company}`,
    "",
    "Job description:",
    detail.description || "No description saved."
  ].join("\n");
}

function JobInspector({
  codexAvailable,
  unavailableReason,
  detail,
  application,
  onAnalyze,
  onBuild,
  onUpdate,
  onStatus,
  onCollapse
}: {
  codexAvailable: boolean;
  unavailableReason: string;
  detail: JobDetail | null;
  application: Application | null;
  onAnalyze: (id: string) => void;
  onBuild: (id: string) => void;
  onUpdate: (id: string, changes: { location: string; url: string | null; description: string }) => Promise<void>;
  onStatus: (id: string, status: string) => void;
  onCollapse: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [linkCopyState, setLinkCopyState] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => setLinkCopyState("idle"), [detail?.job_id, detail?.url]);
  useEffect(() => {
    if (linkCopyState === "idle") return;
    const timeout = window.setTimeout(() => setLinkCopyState("idle"), 1800);
    return () => window.clearTimeout(timeout);
  }, [linkCopyState]);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [editDraft, setEditDraft] = useState({ location: "", url: "", description: "" });
  useEffect(() => setCopyState("idle"), [detail?.job_id]);
  useEffect(() => {
    setIsEditing(false);
    setEditError("");
  }, [detail?.job_id]);
  useEffect(() => {
    if (copyState === "idle") return;
    const resetCopyState = window.setTimeout(() => setCopyState("idle"), 1800);
    return () => window.clearTimeout(resetCopyState);
  }, [copyState]);
  if (!detail) {
    return (
      <aside className="inspector empty inspector-empty">
        <button
          className="inspector-collapse-button"
          aria-label="Hide job details panel"
          title="Hide job details panel"
          onClick={onCollapse}
        >
          <PanelRightClose size={17} />
        </button>
        <span>Select a job.</span>
      </aside>
    );
  }
  const memo = detail.analysis?.decision_memo as DecisionMemo | undefined;
  const copyTooltip = copyState === "copied"
    ? "Copied job title, company, and full description"
    : copyState === "error"
      ? "Copy failed — try again"
      : "Copy job title, company, and full description";
  const copyJob = async () => {
    try {
      await navigator.clipboard.writeText(jobClipboardText(detail));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };
  const startEditing = () => {
    setEditDraft({
      location: detail.location || "",
      url: detail.url || "",
      description: detail.description || ""
    });
    setEditError("");
    setIsEditing(true);
  };
  const saveEdits = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);
    setEditError("");
    try {
      await onUpdate(detail.job_id, {
        location: editDraft.location.trim(),
        url: editDraft.url.trim() || null,
        description: editDraft.description.trim()
      });
      setIsEditing(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <aside className="inspector">
      <div className="inspector-head">
        <div>
          <h2>{detail.title}</h2>
          <p>{detail.company} · {detail.location}</p>
        </div>
        <div className="inspector-head-actions">
          <button
            className={`job-edit-button ${isEditing ? "active" : ""}`}
            aria-label={isEditing ? "Close job editor" : "Edit job description, link, and location"}
            title={isEditing ? "Close job editor" : "Edit job description, link, and location"}
            onClick={() => isEditing ? setIsEditing(false) : startEditing()}
          >
            {isEditing ? <X size={16} /> : <Pencil size={16} />}
          </button>
          <button
            className={`job-copy-button ${copyState}`}
            aria-label={copyTooltip}
            aria-live="polite"
            data-tooltip={copyTooltip}
            onClick={() => void copyJob()}
          >
            {copyState === "copied" ? <Check size={16} /> : <Copy size={16} />}
          </button>
          <button
            className="inspector-collapse-button"
            aria-label="Hide job details panel"
            title="Hide job details panel"
            onClick={onCollapse}
          >
            <PanelRightClose size={17} />
          </button>
        </div>
      </div>
      {isEditing && (
        <form className="job-edit-form" onSubmit={(event) => void saveEdits(event)}>
          <div className="job-edit-form-head">
            <div>
              <h3>Edit job details</h3>
              <p>Correct the source data before running a fresh analysis.</p>
            </div>
          </div>
          <label>
            Location
            <input
              value={editDraft.location}
              onChange={(event) => setEditDraft({ ...editDraft, location: event.target.value })}
              placeholder="San Francisco, CA"
            />
          </label>
          <label>
            Direct job link
            <input
              type="url"
              value={editDraft.url}
              onChange={(event) => setEditDraft({ ...editDraft, url: event.target.value })}
              placeholder="https://company.com/careers/role"
            />
          </label>
          <label>
            Job description
            <textarea
              value={editDraft.description}
              onChange={(event) => setEditDraft({ ...editDraft, description: event.target.value })}
              placeholder="Paste the full employer job description"
            />
          </label>
          <p className="job-edit-note">Saving keeps the current analysis visible. “Analyze again” replaces it after the new run succeeds.</p>
          {editError && <p className="job-edit-error">{editError}</p>}
          <div className="job-edit-actions">
            <button type="submit" className="primary" disabled={isSaving}>
              <Check size={15} />
              {isSaving ? "Saving…" : "Save changes"}
            </button>
            <button type="button" disabled={isSaving} onClick={() => setIsEditing(false)}>Cancel</button>
          </div>
        </form>
      )}
      <div className="button-row">
        <button
          disabled={!codexAvailable}
          title={codexAvailable ? (memo ? "Run a new analysis and replace the current result when it succeeds" : "Analyze this job") : unavailableReason}
          onClick={() => onAnalyze(detail.job_id)}
        >
          <RefreshCw size={15} />
          {memo ? "Analyze Again" : "Analyze"}
        </button>
        <button title={codexAvailable ? "Build an application packet with Codex" : unavailableReason} disabled={!codexAvailable} onClick={() => onBuild(detail.job_id)}>Build Packet</button>
      </div>
      <div className="status-button-row">
        {STATUS_OPTIONS.map((status) => (
          <button
            key={status}
            className={detail.status === status || detail.application?.status === status ? "selected-status" : ""}
            onClick={() => onStatus(detail.job_id, status)}
          >
            {humanize(status)}
          </button>
        ))}
      </div>
      {detail.applied_at && (
        <div className="job-applied-date">
          <CalendarDays size={14} aria-hidden="true" />
          Applied <time dateTime={detail.applied_at}>{new Intl.DateTimeFormat("en-US", {
            timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric"
          }).format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(detail.applied_at)
            ? `${detail.applied_at}T12:00:00Z` : detail.applied_at))}</time>
        </div>
      )}
      {detail.url && detail.source_status !== "unavailable" && (
        <div className="apply-link-actions">
          <a className="apply-link" href={detail.url} target="_blank" rel="noreferrer"><LinkIcon size={16} /> Open Apply Link</a>
          <button
            type="button"
            className={`job-copy-button apply-link-copy ${linkCopyState}`}
            aria-label={linkCopyState === "copied" ? "Apply link copied" : linkCopyState === "error" ? "Copy failed — try again" : "Copy apply link"}
            aria-live="polite"
            data-tooltip={linkCopyState === "copied" ? "Link copied!" : linkCopyState === "error" ? "Copy failed — try again" : "Copy apply link"}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(detail.url!);
                setLinkCopyState("copied");
              } catch {
                setLinkCopyState("error");
              }
            }}
          >
            {linkCopyState === "copied" ? <Check size={16} /> : <Copy size={16} />}
          </button>
        </div>
      )}
      <SourceStatusPanel job={detail} />
      {(detail.opportunity_variants?.length || 0) > 1 && (
        <div className="inspector-variants">
          <div className="inspector-variants-head">
            <h3>Opportunity listings</h3>
            <span>{detail.opportunity_variants?.length} saved</span>
          </div>
          {detail.opportunity_variants?.map((variant) => (
            <details key={variant.job_id} className="inspector-variant" open={variant.job_id === detail.job_id}>
              <summary>
                <span><strong>{variant.location || "Location not provided"}</strong>{listingSource(variant)}</span>
                <small>{variant.posted_at || "Posted date unavailable"}</small>
              </summary>
              <p>{variant.title}</p>
              <pre>{variant.description || "No description saved."}</pre>
              {variant.url && <a href={variant.url} target="_blank" rel="noreferrer"><LinkIcon size={15} /> Open {listingSource(variant)}</a>}
            </details>
          ))}
        </div>
      )}
      {memo && <DecisionMemoPanel memo={memo} />}
      {application && (
        <div className="artifacts">
          <h3>Packet</h3>
          {Object.entries(application.files).filter(([, file]) => file.exists).map(([name, file]) => (
            <a key={name} href={file.url} target="_blank" rel="noreferrer">{name}</a>
          ))}
        </div>
      )}
      <MarkdownPanel title="Job Description" content={detail.description || "No description saved."} />
    </aside>
  );
}

function SourceStatusPanel({ job }: { job: Job }) {
  const resolution = job.source_resolution;
  const status = job.source_status || "unresolved";
  const tone = status === "unavailable" || status === "ambiguous" || status === "unresolved" ? "attention" : "ready";
  const originalChanged = Boolean(
    resolution?.original_url
    && (resolution.original_url !== job.url || status === "unavailable")
  );
  return (
    <div className={`source-status-panel ${tone}`}>
      <div className="source-status-head">
        <span>{sourceTierLabel(job.source_tier)}</span>
        <strong>{sourceStatusLabel(status)}</strong>
      </div>
      {resolution?.reason && <p>{resolution.reason}</p>}
      <div className="source-status-meta">
        {job.source_checked_at && <span>Checked {new Date(job.source_checked_at).toLocaleString()}</span>}
        {originalChanged && <a href={resolution?.original_url} target="_blank" rel="noreferrer">Original listing</a>}
      </div>
    </div>
  );
}

function DecisionMemoPanel({ memo }: { memo: DecisionMemo }) {
  return (
    <div className="decision-panel">
      <div className="decision-head">
        <div>
          <h3>AI Recommendation</h3>
          <p>{memo.interview_chance_reasoning || "No rationale saved."}</p>
        </div>
        <Badge value={memo.decision || "-"} />
      </div>

      <div className="decision-grid">
        <MemoMetric label="Fit" value={memo.fit_tier} />
        <MemoMetric label="Sponsor" value={memo.sponsorship_tier} />
        <MemoMetric label="Lane" value={memo.lane} />
        <MemoMetric label="Resume" value={memo.resume_strategy} />
        <MemoMetric label="Confidence" value={memo.confidence} />
        <MemoMetric label="Next" value={memo.recommended_next_step} />
      </div>

      <MemoList title="Why Apply" items={memo.why_apply} tone="positive" />
      <MemoList title="Risks" items={memo.risks} tone="warning" />
      <MemoList title="JD Evidence" items={memo.jd_evidence} />
      <MemoList title="Profile Evidence" items={memo.profile_evidence} />
    </div>
  );
}

function MemoMetric({ label, value }: { label: string; value?: string }) {
  return (
    <div className="memo-metric">
      <span>{label}</span>
      <strong>{humanize(value)}</strong>
    </div>
  );
}

function MemoList({ title, items, tone }: { title: string; items?: string[]; tone?: "positive" | "warning" }) {
  if (!items?.length) return null;
  return (
    <details className={`memo-list ${tone || ""}`} open={title === "Why Apply" || title === "Risks"}>
      <summary>{title}</summary>
      <ul>
        {items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}
      </ul>
    </details>
  );
}

function MarkdownPanel({ title, content }: { title: string; content: string }) {
  return (
    <div className="markdown-panel">
      <h3>{title}</h3>
      <pre>{content}</pre>
    </div>
  );
}

function Root() {
  const researchRoute = researchRouteFromLocation();
  return researchRoute
    ? <>{DEMO && <DemoBanner />}<ResearchPage companyKey={researchRoute.companyKey} initialRoleKey={researchRoute.roleKey} /></>
    : <App />;
}

createRoot(document.getElementById("root")!).render(<Root />);
