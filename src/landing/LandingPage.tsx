import {
  ArrowRight,
  BookOpen,
  Check,
  Code2,
  Download,
  FileText,
  Image as ImageIcon,
  Layers3,
  LockKeyhole,
  MousePointer2,
  PenLine,
  Sparkles,
} from "lucide-react";
import "./landing.css";

const repositoryUrl = "https://github.com/arturict/canvink";
const releaseUrl = `${repositoryUrl}/releases/latest`;

const alphaFeatures = [
  "Notebook, section, page, and subpage hierarchy",
  "Free canvas and printable A4 page modes",
  "Pressure-aware pen and highlighter",
  "Movable text, images, and PDF previews",
  "Local autosave, search, trash, and portable export",
];

export function LandingPage() {
  return (
    <main className="landing-shell">
      <nav className="landing-nav" aria-label="Primary navigation">
        <a className="brand-lockup" href="/" aria-label="Canvink home">
          <span className="brand-mark" aria-hidden="true">
            <PenLine size={19} strokeWidth={2.4} />
          </span>
          <span>Canvink</span>
          <span className="alpha-pill">public alpha</span>
        </a>

        <div className="nav-actions">
          <a href="#principles">Why Canvink</a>
          <a href="#roadmap">Roadmap</a>
          <a
            className="nav-github"
            href={repositoryUrl}
            target="_blank"
            rel="noreferrer"
          >
            <Code2 size={17} />
            GitHub
          </a>
        </div>
      </nav>

      <section className="hero-section">
        <div className="hero-copy">
          <div className="eyebrow">
            <Sparkles size={15} />
            Open source. Local first. Mixed media.
          </div>
          <h1>
            Your notes. Your files.
            <span>Your canvas.</span>
          </h1>
          <p className="hero-lede">
            Canvink is the open notebook where handwriting, movable text, images,
            and PDF previews live together on one page. No required account. No
            cloud lock-in.
          </p>
          <div className="hero-actions">
            <a className="primary-cta" href="/app">
              Try the local web demo
              <ArrowRight size={18} />
            </a>
            <a
              className="secondary-cta"
              href={releaseUrl}
              target="_blank"
              rel="noreferrer"
            >
              <Download size={18} />
              Download latest alpha
            </a>
          </div>
          <p className="demo-note">
            The demo saves only in this browser. Desktop builds use a local
            SQLite notebook file. Current Windows and Linux packages are
            unsigned public-alpha builds.
          </p>
        </div>

        <div className="product-frame" aria-label="Canvink product preview">
          <div className="window-bar">
            <span />
            <span />
            <span />
            <div className="window-title">Field Notes · Research</div>
          </div>
          <div className="product-ui">
            <aside className="mock-rail">
              <div className="mock-logo">
                <PenLine size={14} />
              </div>
              <BookOpen size={17} />
              <MousePointer2 size={17} />
              <Layers3 size={17} />
            </aside>
            <aside className="mock-sidebar">
              <small>NOTEBOOKS</small>
              <div className="mock-notebook active">
                <BookOpen size={14} /> Field Notes
              </div>
              <div className="mock-notebook">
                <BookOpen size={14} /> Projects
              </div>
              <small className="section-label">RESEARCH</small>
              <div className="mock-page active-page">Mixed media study</div>
              <div className="mock-page">Interview notes</div>
              <div className="mock-page nested">↳ Open questions</div>
            </aside>
            <section className="mock-workspace">
              <div className="mock-toolbar">
                <div className="tool-selected">
                  <PenLine size={14} /> Pen
                </div>
                <div>Text</div>
                <div>Image</div>
                <div>PDF</div>
                <span className="toolbar-spacer" />
                <div className="sync-state">
                  <Check size={13} /> Saved locally
                </div>
              </div>
              <div className="mock-canvas">
                <div className="paper-grid" />
                <div className="canvas-title">A better research notebook</div>
                <svg
                  className="ink-stroke ink-one"
                  viewBox="0 0 270 82"
                  role="img"
                  aria-label="A handwritten annotation"
                >
                  <path d="M8 46 C38 5, 64 72, 91 32 S146 18, 161 46 S209 65, 258 16" />
                  <path d="M192 69 C213 62, 234 59, 259 61" />
                </svg>
                <div className="floating-note">
                  <span>CORE IDEA</span>
                  Ink, text, images, and documents should be equal objects, not
                  separate modes.
                </div>
                <div className="pdf-card">
                  <div className="pdf-sheet">
                    <FileText size={24} />
                    <div>
                      <i />
                      <i />
                      <i className="short" />
                    </div>
                  </div>
                  <strong>research-paper.pdf</strong>
                  <small>12 pages · first-page preview</small>
                </div>
                <div className="image-card">
                  <div className="image-placeholder">
                    <ImageIcon size={25} />
                    <span />
                  </div>
                  <small>Reference image</small>
                </div>
                <svg
                  className="ink-stroke ink-arrow"
                  viewBox="0 0 120 70"
                  aria-hidden="true"
                >
                  <path d="M6 8 C35 13, 57 28, 92 53" />
                  <path d="M78 51 L94 55 L91 39" />
                </svg>
              </div>
            </section>
          </div>
        </div>
      </section>

      <section className="proof-strip" aria-label="Product principles">
        <div>
          <LockKeyhole size={18} />
          <span>
            <strong>Local by default</strong>
            Your notebook stays on your device
          </span>
        </div>
        <div>
          <FileText size={18} />
          <span>
            <strong>Documented format</strong>
            SQLite plus portable JSON export
          </span>
        </div>
        <div>
          <Code2 size={18} />
          <span>
            <strong>AGPL-3.0-or-later</strong>
            Inspect, fork, and improve the code
          </span>
        </div>
      </section>

      <section className="principles-section" id="principles">
        <div className="section-heading">
          <span>One page, without artificial boundaries</span>
          <h2>A notebook should not make you choose between writing and drawing.</h2>
          <p>
            Canvink treats every object as part of the same page, while keeping
            the familiar hierarchy that makes large notebooks navigable.
          </p>
        </div>
        <div className="feature-grid">
          <article className="feature-card feature-card-wide">
            <div className="feature-icon ink-icon">
              <PenLine />
            </div>
            <span className="feature-index">01</span>
            <h3>Ink that belongs on the page</h3>
            <p>
              Pressure-aware vector strokes sit directly above text, images, and
              documents. Annotate the object you mean, in the place you mean.
            </p>
            <div className="stroke-sample">
              <svg viewBox="0 0 420 90" aria-hidden="true">
                <path d="M12 57 C52 5, 88 74, 124 34 S190 9, 215 51 S288 78, 326 31 S374 22, 408 51" />
              </svg>
            </div>
          </article>
          <article className="feature-card">
            <div className="feature-icon">
              <Layers3 />
            </div>
            <span className="feature-index">02</span>
            <h3>Free canvas or clean paper</h3>
            <p>
              Choose an open canvas for exploration or an A4 page when printing
              and predictable margins matter.
            </p>
            <div className="mode-preview">
              <div className="mode-infinite">Free</div>
              <div className="mode-paper">A4</div>
            </div>
          </article>
          <article className="feature-card">
            <div className="feature-icon">
              <LockKeyhole />
            </div>
            <span className="feature-index">03</span>
            <h3>Trust starts with local data</h3>
            <p>
              Desktop notebooks are written transactionally to SQLite. Search
              indexes can be rebuilt, and JSON export gives you a portable exit.
            </p>
            <div className="data-path">
              <span>notebook.sqlite</span>
              <ArrowRight size={15} />
              <span>export.json</span>
            </div>
          </article>
        </div>
      </section>

      <section className="alpha-section" id="roadmap">
        <div>
          <span className="section-kicker">v{__CANVINK_VERSION__} public alpha</span>
          <h2>Small enough to test. Honest enough to trust.</h2>
          <p>
            This is an early, local-only release, not a finished OneNote
            replacement. The goal is to validate the mixed-object page and its
            storage model before adding sync.
          </p>
          <a href="/app" className="text-link">
            Open the demo <ArrowRight size={17} />
          </a>
        </div>
        <div className="alpha-list">
          {alphaFeatures.map((feature) => (
            <div key={feature}>
              <Check size={16} />
              {feature}
            </div>
          ))}
          <div className="future-item">
            <span>Next</span>
            Encrypted sync, native attachment storage, OCR, and importers
          </div>
        </div>
      </section>

      <section className="closing-section">
        <div className="closing-mark">
          <PenLine size={34} />
        </div>
        <h2>Bring one real notebook.</h2>
        <p>
          Try the alpha, inspect the source, and tell us where the first five
          minutes break.
        </p>
        <div className="hero-actions closing-actions">
          <a className="primary-cta" href="/app">
            Try Canvink <ArrowRight size={18} />
          </a>
          <a
            className="secondary-cta"
            href={repositoryUrl}
            target="_blank"
            rel="noreferrer"
          >
            <Code2 size={18} />
            View source
          </a>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="brand-lockup">
          <span className="brand-mark">
            <PenLine size={17} />
          </span>
          Canvink
        </div>
        <p>Built in public. No account, telemetry, or cloud required.</p>
        <div>
          <a href={`${repositoryUrl}/blob/main/LICENSE`}>License</a>
          <a href={`${repositoryUrl}/blob/main/ROADMAP.md`}>Roadmap</a>
          <a href={`${repositoryUrl}/issues`}>Feedback</a>
        </div>
      </footer>
    </main>
  );
}
