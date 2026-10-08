# @maplezzk/pi-test-utils

Private deterministic fixtures for this monorepo's tests.

It currently provides:

- temporary directory and `PI_CODING_AGENT_DIR` isolation;
- an extension-registration harness that records ownership of commands, tools, shortcuts, flags, entry renderers, message renderers, and event handlers;
- immediate collision detection for composed extension smoke tests;
- `@maplezzk/pi-test-utils/rpiv`: adapted Pi/UI/session/manifest fixtures for the
  advisor, todo and questionnaire imports. This test-only surface has no workflow
  dependency; upstream MIT attribution is retained in `RPIV-LICENSE`.

The package is `private: true`, is never published, and must not appear in the root Pi distribution profile.
