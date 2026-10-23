# Docs

Project documentation: where each kind of document lives and how files are named.

## Framework: Diátaxis, adapted to code

The layout follows [Diátaxis](https://diataxis.fr). Diátaxis sorts documentation by the reader's need into four kinds. Each kind has its own place, and a document does one kind of job only. The adaptation adds a fifth group, **records**, for the history that a code base produces.

| Reader's need                       | Diátaxis kind  | Where it lives here                                                   | Lifetime                           |
|-------------------------------------|----------------|-----------------------------------------------------------------------|------------------------------------|
| "I want to learn"                   | Tutorial       | `how-to/` (a first-run walkthrough, e.g. local setup)                 | Living                             |
| "I need to do X"                    | How-to guide   | `how-to/` for development tasks, `runbooks/` for operating production | Living                             |
| "I need a fact"                     | Reference      | `reference/` (configuration, routes, contracts, feature behaviour)    | Living                             |
| "I want to understand why"          | Explanation    | `adr/` for decisions, `reference/<feature>/` for how a feature works  | ADRs append-only; reference living |
| "What did we intend, do, and find?" | Record (added) | `specs/`, `plans/`, `incidents/` etc                                  | Frozen, dated                      |

```
docs/
├── README.md                    # Index: what lives where (table of contents)
│
├── adr/                         # WHY — the one thing code can never express. Architecture Decision Records (ADRs) — append-only, numbered.
│   ├── 0001-YYYY-MM-DD-lorem-dolor.md
│   └── 0002-YYYY-MM-DD-sit-amet-ipsum.md
│
├── specs/                       # Intent before the code existed
│   ├── YYYY-MM-DD-lorem-ipsum.md
│   └── YYYY-MM-DD-dolor-sit-amet.md
│
├── plans/                       # How we intended to get there. PRs can review /specs -> /plans -> {code}. 
│   ├── YYYY-MM-DD-lorem-ipsum.md
│   └── YYYY-MM-DD-dolor-sit-amet.md
│
├── local/                       # Local-only content, gitignored (see docs/.gitignore)
│
├── reference/                   # Information-oriented: look things up
│   ├── architecture.md          # high-level design, data flow, diagrams
│   ├── configuration.md         # every env var / flag, exhaustive
│   ├── configuration.repo-b.md  # tracked fork/project overlay — deltas only (see Conventions)
│   ├── configuration.local.md   # .gitignored machine-local overrides, never committed
│   ├── routing.md               # endpoints, schemas, error codes
│   ├── feature-name/            # How does feature-name work? What are the edge cases?
│   │   ├── lorem-ipsum.md
│   │   └── lorem-ipsum-dolor.md
│   └── feature-group/           # How does feature-group work?
│       └── feature-name/        # How does feature-name work? What are the edge cases?
│           ├── lorem-ipsum.md
│           └── lorem-ipsum-dolor.md
│
├── incidents/                   # Postmortems, RCA, and other incident reports
│   ├── YYYY-MM-DD-lorem-ipsum.md
│   └── YYYY-MM-DD-incident-name/
│       ├── YYYY-MM-DD-lorem-ipsum.md
│       └── YYYY-MM-DD-lorem-ipsum-dolor.md
│
├── how-to/                      # Task-oriented: "I need to accomplish X"
│   ├── add-a-migration.md
│   └── deploy-to-staging.md
│
└── runbooks/                    # Scripts, runbooks, and other Operational docs
    ├── restore-database.md
    ├── rotate-credentials.md
    └── dolor-ipsum/
        ├── dolor-ipsum.sql
        └── lorem-ipsum.sh
```

## Conventions

- **Flat until a second document, then fold into `topic-name/`.** This applies
  inside every directory here: start with a single flat file
  (`specs/YYYY-MM-DD-feature.md`); the moment a topic gains a second related
  document, move both into a subdirectory named after the topic
  (`specs/feature-name/`). Never create the folder before the second file
  exists.
- **Dates are ISO 8601: `YYYY-MM-DD`, zero-padded, as a filename prefix.**
  `2026-07-15-kingdom-merge.md`, never `15-07-2026`, `20260715`, or
  `2026_7_15`. A date prefix marks the file as a *record* (frozen, never
  edited); living docs (reference, how-to) carry no date. Records sort
  chronologically by name for free.
- **kebab-case for all file and folder names.** Dashes, not underscores,
  camelCase, or spaces: `lorem-ipsum-dolor/`,
  `lorem-ipsum-dolor.sql` — not `lorem_ipsum_dolor/` or `LoremIpsumDolor.sql`.
  One glue character everywhere means greppable, clickable, shell-safe names
  with no "was it `_` or `-` here?" guessing.
- **Local-only content stays local: `*.local`, `*.local.*`, and `local/`.**
  Anything named `name.local` / `name.local.ext`, or placed inside a `local/`
  directory at any depth, is gitignored (see [.gitignore](.gitignore)). Use it
  for machine-specific overrides (`configuration.local.md`), personal scratch
  notes, and anything that must never be committed. A tracked doc may point to
  its `.local` counterpart, but never quote content from it — the repo must
  stay coherent for readers who don't have the local files.
- **Fork / multi-repo overlays: `filename.<project-name>.md`.** The bare file
  (`configuration.md`) is owned by upstream and comes down on every fork sync;
  a fork or sibling project documents its deltas in a tracked overlay next to
  it (`configuration.repo-b.md`) and **never edits the upstream file** —
  ownership is exclusive per path, so syncs cannot conflict by construction.
  Upstream in turn never creates `*.<project-name>.*` files. Overlays hold
  only deltas and link to the base doc rather than copying it. Reading
  cascade: `configuration.md` → `configuration.<project-name>.md` →
  `configuration.local.md`. Project names are kebab-case; `local` is reserved
  (it means gitignored, per the rule above). For numbered records, forks
  prefix their own: `repo-b-0001-YYYY-MM-DD-slug.md`, keeping "ADR-0007"
  citations unambiguous across the family of repos.
