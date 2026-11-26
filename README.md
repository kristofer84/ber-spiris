# Avstämning — fakturor & betalningar

Ett fristående webbverktyg för att stämma av underlag (avgifter) mot en kundreskontralista med fakturor och betalningar. Allt körs lokalt i webbläsaren — ingen data skickas till någon server.

Live: https://kristofer84.github.io/ber-spiris/

## Funktioner

- Läs in en eller flera underlags-CSV:er (Beräkningsmånad, Namn, Fakturamottagare, Avgift)
- Läs in en eller flera kundreskontra-CSV:er (fakturor, kreditfakturor, inbetalningar, kvittningar)
- Mappa namn i underlaget mot kunder i kundreskontralistan, inklusive delning på flera kunder med procentfördelning
- Markera perioder där en person inte ska faktureras
- Automatisk åldersfärgkodning baserat på personnummer i underlaget
- Avstämning per kund och månad: underlag vs. fakturerat, samt betalningsstatus per faktura
- Transaktionslogg per kund med löpande saldo; varnar när slutsaldot inte stämmer med utestående (ej kopplade inbetalningar)
- Exportera/importera hela arbetstillståndet som JSON för att spara mellan sessioner

## Struktur

- `index.html` — sidmarkup
- `css/style.css` — styling
- `js/app.js` — all logik (CSV-parsning, mappning, avstämning, rendering)

## Utveckling

Statisk sida utan byggsteg. Öppna `index.html` direkt i en webbläsare, eller kör en lokal server:

```sh
python3 -m http.server 8000
```

och besök `http://localhost:8000/`.

## Publicering

Sidan publiceras automatiskt till GitHub Pages via GitHub Actions vid push till `main` (se `.github/workflows/pages.yml`).

## Licens

MIT, se [LICENSE](LICENSE).
