import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";

// Keep in sync with the workspace breakpoint in styles.css.
export function useCompactLayout() {
  const [compact, setCompact] = useState(() => window.matchMedia("(max-width: 1100px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1100px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}

/** One content tree: a normal desktop panel, or a native full-screen dialog.
 * The native dialog makes the background inert and contains keyboard focus.
 * Keeping the list mounted preserves its filters, pagination and scroll position.
 */
export function JobDetailSurface({ compact, open, selectedId, onBack, children, label = "Job details" }: {
  label?: string;
  compact: boolean;
  open: boolean;
  selectedId: string | null;
  onBack: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const hasSelection = Boolean(selectedId);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    if (!open || (compact && !hasSelection)) return;
    if (compact) dialog.showModal();
    else dialog.show();
    // Fix the page in place on phones, retaining the list scroll on return.
    const y = window.scrollY;
    const previous = { position: document.body.style.position, top: document.body.style.top, width: document.body.style.width };
    if (compact) {
      document.body.style.position = "fixed";
      document.body.style.top = `-${y}px`;
      document.body.style.width = "100%";
    }
    return () => {
      dialog.close();
      if (compact) {
        Object.assign(document.body.style, previous);
        window.scrollTo(0, y);
      }
    };
  }, [compact, open, hasSelection]);
  useEffect(() => { ref.current?.scrollTo(0, 0); }, [selectedId]);
  return (
    <dialog ref={ref} className="job-detail-surface" aria-label={label} onCancel={(event) => { event.preventDefault(); onBack(); }}>
      <div className="mobile-detail-header">
        <button type="button" onClick={onBack}><ArrowLeft size={18} /> Back to list</button>
        <span>{label}</span>
      </div>
      {children}
    </dialog>
  );
}
