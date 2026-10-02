# FreqX after repository separation

Desktop: this Electron/JavaScript project (soundmuncher, GitHub reallav0/freqx).
Backend: sibling freqxback project (GitHub reallav0/freqx-api), Express/JavaScript,
PostgreSQL, Cloudflare R2, deployed to Heroku as freqx at https://api.freqx.app.

```text
Electron renderer: boards / Discover / editor / account UI / Web Audio
  | restricted preload IPC
Electron main: API client / OS-encrypted refresh storage / direct audio transfers
  | HTTPS (production: api.freqx.app; development: loopback override)
Separate Express API: owned auth / OAuth / profiles / sounds / uploads / favorites
  +-- PostgreSQL: identities / rotating sessions / metadata / durable media jobs
  +-- R2: legacy public catalog / separate private upload bucket

Desktop GitHub CI --> Windows Release --> installed Electron updater
Backend GitHub CI --> Heroku container deployment
```

Keeping login UI and API clients in the desktop is required for login to work.
No backend signing, SMTP, SMS, OAuth or R2 write secret belongs in this project.
The root package/scripts/CI do not install PostgreSQL or the server package.
Runtime catalog helpers remain here for offline/legacy Discover and are copied
independently into the backend for legacy catalog import. Their identifier/API
contract must stay compatible; neither project requires the other's checkout.

The original audits, platform records, website and measured performance reports
were moved to freqxback. Archived original source is preserved privately in its
ignored .local/pre-split-source folder. No Git remote or deployment was created
by this separation. Current server setup is in freqxback/instruction.md.
