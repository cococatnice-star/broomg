---
name: Vite dependency cache
description: Handling stale dependency prebundles after importing or updating a pnpm workspace app.
---

After a workspace dependency update, the app-local Vite optimizer cache can keep serving old peer versions even when the lockfile and installed package links are correct. Clear that app's `node_modules/.vite` cache before treating a persistent version mismatch as a source dependency conflict.

**Why:** The imported profile app continued bundling an old React DOM peer version across workflow restarts until its saved Vite prebundle was removed.

**How to apply:** For React version mismatches after an import or lockfile change, inspect the installed package links and Vite cache; clear only the affected app's optimizer cache, then restart its workflow.
