/**
 * Canonicalize a pasted job link to the posting it actually means.
 *
 * People paste whatever their address bar holds, and on job boards that is
 * usually a SEARCH page with the selected job riding along as a query param —
 * seen live on 2026-08-28 with `linkedin.com/jobs/search-results/
 * ?currentJobId=…`, which the queue then opened as a search page and correctly
 * refused to fill. The job id in the URL names the real posting; go there.
 *
 * Unknown URLs pass through untouched — this must never break a link it does
 * not understand.
 */

/** The canonical form of `raw`, or `raw` unchanged when no rule applies. */
export function canonicalizeJobUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  // LinkedIn: any /jobs/… page with a currentJobId names one posting.
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
    const id = url.searchParams.get("currentJobId");
    if (id !== null && /^\d+$/.test(id)) {
      return `https://www.linkedin.com/jobs/view/${id}/`;
    }
    return raw;
  }

  // SEEK: strip tracking params from a job page so dedupe sees one URL.
  if (host === "seek.com.au" || host.endsWith(".seek.com.au") || host.endsWith(".seek.com")) {
    const match = /^\/job\/(\d+)/.exec(url.pathname);
    if (match !== null) {
      return `${url.origin}/job/${match[1]}`;
    }
    return raw;
  }

  return raw;
}
