## MODIFIED Requirements

### Requirement: Upload rejects disallowed MIMEs and mismatched magic bytes

`POST /upload` SHALL accept only the following `Content-Type` values: `image/png`, `image/jpeg`, `image/gif`, `image/webp`. `image/svg+xml` is no longer accepted. The hub SHALL read the first bytes of the uploaded payload and reject the upload with HTTP `400` if the bytes do not match the declared MIME. Payloads larger than `IMAGE_MAX_BYTES` (8 MiB) SHALL be rejected with `413`. On success, the hub SHALL persist the bytes to disk at `<A2A_IMAGES_DIR>/<id>.<ext>` and respond `{ url: "/image/<id>.<ext>", id: "<id>" }`, where `<ext>` is derived from the validated MIME.

#### Scenario: SVG upload is rejected

- **WHEN** a client issues `POST /upload` with `Content-Type: image/svg+xml`
- **THEN** the hub responds `400` with body `{"error":"unsupported type: image/svg+xml"}`

#### Scenario: Mismatched magic bytes

- **WHEN** a client uploads a payload starting with `<script>alert(1)</script>` declared as `image/png`
- **THEN** the hub responds `400` with a body explaining the MIME mismatch
- **AND** nothing is written to disk

#### Scenario: Valid PNG is accepted

- **WHEN** a client uploads a payload starting with `\x89PNG\r\n\x1a\n...` declared as `image/png`
- **THEN** the hub responds `200` with `{ url: "/image/<id>.png", id: "<id>" }`
- **AND** the file `<A2A_IMAGES_DIR>/<id>.png` contains the uploaded bytes

### Requirement: `/send` rejects non-local image URLs

`POST /send` SHALL reject requests whose `image` field, if present, does not match the regex `/^\/image\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i`. Rejected requests SHALL return HTTP `400` with body `{ "error": "invalid image url" }`. The hub SHALL NOT accept absolute URLs, arbitrary paths, or `javascript:` / `data:` schemes in this field.

#### Scenario: Arbitrary URL rejected

- **WHEN** a client issues `POST /send` with `image: "http://evil.example.com/pixel.gif"`
- **THEN** the hub responds `400`
- **AND** no chat entry is created

#### Scenario: Valid local image URL accepted

- **WHEN** a client issues `POST /send` with `image: "/image/abc123_XYZ-def.png"`
- **THEN** the hub stores the chat entry with that image reference

#### Scenario: URL without extension rejected

- **WHEN** a client issues `POST /send` with `image: "/image/abc123"`
- **THEN** the hub responds `400 invalid image url`
