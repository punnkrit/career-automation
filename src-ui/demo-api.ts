import { searchOptions } from "../worker/search-config";

export const DEMO = import.meta.env.VITE_DEMO === "true";
const KEY = "careerAutomation.demo.v1";
type Row = Record<string, any>;
const today = new Date().toISOString().slice(0, 10);
const sampleRoles = [
  ["northstar", "AI Implementation Manager", "Northstar Works", "San Francisco, CA", "ai_solutions", "ready_to_apply", "strong", "friendly"],
  ["harbor", "Product Operations Manager", "Harbor Studio", "Remote, United States", "product_ops", "applied", "strong", "unknown"],
  ["cedar", "Strategy & Operations Associate", "Cedar Collective", "New York, NY", "bizops", "needs_review", "plausible", "unknown"],
  ["atlas", "Senior Product Manager", "Atlas Orchard", "Seattle, WA", "ai_product", "skipped", "stretch", "blocked_explicit"],
  ["lumen", "Customer Solutions Consultant", "Lumen Fieldwork", "Los Angeles, CA", "ai_solutions", "new", "", ""],
  ["meridian", "Technical Program Manager", "Meridian Loop", "Boston, MA", "tpm_epm", "needs_review", "plausible", "unknown"],
];

function fixtures() {
  return sampleRoles.map(([id, title, company, location, lane, status, fit, sponsorship]) => ({
    job_id: id, title, company, location, lane_hint: lane, lane, status,
    source: "manual", source_tier: "manual", source_status: "preferred", found_date: today,
    posted_at: "2 days ago", opportunity_key: id, opportunity_listing_count: 1,
    applied_at: status === "applied" ? today + "T09:00:00Z" : null,
    description: `Job Title: ${title}\nCompany: ${company}\n\nFICTIONAL DEMO LISTING\n\nHelp teams turn complex operational processes into reliable, useful tools. Partner with customers, product managers, and engineers to define the problem, map the current workflow, and measure whether the solution helps.\n\nResponsibilities\n- Lead discovery sessions and translate needs into a delivery plan.\n- Build and validate workflows using data, APIs, and clear business rules.\n- Investigate exceptions and improve the experience after launch.\n- Define success measures and communicate progress.\n\nQualifications\nExperience in analytics, implementation, or product operations. Strong communication and SQL skills. Familiarity with AI-assisted workflows is useful.\n\n${sponsorship === "friendly" ? "Sample listing explicitly states sponsorship may be available for qualified candidates." : sponsorship === "blocked_explicit" ? "Sample listing explicitly states no employment sponsorship is available." : "This sample listing does not state a sponsorship policy."}`,
    ...(fit ? { decision: fit === "stretch" ? "skip" : "apply", fit_tier: fit, sponsorship_tier: sponsorship, resume_strategy: lane, confidence: "medium" } : {}),
    packet_available: id === "northstar", application_status: id === "northstar" ? "ready_to_apply" : undefined,
  }));
}

let memory: Row[] | null = null;
function jobs(): Row[] {
  if (memory) return memory;
  try { const value = JSON.parse(localStorage.getItem(KEY) || "null"); if (Array.isArray(value) && value.every(j => typeof j.job_id === "string" && typeof j.title === "string")) memory = value; } catch { /* fresh fixtures */ }
  return memory ||= fixtures();
}
function persist() { try { localStorage.setItem(KEY, JSON.stringify(jobs())); } catch { /* session-only state is still usable */ } }
export function resetDemo() { memory = fixtures(); persist(); }

function memo(job: Row) {
  return {
    decision: job.decision, fit_tier: job.fit_tier, sponsorship_tier: job.sponsorship_tier,
    lane: job.lane, resume_strategy: job.lane, confidence: "medium",
    interview_chance_reasoning: "Prepared sample analysis for Alex Morgan, a fictional candidate. Alex's analytics and customer implementation experience maps to the core workflow responsibilities. The main gap is direct ownership of larger enterprise deployments.",
    why_apply: ["Customer discovery and workflow delivery are central to this role.", "SQL analysis and cross-functional communication align with Alex's sample background."],
    risks: ["Validate the scope of technical implementation expected in an interview.", job.sponsorship_tier === "friendly" ? "Positive language in a listing is not a guarantee for an individual applicant." : "Sponsorship eligibility needs explicit confirmation; do not infer it."],
    jd_evidence: ["The fictional posting asks for workflow discovery, API integration, and post-launch improvement."],
    profile_evidence: ["Alex's fictional profile includes support analytics and a customer onboarding project."],
    recommended_next_step: "Review the gaps, then make your own application decision.",
  };
}

