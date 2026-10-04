# Responsive workspace

The job views (Today, Days, Jobs, Packets) share one detail destination and one JobInspector. Networking uses the same responsive surface for company details.

- At widths up to 1100 CSS pixels, lists use cards and selected details open in a full-screen native dialog. The background is inert and the browser contains keyboard focus. The page is fixed at its current scroll position until the detail view closes.
- Above 1100px, details appear in the normal desktop grid, with the existing resize handle. Table overflow stays within the table container.
- Job and company selection is reflected in `job` / `company` URL parameters. Opening the first detail adds a history entry; switching the selected item replaces that detail entry. Back returns to the mounted list. A direct link closes back to its list without navigating off-site.
- One detail content tree survives viewport changes so an unsaved edit survives a resize. Async detail loads use the existing revision guard so older responses cannot replace a newer selection.
- CSS lives in `responsive.css`; keep its 1100px breakpoint aligned with `useCompactLayout` in `job-detail-surface.tsx` and the existing compact rules in `styles.css`.

## Regression checks

Run `npm run build` and `node --test tests/job-list.test.mjs tests/job-status.test.mjs` with the supported Node runtime.

In a browser, check 320, 390, 768, 1100, 1101 and 1440px widths:

1. Open a job from Today, Days, Jobs and Packets. On narrow screens, details must appear immediately at the top of the viewport. On wide screens, use the side panel.
2. Use Back, Forward, and refresh. Refresh must reopen the selected job. A direct link must allow returning to the list. A nonexistent job must show a recoverable error.
3. Open a job from page two and from a filtered list. Return and confirm pagination, filters, focus and scroll are preserved.
4. Expand filters at 320px. Open a filter in either column and confirm the menu stays within the viewport.
5. Read a long description: narrow details should have one main scroll area, with Back remaining visible.
6. Begin editing a job and resize between narrow and wide layouts. The draft must remain. Test saves/status updates only against disposable test data.
7. Collapse desktop details, then select a row; the panel must reopen. Check keyboard activation of job titles and Escape on mobile details.
8. Open a company from Networking and return with Back. Verify company cards, controls and detail content fit.

The original application's local fixture checks on 2026-09-18 covered the above job navigation, error, filter, edit, status and viewport flows. This is inherited baseline evidence; see [VALIDATION.md](VALIDATION.md) for checks performed on this starter. Browser viewport checks do not substitute for a physical Safari/iOS or Android device check.
