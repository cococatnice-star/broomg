---
name: Imported runtime settings
description: Replit-managed runtime metadata can differ from the imported repository after registering an artifact.
---

When an imported React/Vite project is registered as an artifact, Replit may add a Python base module to `.replit`, even if the upstream repository only lists Node.js. Attempting to restore the source `.replit` through validation may appear successful, but the managed module can be reintroduced during dependency setup.

**Why:** In the imported profile project, artifact registration and package setup re-added the runtime module after a validated restore.

**How to apply:** Verify the app source and assets against the repository, but distinguish those from platform-managed runtime metadata. Avoid repeatedly stripping a runtime setting that Replit restores.
