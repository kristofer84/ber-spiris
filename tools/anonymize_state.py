#!/usr/bin/env python3
"""Pseudonymiserar en export från avstämningsverktyget (avstamning-state.json).

Alla personnamn i filen (Namn och Fakturamottagare i underlaget, kundnamn i kundreskontran,
manuella kunder och rader, nycklar i mappning/perioder/födelseår) ersätts överallt — även i
fria texter som beskrivningar och kommentarer — med en saltad hash:

    Kristofer Nilsson  ->  P-3fa21c

Inget av originalnamnet (initialer, längd) finns kvar. Samma namn får alltid samma hash inom en
körning, så mappningar, perioder och avstämningen fungerar likadant på den anonymiserade filen.
Namn plockas även ur reskontrans beskrivningar ("Kundfaktura till 10001 <namn> 2993",
"Inbetalning från ..."), så samma person får samma hash även om stavningen skiljer sig från
kundnamnet. Enskilda namndelar i andra ordningar (t.ex. "NILSSON KRISTOFER") ersätts ord för ord
med en egen hash (w-xxxxxx), och i beskrivningar hashas alla ord som inte är siffror eller kända
ord (Kundfaktura, till, från, ...).
Personnummerliknande tal ersätts med <pnr>.

En nyckelfil (pseudonym -> riktigt namn) skrivs bredvid utfilen så att du kan översätta
tillbaka. DELA INTE nyckelfilen.

Användning:
    python3 tools/anonymize_state.py avstamning-state.json
    python3 tools/anonymize_state.py in.json -o ut.json --salt minhemlighet

Med samma --salt blir pseudonymerna desamma mellan körningar.
"""
import argparse
import hashlib
import json
import re
import secrets
import sys
from pathlib import Path

# ord som kan förekomma i namnfält men inte är personnamn och inte ska maskeras ord för ord
STOPWORDS = {
    'och', 'med', 'för', 'från', 'till', 'av', 'ab', 'hb', 'kb', 'the', 'kund', 'kunder',
    'kundfaktura', 'kreditfaktura', 'inbetalning', 'faktura', 'okänd', 'vårdnadshavare',
}
PNR_RE = re.compile(r'(?<!\d)(?:\d{2})?\d{6}[-+]\d{4}(?!\d)')
# reskontrans beskrivningar: "Kundfaktura till 10001 Förnamn Efternamn 2993",
# "Inbetalning från 10001 Förnamn Efternamn 2973" -> namnet i mitten
DESC_RE = re.compile(
    r'^\s*(?:(?:kund|kredit)faktura\s+till|inbetalning\s+fr[åa]n)\s+(?:\d+\s+)?(.+?)(?:\s+\d+)?\s*$',
    re.IGNORECASE)
# ord som får stå kvar i klartext i beskrivningar; allt annat (utom siffror) hashas
DESC_VOCAB = {
    'kundfaktura', 'kreditfaktura', 'inbetalning', 'till', 'från', 'fran', 'faktura', 'fakturanr',
    'betalning', 'kvittning', 'avgift', 'ränta', 'dröjsmålsränta', 'påminnelse', 'påminnelseavgift',
    'ocr', 'nr', 'bg', 'pg', 'bankgiro', 'plusgiro', 'swish', 'autogiro', 'återbetalning', 'utbetalning',
    'korrigering', 'kredit', 'debet', 'omföring', 'sek', 'kr', 'och', 'av', 'för', 'avser', 'ref',
    'pnr',  # platshållaren <pnr>
}


