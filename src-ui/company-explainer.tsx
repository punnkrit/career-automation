import { useState } from "react";

type Source = { url: string; title: string; publisher: string };
export type CompanyExplainerData = {
  plain_english: string;
  source_urls: string[];
  products: Array<{ name: string; does: string; user: string; example: string; source_urls: string[] }>;
  workflow: { title: string; steps: Array<{ label: string; detail: string; provider: string }>; caption: string; source_urls: string[] };
  customer_examples: Array<{ customer: string; problem: string; product: string; workflow: string; outcome: string; caveat: string; evidence_type: string; source_urls: string[] }>;
  media: Array<{ kind: "image" | "demo"; url: string; source_url: string; caption: string; alt: string; as_of: string }>;
};

export const EVIDENCE_LABELS: Record<string, string> = {
  company_reported: "Company-reported",
  independently_supported: "Independently supported",
  analysis: "Analysis",
  unknown: "Unknown",
  verified: "Source-supported",
  likely: "Likely",
};

function publicHttps(value: string): string | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || !host.includes(".") ||
      host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
      /^[\d.]+$/.test(host) || host.includes(":")) return undefined;
    return url.href;
  } catch { return undefined; }
}

function Sources({ urls, sources }: { urls: string[]; sources: Source[] }) {
  return <div className="finding-sources">{Array.from(new Set(urls)).filter(url => publicHttps(url)).map(url => {
    const source = sources.find(item => item.url === url);
    return <a key={url} href={url} target="_blank" rel="noreferrer">{source?.title || source?.publisher || "Source"}</a>;
  })}</div>;
}

function ResearchMedia({ media }: { media: CompanyExplainerData["media"][number] }) {
  const [failed, setFailed] = useState(false);
  const url = publicHttps(media.url);
  const source = publicHttps(media.source_url);
  if (!url || !source || !media.caption || (media.kind === "image" && !media.alt)) return null;
  return <figure className="company-product-figure">
    {media.kind === "image" && !failed ? (
      <a href={source} target="_blank" rel="noreferrer" aria-label="View image source">
        <img src={url} alt={media.alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      </a>
    ) : <a className="company-demo-link" href={media.kind === "demo" ? url : source} target="_blank" rel="noreferrer">{failed ? "Image unavailable — view the original source" : "Explore the official demo"} ↗</a>}
    <figcaption>{media.caption}<span><a href={source} target="_blank" rel="noreferrer">Source</a>{media.as_of && ` · Viewed ${media.as_of}`}</span></figcaption>
  </figure>;
}

export function CompanyExplainer({ data, sources }: { data: CompanyExplainerData; sources: Source[] }) {
  return <div className="company-explainer">
    {!!data.products?.length && <section aria-label="Products explained">
      <h4>What customers actually use</h4>
      <div className="company-product-guide">{data.products.map((product, index) => <article key={`${product.name}-${index}`}>
        <h5>{product.name}</h5>
        <div><p>{product.does}</p><p className="company-example"><strong>For example:</strong> {product.example}</p><p className="company-product-user"><strong>Used by:</strong> {product.user}</p><Sources urls={product.source_urls} sources={sources} /></div>
      </article>)}</div>
    </section>}
    {!!data.workflow?.steps?.length && <section aria-label="Illustrative workflow">
      <h4>{data.workflow.title || "How it works in practice"}</h4>
      <figure className="company-workflow">
        <ol>{data.workflow.steps.map((step, index) => <li key={`${step.label}-${index}`}><span className="company-step-number" aria-hidden="true">{index + 1}</span><div><h5>{step.label.replace(/^\s*\d+[.)]\s*/, "")}</h5><span className="company-step-provider">{step.provider}</span><p>{step.detail}</p></div></li>)}</ol>
        <figcaption>{!/^illustrative\b/i.test(data.workflow.caption) && <strong>Illustrative workflow. </strong>}{data.workflow.caption}</figcaption>
        <Sources urls={data.workflow.source_urls} sources={sources} />
      </figure>
    </section>}
    {data.media?.map(media => <ResearchMedia key={media.url} media={media} />)}
    {!!data.customer_examples?.length && <section aria-label="Customer examples">
      <h4>How customers put it to work</h4>
      {data.customer_examples.map((example, index) => <article className="company-customer-example" key={`${example.customer}-${index}`}>
        <h5>{example.customer}</h5><span className="company-example-attribution">{EVIDENCE_LABELS[example.evidence_type] || "Source-supported"}</span>
        <dl>{[["The problem", example.problem], ["Product used", example.product], ["In practice", example.workflow], ["Reported outcome", example.outcome], ["What this does not establish", example.caveat]].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <Sources urls={example.source_urls} sources={sources} />
      </article>)}
    </section>}
  </div>;
}
