import { TEMPLATES, TEMPLATE_CATEGORIES, type Template } from "../lib/templates";

export const GALLERY_DESC =
  "Ready-made recipes for everyday spreadsheet chores — total by category, top N, monthly totals, VLOOKUP-style merges, find duplicates, reconcile two lists. Pick one, drop your file, get results. Runs in your browser.";

/** Public, browsable template gallery (route: /templates). */
export function GalleryPage({ onOpen, onHome }: { onOpen: (t: Template) => void; onHome: () => void }) {
  return (
    <section className="gallery-page">
      <div className="apply-head">
        <div>
          <div className="apply-eyebrow">Templates<span className="apply-privacy">· runs in your browser</span></div>
          <h1 className="apply-title">Ready-made recipes for everyday spreadsheet chores</h1>
          <p className="apply-desc">
            Pick one, drop your file, and get results in seconds — then tweak, save, or share it. No formulas, no
            analyst. Your data never leaves your browser.
          </p>
        </div>
        <button className="btn ghost" onClick={onHome}>Home</button>
      </div>

      {TEMPLATE_CATEGORIES.map((cat) => {
        const items = TEMPLATES.filter((t) => t.category === cat);
        if (!items.length) return null;
        return (
          <div className="gallery-cat" key={cat}>
            <h2 className="apply-section-title">{cat}</h2>
            <div className="template-grid">
              {items.map((t) => (
                <button className="template-card" key={t.slug} onClick={() => onOpen(t)}>
                  <span className="template-icon" aria-hidden="true">{t.icon}</span>
                  <span className="template-body">
                    <span className="template-name">{t.name}</span>
                    <span className="template-desc">{t.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}
