# FreqX desktop: setup after backend separation

The desktop project is C:\Users\Nguyen\Desktop\soundmuncher, GitHub reallav0/freqx.
The backend project is C:\Users\Nguyen\Desktop\freqxback, intended GitHub reallav0/freqx-api.

## What stays here

Electron, Web Audio, boards, local favorites, Discover, editor, account/login UI,
secure main-process token storage, API client and updater. Server login logic,
PostgreSQL, OAuth/provider secrets, R2 write credentials, website and Heroku files
live in freqxback. Login controls stay in the desktop because users need them to
authenticate against that server. Both projects install and deploy independently.

## Local development

Start the backend in one PowerShell terminal:

```powershell
Set-Location 'C:\Users\Nguyen\Desktop\freqxback'
npm ci
npm run db:local
npm run migrate
npm run import:catalog
npm run dev
```

Start the desktop in another:

```powershell
Set-Location 'C:\Users\Nguyen\Desktop\soundmuncher'
npm ci
$env:FREQX_API_BASE_URL = 'http://127.0.0.1:3000'
npm run dev
```

For local verification, use the ignored mail/SMS captures under freqxback/.local.
No backend credentials or .env file need to be added here. For full backend/provider
setup, follow **C:\Users\Nguyen\Desktop\freqxback\instruction.md**.

## Production desktop

runtime/platform.json already uses https://api.freqx.app. Clear the development
override to test this address from a development build:

```powershell
Remove-Item Env:FREQX_API_BASE_URL -ErrorAction SilentlyContinue
npm run dev
```

Packaged builds always use the trusted production configuration. Never put backend
secrets into Electron, renderer storage or package resources. Anonymous/offline
boards and the legacy catalog fallback remain available if the API is down.

## Push the desktop changes

The existing Git history/branch remain here. Review git status and the moved-file
deletions, commit the intended restructuring/audio changes, then push the existing
feat/heroku-deployment branch and open a PR into main. Website files were moved
to the backend project and preserved in its ignored original-source backup.

The new freqx-api repository must be created/pushed separately. Connect **that**
repository to Heroku. Backend commits do not create Windows releases or bump the
desktop version. Do not connect this desktop repository to Heroku after the split.

## Verify and release the desktop

```powershell
npm run lint
npm run test:unit
npm run pack
# Installer build, when ready:
npm run dist
```

GitHub desktop CI no longer installs a server or starts PostgreSQL. Existing desktop
checks remain. Enable Actions permissions and review protected-main/tag permissions
for the version bot. Only desktop production changes merged to main trigger the
desktop patch/release workflow. See [release details](docs/implementation/releases.md).

Keep public Release assets available in reallav0/freqx for the current updater.
Install the Setup executable to test OAuth protocol return and updates; dev and
portable builds update manually. An actual update transition needs two published
installed versions. Installers are currently unsigned; signing is a future setup
task, not something already enabled. Bundled driver installation remains blocked
until reviewed signature/hash pins are present; an official driver can be installed
separately. See [driver policy](security/driver-verification.md).

## Backend deployment and providers

Use freqxback/instruction.md for Heroku Basic + Essential-0 PostgreSQL, api.freqx.app
DNS/HTTPS, required SMTP, Discord/Google callbacks, private R2 and optional paid SMS.
The backend template now uses /app/certs/aws-rds-global-bundle.pem, not the old
/app/server/certs path. Change that Heroku Config Var if you entered the old value.
Neither project has been pushed or deployed by moving its files.
