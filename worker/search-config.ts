export type SearchLane = {
  id: string;
  label: string;
  priority: number;
  target_titles: string[];
  queries: string[];
  positioning: string;
};

export type SearchMetro = {
  id: string;
  label: string;
  description: string;
  search_locations: string[];
  edge_locations: string[];
  locations: string[];
};

export const LANES: SearchLane[] = [
  {
    id: "ai_solutions",
    label: "AI Solutions / AI Implementation",
    priority: 1,
    target_titles: ["AI Solutions Consultant", "AI Implementation Manager", "Forward Deployed Engineer", "Enterprise AI Consultant", "AI Workflow Automation Lead", "Solutions Product Manager"],
    queries: ["AI Solutions Consultant", "AI Implementation Manager", "Enterprise AI Consultant", "AI Workflow Automation Lead", "Forward Deployed Engineer"],
    positioning: "Translate messy business workflows, documents, and operational decisions into usable AI-enabled systems.",
  },
  {
    id: "product_ops",
    label: "Product Operations / Product Strategy / Product Analytics",
    priority: 2,
    target_titles: ["Product Operations Manager", "Product Strategy Manager", "Product Analyst", "Product Analytics Manager", "Strategy & Operations Manager Product"],
    queries: ["Product Operations Manager", "Product Strategy Manager", "Product Analytics Manager", "Strategy Operations Product"],
    positioning: "Improve product execution and product quality using analytics, workflow design, and measurable decision systems.",
  },
  {
    id: "bizops",
    label: "Strategy & Operations / BizOps",
    priority: 3,
    target_titles: ["Strategy & Operations Manager", "Business Operations Manager", "BizOps Manager", "GTM Strategy Manager", "Growth Strategy Manager"],
    queries: ["Strategy Operations Manager", "Business Operations Manager Tech", "BizOps Manager", "GTM Strategy Manager AI"],
    positioning: "Use analytics, operating models, and structured problem solving to improve business decisions and execution.",
  },
  {
    id: "tpm_epm",
    label: "TPM / EPM / AI Program Manager",
    priority: 4,
    target_titles: ["Technical Program Manager AI", "Technical Program Manager Data", "Engineering Program Manager", "Program Manager AI Operations", "Search Program Manager"],
    queries: ["Technical Program Manager AI", "Technical Program Manager Data", "Program Manager AI Operations", "Engineering Program Manager Data"],
    positioning: "Coordinate analytical and product-quality execution across ambiguous technical and business systems.",
  },
  {
    id: "ai_product",
    label: "AI Product Manager / Product Manager",
    priority: 5,
    target_titles: ["Product Manager AI", "Product Manager Internal Tools", "Product Manager Search", "Product Manager Data Products", "Product Manager Workflow Automation"],
    queries: ["Product Manager AI", "Product Manager Internal Tools", "Product Manager Data Products", "Product Manager Workflow Automation"],
    positioning: "Bring product sense, analytics, and AI workflow understanding to products that improve decisions and workflows.",
  },
  {
    id: "pmm_gtm_ai",
    label: "PMM / GTM AI",
    priority: 6,
    target_titles: ["Product Marketing Manager AI", "GTM Strategy Manager AI", "Solutions Marketing Manager", "AI Commercialization Manager"],
    queries: ["Product Marketing Manager AI", "GTM Strategy Manager AI", "Solutions Marketing Manager AI"],
    positioning: "Translate AI product capabilities into clear customer, business, and adoption value.",
  },
];