def collect_names(state):
    """Alla strängar i filen som är personnamn, utifrån var i strukturen de står."""
    names = set()

    def add(v):
        if isinstance(v, str) and v.strip():
            v = ' '.join(PNR_RE.sub(' ', v).split())
            if not v:
                return
            m = DESC_RE.match(v)  # namnfält som råkar innehålla en hel beskrivning -> bara namnet
            names.add(m.group(1).strip() if m else v)

    for f in state.get('underlagFiles') or []:
        for r in f.get('rows') or []:
            add(r.get('namn')); add(r.get('mottagare'))
    for r in state.get('underlag') or []:  # äldre exportformat
        add(r.get('namn')); add(r.get('mottagare'))
    for r in state.get('manual') or []:
        add(r.get('namn')); add(r.get('mottagare'))
    for f in state.get('reskontraFiles') or []:
        for r in f.get('rows') or []:
            add(r.get('kundNamn'))
            m = DESC_RE.match(r.get('beskrivning') or '')
            if m and not m.group(1).isdigit():
                add(m.group(1))  # namn som bara står i beskrivningen (t.ex. annan stavning än kundnamnet)
    for v in (state.get('manualIdentities') or {}).values():
        add(v)
    for key in ('mapping', 'exclusions', 'birthYears'):
        for k in (state.get(key) or {}).keys():
            add(k)
    return names


def build_replacer(names, salt):
    def norm(s):
        # ordningsoberoende: "SVENSSON PER" och "Per Svensson" är samma person
        return ' '.join(sorted(s.lower().split()))

    def h(s):
        return hashlib.sha256((salt + '\0' + s).encode('utf-8')).hexdigest()[:6]

    full = {}  # normaliserat namn -> pseudonym
    key = {}   # pseudonym -> originalnamn(en)
    for n in sorted(names):
        nn = norm(n)
        if nn in full:
            key.setdefault(full[nn], set()).add(n)
            continue
        pseudo = f'P-{h(nn)}'
        full[nn] = pseudo
        key.setdefault(pseudo, set()).add(n)

    # hela namn först, längsta först (så "Anna Karin X" ersätts före "Anna"), skiftlägesokänsligt
    full_patterns = []
    for n in sorted(names, key=len, reverse=True):
        parts = [re.escape(p) for p in n.split()]
        if not parts:
            continue
        pat = re.compile(r'(?<!\w)' + r'\s+'.join(parts) + r'(?!\w)', re.IGNORECASE)
        full_patterns.append((pat, full[norm(n)]))

    # sedan enskilda namndelar (fångar omvänd ordning, versaler, bara efternamn osv.)
    words = set()
    for n in names:
        for w in re.findall(r'\w+', n):
            if len(w) >= 3 and not w.isdigit() and w.lower() not in STOPWORDS:
                words.add(w.lower())
    word_pattern = None
    if words:
        alts = '|'.join(re.escape(w) for w in sorted(words, key=len, reverse=True))
        word_pattern = re.compile(r'(?<![\w-])(?:' + alts + r')(?!\w)', re.IGNORECASE)

    counts = {'full': 0, 'word': 0, 'pnr': 0, 'strict': 0}
    strict_words = set()

    def strict(s):
        """för beskrivningar: hasha varje ord som inte är en pseudonym, siffra eller känt ord"""
        def sub(m):
            w = m.group(0)
            if re.fullmatch(r'[Pw]-[0-9a-f]{6}', w) or w.lower() in DESC_VOCAB:
                return w
            counts['strict'] += 1
            strict_words.add(w)
            return 'w-' + h('word\0' + w.lower())
        return re.sub(r'[^\W\d_][\w-]*', sub, s)

    def replace(s):
        exact = full.get(norm(s))
        if exact is not None:
            counts['full'] += 1
            return exact
        for pat, pseudo in full_patterns:
            s, n = pat.subn(pseudo, s)
            counts['full'] += n
        if word_pattern is not None:
            pieces = re.split(r'(P-[0-9a-f]{6})', s)  # rör inte redan insatta pseudonymer
            for i in range(0, len(pieces), 2):
                pieces[i], n = word_pattern.subn(lambda m: 'w-' + h('word\0' + m.group(0).lower()), pieces[i])
                counts['word'] += n
            s = ''.join(pieces)
        s, n = PNR_RE.subn('<pnr>', s)
        counts['pnr'] += n
        return s

    def replace_key(k):
        """objektnycklar: bara nycklar som i sin helhet är ett namn (mapping, exclusions, birthYears)
        ersätts — fältnamn som 'beskrivning' får aldrig röras"""
        return full.get(norm(k), k) if isinstance(k, str) else k

    return replace, replace_key, strict, key, counts, strict_words


