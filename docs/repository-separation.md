# Desktop/backend separation

The Electron desktop remains in `C:\Users\Nguyen\Desktop\soundmuncher`, with its
existing Git history and `feat/heroku-deployment` branch. The standalone API is
`C:\Users\Nguyen\Desktop\freqxback`; its intended GitHub repository is
`reallav0/freqx-api`. No remote repository, push or hosted deployment was performed.

Moved server source, authentication, migrations, backend tests, local PostgreSQL
data, private environment configuration, media tools, website, load tests and
Heroku deployment into the API project. Its root package has no Electron dependency.
Small catalog compatibility modules and audio test fixtures were copied so neither
project needs a sibling checkout for its ordinary tests/builds.

Desktop account UI, secure token storage, API client and updater remain in Electron.
Desktop CI/releases no longer install the server or start PostgreSQL; backend CI
does not build desktop installers. The original full Electron/PostgreSQL account
integration test is retained in the API project as an optional cross-project test.

Verification after separation:

- 51 desktop unit tests and 56 backend/website tests passed.
- Lint passed in both projects; workflow YAML and package-lock metadata validated.
- Real Electron account UI/OS-encrypted storage tests passed with a local API fixture.
- The preserved full Electron/PostgreSQL login integration passed.
- Desktop packaging, actual packaged startup and packaged Discover checks passed.
- Real backend entrypoint health/readiness/catalog HTTP smoke passed after importing
  all 1,390 legacy records through the relocated release command.

Linux Docker CI, actual Heroku deployment and live provider flows still require
hosted verification. Original source snapshots are preserved privately under
`freqxback/.local/pre-split-source`, excluded from Git.

Create/push the new backend repository and connect Heroku to it. If using the old
Heroku template, update `DATABASE_SSL_CA_FILE` to
`/app/certs/aws-rds-global-bundle.pem`. Read each project's root `instruction.md`
for its separate setup and deployment steps.