function company(key: string): Row {
  const job = jobs().find(j => j.job_id === key);
  if (!job) throw new Error("Sample company not found.");
  job._demo_contacts ??= key === "northstar" ? [{ contact_id: 1, name: "Jamie Chen (fictional)", linkedin_url: "", request_accepted: true, responded: true, coffee_chat: false, referral: false }] : [];
  job._demo_events ??= key === "northstar" ? [{ event_id: 1, event_type: "responded", label: "Replied to introduction", contact_name: "Jamie Chen", occurred_at: today + "T09:00:00Z" }] : [];
  const contacts = job._demo_contacts;
  return {
    company_key: key, display_name: job.company, active: true, paused: Boolean(job._demo_paused),
    status: job._demo_paused ? "paused" : contacts.some((c: Row) => c.referral) ? "referral_received" : contacts.some((c: Row) => c.responded) ? "conversation_active" : contacts.length ? "outreach_active" : "not_started",
    roles: [{ ...job, opportunity_key: key, research: null }],
    contacts, events: job._demo_events,
    contacts_count: contacts.length, request_count: contacts.length,
    responded_count: contacts.filter((c: Row) => c.responded).length,
    researched_at: today + "T12:00:00Z",
    research: key === "northstar" ? {
      schema_version: 1,
      sections: { products_and_services: [], customers_and_use_cases: [], traction_and_strategy: [], market_and_competitors: [], recent_developments: [], culture_and_hiring: [], risks_and_unknowns: [] },
      official_name: job.company, website: "", careers_url: "", industry: "Workflow software (fictional)", headquarters: "San Francisco, CA", size_and_stage: "Illustrative growth-stage company", ownership: "Fictional private company",
      business_model: "Subscription software plus implementation services.",
      executive_summary: "A prepared fictional company report demonstrating how research sits beside your application workflow.",
      editorial: {
        schema_version: 1, headline: "Making the work between systems easier", dek: "A fictional company profile, prepared to show the research experience.",
        lede: "Northstar Works helps operations teams connect fragmented tools and turn repeatable work into dependable workflows. Its implementation team is the bridge between what the software can do and what a customer actually needs.",
        executive_takeaways: [{ label: "The customer", detail: "Operations teams juggling spreadsheets and disconnected systems." }, { label: "The role", detail: "Translate a messy workflow into something people can adopt." }],
        business_at_a_glance: { customer: "Mid-sized service businesses", buyer: "Head of Operations", problem: "Work gets lost between tools", product: "Workflow software", value: "Less repeated administration", growth_path: "Expand into adjacent teams", strategic_question: "Can implementation stay repeatable as customer needs become more complex?" },
        sections: [{ heading: "Where the role fits", paragraphs: ["The implementation manager helps customers define success, configure workflows, and recognize exceptions early. This makes discovery and communication just as important as technical execution."], source_urls: [] }, { heading: "What to ask in a conversation", paragraphs: ["How does the team measure adoption after launch? Which customer requests become product features, and which stay implementation work?"], source_urls: [] }],
        closing: "This report is entirely fictional. A real report should distinguish sourced facts, interpretation, and unknowns.",
      }, sources: [],
    } : null,
  };
}