NAME_KEYED = {'mapping', 'exclusions', 'birthYears'}  # objekt vars nycklar är personnamn


def walk(obj, replace, replace_key, strict, field=None):
    if isinstance(obj, dict):
        rk = replace_key if field in NAME_KEYED else (lambda k: k)
        return {rk(k): walk(v, replace, replace_key, strict, k) for k, v in obj.items()}
    if isinstance(obj, list):
        return [walk(v, replace, replace_key, strict, field) for v in obj]
    if isinstance(obj, str):
        v = replace(obj)
        return strict(v) if field == 'beskrivning' else v
    return obj


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('infile', type=Path)
    ap.add_argument('-o', '--out', type=Path, help='utfil (default: <infil>.anon.json)')
    ap.add_argument('--salt', help='hemligt salt för stabila pseudonymer mellan körningar (default: slumpat)')
    args = ap.parse_args()

    state = json.loads(args.infile.read_text(encoding='utf-8'))
    out = args.out or args.infile.with_name(args.infile.stem + '.anon.json')
    keyfile = out.with_name(out.stem + '.KEY-DELA-INTE.json')
    salt = args.salt or secrets.token_hex(16)

    names = collect_names(state)
    replace, replace_key, strict, key, counts, strict_words = build_replacer(names, salt)
    anon = walk(state, replace, replace_key, strict)

    out.write_text(json.dumps(anon, ensure_ascii=False, indent=2), encoding='utf-8')
    keyfile.write_text(json.dumps({p: sorted(v) for p, v in sorted(key.items())}, ensure_ascii=False, indent=2),
                       encoding='utf-8')

    # kontroll: finns något originalnamn kvar i något värde (eller namnnyckel) i utfilen?
    # fältnamn som 'beskrivning' räknas inte
    texts = []
    def gather(o, field=None):
        if isinstance(o, dict):
            for k, v in o.items():
                if field in NAME_KEYED:
                    texts.append(k)
                gather(v, k)
        elif isinstance(o, list):
            for v in o:
                gather(v, field)
        elif isinstance(o, str):
            texts.append(o)
    gather(anon)
    text = '\n'.join(texts).lower()
    leftovers = sorted(n for n in names if n.lower() in text)

    print(f'{len(names)} namn hittade, {len(key)} pseudonymer.')
    print(f"Ersättningar: {counts['full']} hela namn, {counts['word']} namndelar, {counts['pnr']} personnummer,"
          f" {counts['strict']} övriga ord i beskrivningar.")
    if strict_words:
        sample = ', '.join(sorted(strict_words, key=str.lower)[:25])
        print(f'Okända ord som hashats i beskrivningar ({len(strict_words)} st, visas bara här lokalt): {sample}'
              + (' …' if len(strict_words) > 25 else ''))
    print(f'Anonymiserad fil: {out}')
    print(f'Nyckelfil (DELA INTE): {keyfile}')
    if leftovers:
        print('\nVARNING: dessa namn finns fortfarande kvar i utfilen:', file=sys.stderr)
        for n in leftovers[:50]:
            print('  ' + n, file=sys.stderr)
        sys.exit(1)
    print('\nInga originalnamn kvar. Beskrivningar är helt rensade (bara kända ord och siffror i klartext).')
    print('Kommentarer och filnamn rensas bara på kända namn — titta igenom dem om du skrivit namn där:')
    print(f"  grep -oE '\"(comment|note|name)\": \"[^\"]*\"' {out} | sort -u | less")


if __name__ == '__main__':
    main()
