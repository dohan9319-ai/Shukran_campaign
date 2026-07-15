# شكراً معالي الوزير — Campaign Website

Independent citizen-initiative site supporting Kuwait's Ministerial Decision 10/2026
(delivery-platform commission caps). Static HTML/CSS/JS front-end + Supabase back-end.

**Disclaimer (required everywhere):** مبادرة شعبية مستقلة — لا تمثل أي جهة حكومية.
No ministry logo or official photos are used.

## Structure

| File | Purpose |
|---|---|
| `index.html` | Single-page site: hero + counter, why, decision cards, logo wall, join form, petition section, footer |
| `petition.html` | Print-optimized A4 petition sheet (مضبطة تأييد) with print/PDF button |
| `css/style.css` | Site styles (RTL, palette per spec §6) |
| `js/config.js` | **Fill in Supabase URL + anon key here.** Empty = demo mode |
| `js/app.js` | Wall/counter loading, join-form validation + submission, share links |
| `supabase/schema.sql` | Table, RLS policies, trigger, `public_wall` view, storage policy |

## Demo mode

With `js/config.js` left empty the site runs standalone: the wall renders
`demoWallRows` placeholder tiles (set 0 / 1 / 50 to test layouts — spec M5)
and the form simulates a successful submission. No data leaves the browser.

## Going live

1. Create a Supabase project (free tier).
2. Run `supabase/schema.sql` in the SQL editor.
3. Create a **public** storage bucket named `logos`; in its settings restrict
   uploads to 2 MB and MIME types `image/png, image/jpeg, image/svg+xml`.
4. Put the project URL + anon key in `js/config.js`.
5. Deploy the folder to Vercel / Netlify / GitHub Pages (no build step).
6. Replace placeholder contact email in `index.html` footer and the
   `{رابط الموقع}` placeholder in `petition.html`.
7. Add Cloudflare Turnstile (or hCaptcha) to the form before public launch
   for rate-limiting (spec: anti-abuse).
8. Moderate submissions in the Supabase dashboard: set `status` to
   `approved` → the logo appears on the wall on next page load.

## Before publishing — verify facts

Spec §1 requires verifying against official sources: decision number (10/2026),
regulation (109/2026), minister's name, and the 17% / 10% / 1 KD / 3-year terms.

## QA checklist (spec §8)

- [ ] `dir="rtl"` everywhere; numbers render correctly
- [ ] Form rejects files > 2 MB and non-image types
- [ ] Pending submissions invisible to public (test in incognito)
- [ ] Petition prints on one A4 page (Chrome + Safari)
- [ ] Disclaimer visible on every page and on the printed sheet
- [ ] No ministry logo / official photos
- [ ] Counter matches approved rows exactly
- [ ] Lighthouse: performance > 90, accessibility > 90
