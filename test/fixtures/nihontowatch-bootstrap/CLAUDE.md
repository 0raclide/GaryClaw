# NihontoWatch

A marketplace for Japanese sword collectors, dealers, and enthusiasts.

## Architecture

The application uses a Next.js 15+ App Router architecture with Supabase for backend services.

Entry point is `src/app/layout.tsx`. API routes live in `src/app/api/`.

| Module | Path |
|--------|------|
| Health check | `src/app/api/health/route.ts` |
| Supabase client | `src/lib/supabase/client.ts` |
| UI components | `src/components/ui/` |

### Feature Test Coverage

| Feature | Coverage |
|---------|----------|
| Weekly Digest | 40 tests |
| Private Offers | 159 tests |
| Collector Onboarding | 93 tests |

## Tech Stack

- **Framework:** Next.js 15+ with App Router
- **Database:** PostgreSQL via Supabase
- **Styling:** Tailwind CSS
- **Language:** TypeScript
- **Auth:** Supabase Auth

## Test Strategy

All tests use Vitest. Tests live in `tests/` directory.

## Usage

```bash
npm run dev
npm run build
npm test
```
