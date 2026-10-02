# @maplezzk/pi-test-utils

Private deterministic fixtures for this monorepo's tests.

It currently provides:

- temporary directory and `PI_CODING_AGENT_DIR` isolation;
- an extension-registration harness that records ownership of commands, tools, shortcuts, flags, entry renderers, message renderers, and event handlers;
- immediate collision detection for composed extension smoke tests.

The package is `private: true`, is never published, and must not appear in the root Pi distribution profile.
