# Separate CI and deployment

Desktop CI installs only the root Electron package, runs lint and desktop tests,
checks packaging/startup/media behavior and retains existing dependency/secret/SAST
checks. Dependabot covers desktop npm and GitHub Actions. The release workflow
runs this desktop CI, bumps the desktop patch version and publishes Windows assets.

The separate freqx-api repository owns database integration tests, Docker/media
build verification, container checks, backend dependency checks and Heroku release
migrations. This checkout has no server install, database runtime or Heroku job.
No production provider credentials are necessary for either PR test pipeline.