export async function demoRequest(path: string, init?: RequestInit): Promise<any> {
  const route = path.split("?")[0];
  const method = init?.method || "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (route === "/api/setup") return { tracker: true, profile: true, worker_configured: false, search: false, demo: true };
  if (route === "/api/codex/status" || route === "/api/worker/status") return { ok: false, mode: "demo", error: "Demo uses saved sample analyses. No AI worker is connected." };
  if (route === "/api/search/options") return searchOptions;
  if (route === "/api/jobs" && method === "GET") return { jobs: jobs() };
  if (route === "/api/days") return { days: [...new Set(jobs().map(j => j.found_date))].sort().reverse() };
  if (route === "/api/operations") return { operations: [] };
  if (route.startsWith("/api/reports/")) return "";
  if (route === "/api/jobs/ingest") {
    if (!body.title?.trim() || !body.company?.trim() || !body.description?.trim() || !body.lane_hint) throw new Error("Add a title, company, description, and lane.");
    const existing = jobs().find(j => ["title", "company", "location", "url"].every(k => String(j[k] || "").trim().toLowerCase() === String(body[k] || "").trim().toLowerCase()));
    const job = existing || { ...body, job_id: crypto.randomUUID(), source: "manual", found_date: today, opportunity_key: crypto.randomUUID() };
    if (!existing) job.status = body.status || "needs_review"; job.lane_hint = body.lane_hint; job.lane = body.lane_hint;
    if (!existing) jobs().unshift(job);
    persist(); return { job_id: job.job_id, created: !existing, job, analysis_operation: null, analysis_created: false };
  }
  if (route === "/api/jobs" && method === "DELETE") { const ids = new Set((body.jobs || []).map((j: Row) => j.job_id)); memory = jobs().filter(j => !ids.has(j.job_id)); persist(); return { deleted_job_ids: [...ids] }; }
  const jobMatch = route.match(/^\/api\/jobs\/([^/]+)(?:\/(status))?$/);
  if (jobMatch) {
    const job = jobs().find(j => j.job_id === decodeURIComponent(jobMatch[1]));
    if (!job) throw new Error("Sample job not found. Reset the demo to restore it.");
    if (method === "DELETE") { memory = jobs().filter(j => j.job_id !== job.job_id); persist(); return { deleted_job_ids: [job.job_id] }; }
    if (method === "PATCH" || method === "POST") { Object.assign(job, body); if (body.status === "applied" && !job.applied_at) job.applied_at = new Date().toISOString(); persist(); }
    return { ...job, analysis: job.fit_tier ? { ...memo(job), decision_memo: memo(job) } : null, application: job.packet_available ? { status: "ready_to_apply", resume_strategy: job.lane, packet_date: today } : null, opportunity_variants: [job] };
  }
  if (route.startsWith("/api/applications/")) return { files: { "application-notes.md": { url: "/sample-packet.txt", exists: true } } };
  if (route === "/api/networking/companies") return { companies: jobs().map(j => company(j.job_id)) };
  const companyAction = route.match(/^\/api\/networking\/companies\/([^/]+)\/(contacts|pause)$/);
  if (companyAction) {
    const key = decodeURIComponent(companyAction[1]); company(key);
    const job = jobs().find(j => j.job_id === key)!;
    if (companyAction[2] === "pause") job._demo_paused = Boolean(body.paused);
    else for (const contact of body.contacts || []) {
      const name = String(contact.name || "").trim(); if (!name) continue;
      const contact_id = Date.now() + Math.floor(Math.random() * 100000);
      job._demo_contacts.push({ contact_id, name, linkedin_url: String(contact.linkedin_url || ""), request_accepted: false, responded: false, coffee_chat: false, referral: false });
      job._demo_events.unshift({ event_id: contact_id, event_type: "linkedin_request", contact_name: name, occurred_at: new Date().toISOString() });
    }
    persist(); return company(key);
  }
  const contactAction = route.match(/^\/api\/networking\/contacts\/(\d+)$/);
  if (contactAction) {
    for (const job of jobs()) {
      company(job.job_id);
      const contact = job._demo_contacts.find((c: Row) => c.contact_id === Number(contactAction[1]));
      if (!contact) continue;
      if (method === "DELETE") job._demo_contacts = job._demo_contacts.filter((c: Row) => c !== contact);
      else {
        for (const field of ["name", "linkedin_url", "request_accepted", "responded", "coffee_chat", "referral"]) {
          if (body[field] === undefined) continue;
          contact[field] = body[field];
          if (body[field] === true) job._demo_events.unshift({ event_id: Date.now(), event_type: field, contact_name: contact.name, occurred_at: new Date().toISOString() });
        }
      }
      persist(); return contact;
    }
    throw new Error("Sample contact not found.");
  }
  const companyMatch = route.match(/^\/api\/networking\/companies\/([^/]+)$/);
  if (companyMatch) return company(decodeURIComponent(companyMatch[1]));
  throw new Error("This action needs your own private installation. The demo uses fictional, saved results and never runs live AI or search.");
}
