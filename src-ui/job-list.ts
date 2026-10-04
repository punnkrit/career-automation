export type FiltersState = {
  query: string;
  date: string;
  analyzed: string;
  status: string;
  lane: string;
  location: string;
  fit: string;
  confidence: string;
  decision: string;
  sponsorship: string;
};

type FilterableJob = {
  job_id: string;
  title: string;
  company: string;
  location: string;
  found_date: string;
  status: string;
  decision?: string | null;
  lane?: string | null;
  lane_hint?: string | null;
  fit_tier?: string | null;
  confidence?: string | null;
  sponsorship_tier?: string | null;
};

type Scope = {
  date?: string;
  ids?: string[];
  metros?: { id: string; locations: string[] }[];
};

const values = (value: string) => value.split(",").map((part) => part.trim()).filter(Boolean);
const manualStatuses = new Set(["needs_review", "ready_to_apply", "applied", "skipped"]);

// Filter listings before grouping so matches in alternate listings remain visible.
export function filterJobs<T extends FilterableJob>(jobs: T[], filters: FiltersState, scope: Scope = {}): T[] {
  const query = filters.query.toLowerCase();
  const dates = values(scope.date ?? filters.date);
  const ids = scope.ids ? new Set(scope.ids) : undefined;
  const statuses = values(filters.status);
  const lanes = values(filters.lane);
  // The backend expands each location to its city as well as longer forms.
  // The city substring subsumes those longer forms.
  const locations = values(filters.location).flatMap((selected) => {
    const locations = scope.metros?.find((metro) => metro.id === selected)?.locations ?? [selected];
    return locations.map((location) => location.split(",")[0].trim().toLowerCase()).filter(Boolean);
  });
  const exactFilters: [keyof FilterableJob, string[]][] = [
    ["decision", values(filters.decision)],
    ["fit_tier", values(filters.fit)],
    ["confidence", values(filters.confidence)],
    ["sponsorship_tier", values(filters.sponsorship)]
  ];
  return jobs.filter((job) => {
    if (ids && !ids.has(job.job_id)) return false;
    if (dates.length && !dates.includes(job.found_date)) return false;
    if (query && !job.title.toLowerCase().includes(query) && !job.company.toLowerCase().includes(query)) return false;
    // analyses.decision is NOT NULL; the list endpoint's LEFT JOIN produces
    // null only when there is no saved analysis. Status alone is not evidence.
    const analyzed = job.decision != null;
    if (filters.analyzed === "yes" && !analyzed) return false;
    if (filters.analyzed === "no" && analyzed) return false;
    if (statuses.length && !statuses.includes(job.status)
      && !(statuses.includes("__blank__") && !manualStatuses.has(job.status))) return false;
    if (lanes.length && !lanes.includes(job.lane ?? "") && !lanes.includes(job.lane_hint ?? "")) return false;
    if (locations.length && !locations.some((location) => job.location.toLowerCase().includes(location))) return false;
    return exactFilters.every(([field, selected]) => !selected.length || selected.includes(job[field] ?? ""));
  });
}

// All refresh paths share this loader. Late responses (including failures)
// from older requests cannot replace a newer snapshot or report stale errors.
export type LoadStatus = "loading" | "ready" | "error";

export function createLatestLoader<T>(
  request: () => Promise<T>,
  commit: (value: T) => void,
  onStatus: (status: LoadStatus) => void = () => undefined
) {
  let revision = 0;
  return {
    invalidate: () => { revision += 1; },
    load: async () => {
      const current = ++revision;
      onStatus("loading");
      try {
        const value = await request();
        if (current === revision) {
          commit(value);
          onStatus("ready");
        }
      } catch (error) {
        if (current === revision) {
          onStatus("error");
          throw error;
        }
      }
    }
  };
}
