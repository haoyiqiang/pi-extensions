# Third-party notices

This package incorporates and adapts substantial portions of the following MIT-licensed projects.

## pi-web-search

- Source: https://github.com/ttttmr/pi-web-search
- Imported revision: `66e14d30be2fc4b56ef4a0f77efd55cd81f1b5c4`
- Author: ttttmr
- License declared by the upstream npm package: MIT

The LLM web-search transports, stream parsing, citation normalization, URL-context formatting, and model-scoped tool activation derive from this project. The reconstructed MIT notice is included in `PI-WEB-SEARCH-LICENSE`; the upstream revision declares MIT in `package.json` but does not contain a standalone license file.

## @juicesharp/rpiv-web-tools

- Source: https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-web-tools
- Imported revision: `d74b1c99830a565f3df3f37e0a36616d17ffc574`
- Copyright (c) 2026 juicesharp
- License: MIT

The API search providers, generic HTML fetch helpers, GitHub URL interceptor, and web-fetch orchestration derive from this project. Its full license text is included in `RPIV-WEB-TOOLS-LICENSE`.

Modifications include monorepo integration, localization, unified `auto | llm | api` routing, shared Pi authentication, Vertex Express URL Context, stronger direct-fetch URL validation, and normalized result details.
