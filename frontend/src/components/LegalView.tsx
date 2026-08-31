import { marked } from "marked";
import termsMd from "../content/legal/terms-of-use.md?raw";
import privacyMd from "../content/legal/privacy-policy.md?raw";

// The legal docs are trusted, first-party content (authored in the repo), so
// rendering the converted markdown as HTML is safe. Parsed once at module load.
const HTML: Record<"terms" | "privacy", string> = {
  terms: marked.parse(termsMd, { async: false }) as string,
  privacy: marked.parse(privacyMd, { async: false }) as string,
};

export function LegalView({ doc, onHome }: { doc: "terms" | "privacy"; onHome: () => void }) {
  return (
    <section className="legal">
      <button className="linklike legal-back" onClick={onHome}>← Back to Abracadata</button>
      <article className="legal-body" dangerouslySetInnerHTML={{ __html: HTML[doc] }} />
    </section>
  );
}
