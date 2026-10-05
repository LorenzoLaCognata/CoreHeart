# CoreHeart

A wall-mounted household display. One calm card at a time, rotating every 30 seconds, with a row of icons to jump to any section. It is built to be looked at, not typed into.

## Principles

- **A pull surface, not a push one.** The screen never asks for input. Everything on it is filled automatically from services, with the one exception of adding a calendar event by voice.
- **One card, one question.** What's coming up? What should we cook? Where do we eat? How is the money? Each card answers one of these.
- **Quiet AI.** Plain code does the math and fetching. Claude is used only where judgement or wording helps (currently: picking dinner places).
- **It can speak.** A button reads the current card aloud, and an optional daily 5 PM announcement reads the dinner suggestion and heads-ups, using the browser's built-in text-to-speech.
- **Honest about what is real.** Any card still showing sample data is clearly marked with an amber dashed border and a DRAFT ribbon.

## Cards

| Section | Card | What it shows | Source | Status |
|---|---|---|---|---|
| Today | Heads-up | What deserves attention across everything: check-ups to book, documents expiring, bills, food to use up, meal ideas | Database (`core_card`, built from `v_heads_up`) | Live once the database is connected |
| Today | Calendar | Month grid, upcoming events, add an event by voice | Google Calendar API | Live once connected |
| Today | Weather | Conditions, hourly and 4-day outlook, humidity, rain chance, UV, sunrise and sunset, air quality | Open-Meteo | Live |
| Today | 911 | Neighborhood 911 activity map and categories | City of Minneapolis Tableau dashboard (embedded) | Live |
| Food | Kitchen | Dinner plan for the next 5 days, meals not had in a while ("not had in 8 days"), what we ate and how long ago. Log or plan by voice or one tap | Database (`food_meal`, `food_meal_plan`), Wikipedia photos | Live once the database is connected |
| Food | Eat out | Two dinner ideas with hours, address and a dish to try, with a "New ideas" button | Claude with web search | Live |
| Food | Shopping | Shopping list with pictures | Sample data, Wikipedia photos | Draft |
| Money | Money | Spend by category and budget, upcoming bills | Sample data | Draft |

## How it works

```
Tablet browser (index.html)  ──►  Cloudflare Worker (worker.js)  ──►  Claude API (+ web search)
        │                                   └────────────────────►  Google Calendar API
        ├──► Open-Meteo (weather, air quality)
        ├──► Wikipedia (photos)
        └──► City of Minneapolis Tableau (911 embed)
```

The page is a single static file with no build step. The Worker keeps all secrets (Claude and Google credentials) off the tablet, and every request to it carries a shared secret header.

## Repository layout

- `index.html` — the whole display: layout, cards, sample data, rotation
- `worker.js` — the Cloudflare Worker: Claude dinner picks, Google Calendar read and quick-add, health check
- `schema.sql` — the Postgres (Supabase) database: food, money, home inventory, travel and health logistics
- `DATABASE.md` — how the database is organized and how to migrate older data into it

## Configuration

Worker secrets (names only; never commit values): `ANTHROPIC_API_KEY`, `HUB_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. Optional: `GOOGLE_CALENDAR_ID`, `ALLOWED_ORIGIN`.

The tablet stores the shared secret locally the first time it is opened with `?key=...` in the address.

## Database

One Postgres database with six domains (core, food, money, home, travel, health). A single feed of "things worth your attention" keeps the display to one rotating stream of cards no matter how much data sits behind it. See `DATABASE.md`.

## Roadmap

1. Kitchen: Claude suggests recipes from what needs eating and what was eaten recently.
2. Money: monthly bank CSV import with spend by category.
3. Restaurants "to try" list feeding the Eat out picks.
4. Real photos from a recipe source instead of Wikipedia matches.
