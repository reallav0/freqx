# Desktop account boundary

Server authentication now lives in the separate freqx-api repository. This project
keeps account.js and runtime/auth-client.cjs: login UI, narrow IPC, system-browser
OAuth return, HTTPS calls and OS-backed safeStorage refresh persistence. Passwords
are sent only over the configured trusted API transport; refresh tokens stay out
of renderer storage. Access tokens stay in main-process memory. Packaged builds
cannot select arbitrary API origins through renderer input or development env.

Desktop auth tests use HTTP/provider fixtures; they do not require PostgreSQL or
a sibling backend checkout. Production backend secrets must never enter this
repository, packaging resources or workflow environment. See the separate backend
authentication documentation for session hashing/rotation and authorization.
