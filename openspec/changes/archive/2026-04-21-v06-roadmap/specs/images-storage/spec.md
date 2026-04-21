## ADDED Requirements

### Requirement: The attachments folder accepts uploads from both human and agent sources

The on-disk storage layer at `<attachments_dir>/<id>.<ext>` (formerly documented as "images folder") SHALL accept writes originating from the webview's human-driven uploads AND from agent-driven uploads via the channel sidecar's `post_file` tool. The storage shape, permissions (`0600`), and retrieval URL format (`/image/<id>.<ext>`) SHALL be identical regardless of upload origin.

The hub SHALL NOT distinguish between human and agent uploads at the storage layer — the bearer-token auth is the only gate, and both sources present the same token.

#### Scenario: Human and agent uploads coexist

- **GIVEN** a configured `attachments_dir`
- **WHEN** the human uploads `photo.png` via the webview
- **AND** agent `alice` uploads `diff.md` via `post_file`
- **THEN** both files land at `<attachments_dir>/<id>.<ext>` with mode `0600`
- **AND** both are retrievable at `/image/<id>.<ext>` subject to the same read-auth rules

### Requirement: The term "images folder" is retired from user-facing documentation

Documentation (README, config.json seed, CLAUDE.md) SHALL refer to this folder as "attachments folder" or "attachments directory" to reflect that it holds PDFs, Markdown, and other allowlisted file types in addition to images. The HTTP route prefix `/image/` remains for back-compat but is no longer mentioned in user-facing prose as "image route" — it is described as the attachment-serving route.

This is a documentation-level concern; no code-behavior change is implied.

#### Scenario: Documentation uses consistent "attachments" terminology

- **WHEN** a user reads the v0.6 README
- **THEN** all references to the storage folder use "attachments" not "images"
- **AND** the config key is documented as `attachments_dir` (with a legacy-support note for `images_dir`)