export const METROS: SearchMetro[] = [
  {
    id: "bay_area",
    label: "The Bay Area",
    description: "Core San Francisco Bay Area hiring markets, searched from San Francisco with pagination.",
    search_locations: ["San Francisco, California, United States"],
    edge_locations: ["San Jose, California, United States", "Oakland, California, United States"],
    locations: ["San Francisco, California, United States", "San Jose, California, United States", "Oakland, California, United States", "Palo Alto, California, United States", "Mountain View, California, United States", "Sunnyvale, California, United States", "Santa Clara, California, United States", "Cupertino, California, United States", "Menlo Park, California, United States", "Redwood City, California, United States", "San Mateo, California, United States", "South San Francisco, California, United States", "Fremont, California, United States", "Berkeley, California, United States", "Emeryville, California, United States"],
  },
  {
    id: "greater_la",
    label: "Greater LA Metro Area",
    description: "Los Angeles, Orange County, and nearby tech/media hiring centers.",
    search_locations: ["Los Angeles, California, United States"],
    edge_locations: ["Irvine, California, United States", "Long Beach, California, United States"],
    locations: ["Los Angeles, California, United States", "Santa Monica, California, United States", "Culver City, California, United States", "Beverly Hills, California, United States", "Pasadena, California, United States", "Glendale, California, United States", "Burbank, California, United States", "Long Beach, California, United States", "El Segundo, California, United States", "Irvine, California, United States", "Anaheim, California, United States", "Costa Mesa, California, United States"],
  },
  {
    id: "seattle_tacoma",
    label: "Seattle-Tacoma",
    description: "Seattle, Eastside, and South Sound hiring markets, searched from Seattle with pagination.",
    search_locations: ["Seattle, Washington, United States"],
    edge_locations: ["Tacoma, Washington, United States", "Everett, Washington, United States"],
    locations: ["Seattle, Washington, United States", "Bellevue, Washington, United States", "Redmond, Washington, United States", "Kirkland, Washington, United States", "Renton, Washington, United States", "Tacoma, Washington, United States", "Bothell, Washington, United States", "Everett, Washington, United States"],
  },
  {
    id: "boston",
    label: "Boston",
    description: "Boston and close Cambridge-area technology and business hubs.",
    search_locations: ["Boston, Massachusetts, United States"],
    edge_locations: ["Cambridge, Massachusetts, United States", "Waltham, Massachusetts, United States"],
    locations: ["Boston, Massachusetts, United States", "Cambridge, Massachusetts, United States", "Somerville, Massachusetts, United States", "Brookline, Massachusetts, United States", "Waltham, Massachusetts, United States", "Newton, Massachusetts, United States", "Burlington, Massachusetts, United States"],
  },
  {
    id: "nyc",
    label: "New York City",
    description: "NYC plus close New Jersey commuter-market cities.",
    search_locations: ["New York, New York, United States"],
    edge_locations: ["Jersey City, New Jersey, United States", "Newark, New Jersey, United States"],
    locations: ["New York, New York, United States", "Brooklyn, New York, United States", "Queens, New York, United States", "Jersey City, New Jersey, United States", "Hoboken, New Jersey, United States", "Newark, New Jersey, United States", "Weehawken, New Jersey, United States", "Long Island City, New York, United States"],
  },
  {
    id: "chicago",
    label: "Chicago",
    description: "Chicago and nearby inner-suburb business centers.",
    search_locations: ["Chicago, Illinois, United States"],
    edge_locations: ["Naperville, Illinois, United States", "Schaumburg, Illinois, United States"],
    locations: ["Chicago, Illinois, United States", "Evanston, Illinois, United States", "Oak Brook, Illinois, United States", "Schaumburg, Illinois, United States", "Naperville, Illinois, United States"],
  },
  {
    id: "denver",
    label: "Denver",
    description: "Denver, Boulder, and nearby Front Range hiring markets.",
    search_locations: ["Denver, Colorado, United States"],
    edge_locations: ["Boulder, Colorado, United States", "Aurora, Colorado, United States"],
    locations: ["Denver, Colorado, United States", "Boulder, Colorado, United States", "Broomfield, Colorado, United States", "Westminster, Colorado, United States", "Aurora, Colorado, United States", "Englewood, Colorado, United States"],
  },
];

export const searchOptions = {
  lanes: LANES,
  metros: METROS,
  serpapi: {
    engine: "google_jobs",
    location_guidance: "Normal searches use one city-level origin per metro, then paginate. Optional edge checks add one rotating outer-metro origin.",
    fixed_params: { google_domain: "google.com", gl: "us", hl: "en" },
    results_per_page: 10,
    max_pages: 3,
    page3_min_new_opportunities: 3,
  },
};
