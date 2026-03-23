# Private Chat v1

Private Chat v1 is a Cloudflare-first private client messaging app.

This package includes:
- single Cloudflare Worker app
- static frontend assets bundled inside the Worker project
- D1 for users, sessions, conversations, messages, attachments metadata
- R2 for files and images up to 3 MB
- secure cookie auth
- direct 1-to-1 chat by email
- file/image sharing
- simple polling-based updates for reliability on v1

## What this package is
It is a practical MVP you can deploy on Cloudflare Free with D1 and R2.

## What this package is not
It is not a finished WhatsApp competitor, and it does not include:
- phone verification
- group chats
- voice/video calls
- end-to-end encryption
- notifications
- email delivery provider integration
- advanced moderation or abuse controls

## Deploy flow
Read `docs/deploy.md`.
